/**
 * @file websiteIcon.ts
 * @description Server side favicon lookup for the Query Logs page.
 *
 * Icons come from a single provider, Google's favicon service (gstatic.com/faviconV2, the target of
 * https://www.google.com/s2/favicons). Its answer is final: there is
 * no second service. When it has no favicon for the host (or does not answer in time), the registrable domain is
 * asked next (edge.microsoft.com -> microsoft.com), so a service is still recognisable. That is at most
 * two requests per domain, and one for the common case.
 *
 * Google reports "no favicon" with a 404 (the body is a generic globe image, which is never served).
 *
 * Requests are queued and sent a few at a time with a short pause (all configurable), and identical requests that
 * are waiting or running are shared. Every upstream answer is checked (image type, size) before it is passed on,
 * and the response is rebuilt from scratch instead of copying upstream headers.
 *
 * Tunables (all optional, see .env.serverfull):
 *   ICON_CACHE_TTL_SEC       how long a hit or a "no favicon" answer is cached      (default 86400)
 *   ICON_FETCH_CONCURRENCY   upstream requests in flight at once                    (default 4)
 *   ICON_FETCH_DELAY_MS      pause after each upstream request                      (default 10)
 *   ICON_FETCH_TIMEOUT_MS    timeout of one upstream request (queue wait excluded)  (default 100)
 */
import type { Env } from '../types';
import { envNumber } from './envNumber';
import { iconCandidates } from './iconCandidates';

export const MAX_ICON_BYTES = 256 * 1024;
export const DEFAULT_ICON_CACHE_TTL_SEC = 24 * 60 * 60;
export const DEFAULT_ICON_FETCH_CONCURRENCY = 4;
export const DEFAULT_ICON_FETCH_DELAY_MS = 10;
export const DEFAULT_ICON_FETCH_TIMEOUT_MS = 100;

export interface IconConfig {
  cacheTtlSec: number;
  concurrency: number;
  delayMs: number;
  timeoutMs: number;
}

function rawSetting(env: Env | null | undefined, key: string): unknown {
  const fromEnv = env ? (env as unknown as Record<string, unknown>)[key] : undefined;
  if (fromEnv !== undefined && fromEnv !== null && fromEnv !== '') return fromEnv;
  return typeof process !== 'undefined' ? process.env?.[key] : undefined;
}

/** Reads the ICON_* settings, falling back to the defaults for anything unset or invalid. */
export function getIconConfig(env?: Env | null): IconConfig {
  return {
    cacheTtlSec: Math.floor(envNumber(rawSetting(env, 'ICON_CACHE_TTL_SEC'), DEFAULT_ICON_CACHE_TTL_SEC, { min: 1 })),
    concurrency: Math.floor(envNumber(rawSetting(env, 'ICON_FETCH_CONCURRENCY'), DEFAULT_ICON_FETCH_CONCURRENCY, { min: 1 })),
    delayMs: Math.floor(envNumber(rawSetting(env, 'ICON_FETCH_DELAY_MS'), DEFAULT_ICON_FETCH_DELAY_MS, { min: 0 })),
    timeoutMs: Math.floor(envNumber(rawSetting(env, 'ICON_FETCH_TIMEOUT_MS'), DEFAULT_ICON_FETCH_TIMEOUT_MS, { min: 10 })),
  };
}

const SAFE_ICON_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon',
]);

/** Suffixes that are never public sites; asking an icon provider about them is wasted traffic. */
const NO_ICON_SUFFIXES = [
  'arpa', 'local', 'localhost', 'localdomain', 'lan', 'home', 'internal', 'intranet', 'corp',
  'invalid', 'test', 'onion', 'example',
];

/**
 * Google's favicon endpoint behind https://www.google.com/s2/favicons: that URL only answers with a redirect to this one,
 * so asking it directly saves one round trip per lookup. A fixed t1 shard keeps one connection warm instead of
 * spreading requests over t0..t3. `host` is already validated (letters, digits, '-', '_', '.'), so it needs no escaping.
 * Not a documented API: if Google ever changes it, this is the one line to point back at
 * `https://www.google.com/s2/favicons?domain=${host}`.
 */
const iconUrl = (host: string): string =>
  `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${host}&size=16`;

const LABEL = '[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?';
const DOMAIN_RE = new RegExp(`^(${LABEL}\\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$`);

/**
 * Turns the path segment after /api/icon/ into a lookup hostname, or null when it is not a hostname
 * that can have a favicon.
 */
export function normalizeIconDomain(raw: string): string | null {
  let host: string;
  try {
    host = decodeURIComponent(raw);
  } catch {
    return null;
  }
  host = host.trim().toLowerCase().replace(/\.ico$/, '').replace(/^\*\./, '').replace(/\.+$/, '');
  if (host.length === 0 || host.length > 253 || !DOMAIN_RE.test(host)) return null;
  return host;
}

/** True for names no public favicon exists for (reverse DNS, local/internal suffixes). */
export function isIconlessHost(host: string): boolean {
  const tld = host.slice(host.lastIndexOf('.') + 1);
  return NO_ICON_SUFFIXES.includes(tld);
}

