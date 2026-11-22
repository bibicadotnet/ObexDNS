/**
 * @file websiteIcon.ts
 * @description Server side favicon lookup for the Query Logs page.
 *
 * Several public icon providers are tried in order and the first usable image wins, so one provider being
 * down, rate limited or unaware of a site no longer means "no icon". Every upstream answer is checked
 * (image type, size, not the provider's generic placeholder) before it is passed on, and the response is
 * rebuilt from scratch instead of copying upstream headers.
 *
 * Upstream calls are the expensive part (a DNS log is full of trackers, PTR names and random probe labels),
 * so names that can never have a favicon are rejected without any request, and a lookup costs at most
 * `host + registrable domain` x `providers` requests.
 */
import { iconCandidates } from './iconCandidates';

const UPSTREAM_TIMEOUT_MS = 2500;
/** A whole lookup (all providers, both hosts) gives up after this long. */
const TOTAL_BUDGET_MS = 7000;
export const MAX_ICON_BYTES = 256 * 1024;
export const ICON_TTL_SEC = 30 * 24 * 60 * 60;
export const ICON_MISS_TTL_SEC = 6 * 60 * 60;

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

const BITWARDEN_DEFAULT_GLOBE = {
  byteLength: 500,
  sha256: 'aaa64871332ad5b7d28fe8874efb19c2d9cc2f1e6de75d52b080b438225a0783',
};

interface IconSource {
  url: (host: string) => string;
  /** Generic "no icon" image the provider returns with status 200. */
  rejectImage?: { byteLength: number; sha256: string };
}

const SOURCES: IconSource[] = [
  { url: (h) => `https://favicon.im/zh/${h}?larger=true&throw-error-on-404=true` },
  { url: (h) => `https://icons.duckduckgo.com/ip3/${h}.ico` },
  { url: (h) => `https://icons.bitwarden.net/${h}/icon.png`, rejectImage: BITWARDEN_DEFAULT_GLOBE },
];

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

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
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

async function fetchFromSource(source: IconSource, host: string): Promise<WebsiteIcon | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetch(source.url(encodeURIComponent(host)), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ObexDNS-icon/1.0)', Accept: 'image/*' },
      redirect: 'follow',
      signal: controller.signal,
      // Cloudflare edge cache for the upstream answer (ignored outside Workers).
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': ICON_TTL_SEC, '404': ICON_MISS_TTL_SEC, '500-599': 0 } },
    } as RequestInit);
    if (!resp.ok) {
      void resp.body?.cancel().catch(() => undefined);
      return null;
    }
    const type = mediaType(resp.headers.get('Content-Type'));
    if (!SAFE_ICON_TYPES.has(type)) {
      void resp.body?.cancel().catch(() => undefined);
      return null;
    }
    const declared = Number(resp.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > MAX_ICON_BYTES) {
      void resp.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = await readBounded(resp, MAX_ICON_BYTES, controller.signal);
    if (!body) return null;
    const reject = source.rejectImage;
    if (reject && body.byteLength === reject.byteLength && (await sha256Hex(body)) === reject.sha256) return null;
    return { body, contentType: type };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Looks the icon up; null when no provider has a real one. */
export async function fetchWebsiteIcon(host: string): Promise<WebsiteIcon | null> {
  if (isIconlessHost(host)) return null;
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  for (const candidate of iconLookupHosts(host)) {
    for (const source of SOURCES) {
      if (Date.now() >= deadline) return null;
      const icon = await fetchFromSource(source, candidate);
      if (icon) return icon;
    }
  }
  return null;
}

const SAFE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; sandbox",
};

export function iconHitResponse(icon: WebsiteIcon): Response {
  return new Response(icon.body, {
    status: 200,
    headers: {
      ...SAFE_HEADERS,
      'Content-Type': icon.contentType,
      'Cache-Control': `public, max-age=${ICON_TTL_SEC}, immutable`,
    },
  });
}

/** A miss is cached briefly: long enough to spare the providers, short enough for an icon added later. */
export function iconMissResponse(): Response {
  return new Response('Icon not found', {
    status: 404,
    headers: { ...SAFE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': `public, max-age=${ICON_MISS_TTL_SEC}` },
  });
}
