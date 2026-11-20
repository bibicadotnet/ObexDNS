/**
 * @file lazyRefresh.ts
 * @description Lazy cache ("serve stale, refresh in the background").
 *
 * An expired DNS answer is not thrown away: for `DNS_STALE_WINDOW_SEC` it is still returned immediately
 * (with a short TTL), and one background query fetches the fresh answer and overwrites the same cache entry.
 * Popular domains therefore never wait for the upstream; entries nobody asks for again leave the cache when the
 * window ends (periodic sweep) or when the LRU limit pushes them out.
 */
import type { Env, ExecutionContext } from "../types";
import { envNumber } from "../utils/envNumber";

export const DEFAULT_STALE_WINDOW_SEC = 3600;
export const DEFAULT_STALE_ANSWER_TTL_SEC = 30;
/** Safety valve for a burst of different stale domains (e.g. right after the server was idle): not configurable. */
export const MAX_CONCURRENT_REFRESHES = 64;

/** How long an expired answer may still be served, in ms (0 = lazy cache off). */
export function staleWindowMs(env: Partial<Env> | undefined): number {
  return envNumber(env?.DNS_STALE_WINDOW_SEC, DEFAULT_STALE_WINDOW_SEC) * 1000;
}

/** TTL (seconds) clients get for an answer served after it expired. */
export function staleAnswerTtl(env: Partial<Env> | undefined): number {
  return envNumber(env?.DNS_STALE_ANSWER_TTL_SEC, DEFAULT_STALE_ANSWER_TTL_SEC, { min: 1, max: 300 });
}

const inflight = new Map<string, Promise<void>>();

export function inflightRefreshCount(): number {
  return inflight.size;
}

/**
 * Starts a background refresh for a stale cache key, unless one is already running (single flight),
 * the entry was tried very recently (retry back-off, so a dead upstream is not hammered), or too many
 * refreshes are already running (the stale answer is still served).
 *
 * @returns true when a refresh was started.
 */
export function scheduleStaleRefresh(
  key: string,
  entry: { nextRefreshAt?: number },
  run: () => Promise<void>,
  env: Partial<Env> | undefined,
  ctx: ExecutionContext | undefined,
  now: number = Date.now()
): boolean {
  if (inflight.has(key)) return false;
  if (typeof entry.nextRefreshAt === "number" && now < entry.nextRefreshAt) return false;
  if (inflight.size >= MAX_CONCURRENT_REFRESHES) return false;

  // A successful refresh replaces the entry; this back-off only matters when it fails.
  entry.nextRefreshAt = now + staleAnswerTtl(env) * 1000;

  const task = Promise.resolve()
    .then(run)
    .catch(() => undefined)
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);
  return true;
}