/** Exact host first, then its registrable domain (edge.microsoft.com -> microsoft.com). Two requests at most. */
export function iconLookupHosts(host: string): string[] {
  const chain = iconCandidates(host);
  const last = chain[chain.length - 1];
  return last && last !== host ? [host, last] : [host];
}

function mediaType(contentType: string | null): string {
  return String(contentType || '').split(';', 1)[0].trim().toLowerCase();
}

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<ArrayBuffer | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', abort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        abort();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    signal.removeEventListener('abort', abort);
  }
  if (signal.aborted || total === 0) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export interface WebsiteIcon {
  body: ArrayBuffer;
  contentType: string;
}

/**
 * hit   - Google returned a usable image.
 * miss  - Google has no favicon (404), or answered with something that cannot be served as an icon.
 * error - no answer (timeout, network failure, 429, 5xx). Says nothing about the site, so it is never cached.
 */
export type IconLookup = { kind: 'hit'; icon: WebsiteIcon } | { kind: 'miss' } | { kind: 'error' };

async function fetchFromGoogle(host: string, timeoutMs: number): Promise<IconLookup> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const dropBody = (resp: Response) => void resp.body?.cancel().catch(() => undefined);
  try {
    const resp = await fetch(iconUrl(host), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ObexDNS-icon/1.0)', Accept: 'image/*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (resp.status === 404) {
      dropBody(resp);
      return { kind: 'miss' };
    }
    if (!resp.ok) {
      dropBody(resp);
      return { kind: 'error' };
    }
    const type = mediaType(resp.headers.get('Content-Type'));
    if (!SAFE_ICON_TYPES.has(type)) {
      dropBody(resp);
      return { kind: 'miss' };
    }
    const declared = Number(resp.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > MAX_ICON_BYTES) {
      dropBody(resp);
      return { kind: 'miss' };
    }
    const body = await readBounded(resp, MAX_ICON_BYTES, controller.signal);
    if (!body) return controller.signal.aborted ? { kind: 'error' } : { kind: 'miss' };
    return { kind: 'hit', icon: { body, contentType: type } };
  } catch {
    return { kind: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

const queue: Array<() => void> = [];
const inFlight = new Map<string, Promise<IconLookup>>();
let running = 0;
let limits = { concurrency: DEFAULT_ICON_FETCH_CONCURRENCY, delayMs: DEFAULT_ICON_FETCH_DELAY_MS };

function pump(): void {
  while (running < limits.concurrency) {
    const next = queue.shift();
    if (!next) return;
    running++;
    next();
  }
}

/** One request to Google for one hostname, through the queue and shared with an identical request already waiting or running. */
function fetchQueued(host: string, config: IconConfig): Promise<IconLookup> {
  const existing = inFlight.get(host);
  if (existing) return existing;

  const promise = new Promise<IconLookup>((resolve) => {
    queue.push(() => {
      fetchFromGoogle(host, config.timeoutMs)
        .catch((): IconLookup => ({ kind: 'error' }))
        .then(resolve)
        .finally(() => {
          inFlight.delete(host);
          setTimeout(() => {
            running--;
            pump();
          }, limits.delayMs);
        });
    });
  });
  inFlight.set(host, promise);
  pump();
  return promise;
}

/**
 * Looks up the favicon of `host`: the host itself, then its registrable domain when Google has no favicon for
 * the host or does not answer in time. Returns the first hit.
 *
 * With no hit, the result is a miss only when every request got a definite "no favicon". If any request got no
 * answer, the result is an error, so an uncertain outcome is never cached as "this site has no icon".
 *
 * The timeout of a request only starts once it leaves the queue, so waiting for a turn never counts as a slow answer.
 */
export async function lookupWebsiteIcon(host: string, config: IconConfig): Promise<IconLookup> {
  if (isIconlessHost(host)) return { kind: 'miss' };
  limits = { concurrency: config.concurrency, delayMs: config.delayMs };

  let unanswered = false;
  for (const candidate of iconLookupHosts(host)) {
    const result = await fetchQueued(candidate, config);
    if (result.kind === 'hit') return result;
    if (result.kind === 'error') unanswered = true;
  }
  return { kind: unanswered ? 'error' : 'miss' };
}

const SAFE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; sandbox",
};

export function iconHitResponse(icon: WebsiteIcon, ttlSec: number): Response {
  return new Response(icon.body, {
    status: 200,
    headers: {
      ...SAFE_HEADERS,
      'Content-Type': icon.contentType,
      'Cache-Control': `public, max-age=${ttlSec}`,
    },
  });
}

/** "No favicon" is Google's final answer, so it is cached for as long as a hit. */
export function iconMissResponse(ttlSec: number): Response {
  return new Response('Icon not found', {
    status: 404,
    headers: { ...SAFE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': `public, max-age=${ttlSec}` },
  });
}

/** No answer from Google: reported as a failure and never cached, so the next request tries again. */
export function iconErrorResponse(): Response {
  return new Response('Icon lookup unavailable', {
    status: 502,
    headers: { ...SAFE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
