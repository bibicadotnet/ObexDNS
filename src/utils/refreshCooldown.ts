/**
 * @file refreshCooldown.ts
 * @description Minimum pause between two manual "Refresh" clicks on the Query Logs and Analytics tabs.
 *
 * A refresh forces a fresh read (analytics aggregation / log query) that bypasses every cache, so a user (or a
 * script) hammering the button would keep the CPU busy. The pause is set by REFRESH_COOLDOWN_SEC and applies per
 * user + profile + tab. Only requests that carry `fresh=true` (what the Refresh button sends) are counted; the
 * normal loading, scrolling, searching and filtering of the dashboard are never delayed.
 *
 * The state lives in process memory and is checked-and-set synchronously, so a burst of parallel requests cannot
 * slip several refreshes through the same pause. On Cloudflare Workers the pause is therefore kept per isolate.
 */

import type { Env } from "../types";
import { envNumber } from "./envNumber";

/** Default pause between two manual refreshes, in seconds. */
export const DEFAULT_REFRESH_COOLDOWN_SEC = 3;
/** Upper bound accepted for REFRESH_COOLDOWN_SEC (one hour). */
const MAX_REFRESH_COOLDOWN_SEC = 3600;
/** Above this many tracked entries, expired ones are dropped on the next check. */
const PRUNE_THRESHOLD = 1000;

export type RefreshScope = "logs" | "analytics";

/** Moment (ms) until which each user/profile/tab is refused another refresh. */
const blockedUntil = new Map<string, number>();

/**
 * Pause between two manual refreshes, in seconds. 0 turns the limit off.
 * Reads REFRESH_COOLDOWN_SEC; a missing, empty or invalid value gives the default.
 */
export function getRefreshCooldownSec(env: Env): number {
  return envNumber(env.REFRESH_COOLDOWN_SEC, DEFAULT_REFRESH_COOLDOWN_SEC, {
    min: 0,
    max: MAX_REFRESH_COOLDOWN_SEC
  });
}

/**
 * Registers a manual refresh, or refuses it while the pause of the previous one is still running.
 *
 * @returns 0 when the refresh may run (and the pause starts now), otherwise the whole seconds left to wait.
 */
export function checkRefreshCooldown(
  env: Env,
  scope: RefreshScope,
  userId: string,
  profileId: string,
  now: number = Date.now()
): number {
  const cooldownSec = getRefreshCooldownSec(env);
  if (cooldownSec <= 0) return 0;

  const key = `${scope}:${userId}:${profileId}`;
  const until = blockedUntil.get(key);
  if (until !== undefined && until > now) {
    return Math.max(1, Math.ceil((until - now) / 1000));
  }

  if (blockedUntil.size >= PRUNE_THRESHOLD) {
    for (const [k, v] of blockedUntil) {
      if (v <= now) blockedUntil.delete(k);
    }
  }
  blockedUntil.set(key, now + cooldownSec * 1000);
  return 0;
}

/** 429 answer sent while a refresh is still inside its pause. */
export function refreshCooldownResponse(retryAfterSec: number): Response {
  return new Response(JSON.stringify({ error: "refresh_cooldown", retry_after: retryAfterSec }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSec) }
  });
}

/** Clears all pauses (tests only). */
export function resetRefreshCooldowns(): void {
  blockedUntil.clear();
}
