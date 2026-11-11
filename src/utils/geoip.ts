import { cacheUtils } from "./cache";
import { isPublicInternetIP } from "./validator";

export interface GeoIP {
  country: string;
  country_code: string;
  city?: string;
  isp?: string;
  org?: string;
  region?: string;
  as?: string;
  timezone?: string;
}

// In-memory cache (expires after 14 days).
const memoryCache = new Map<string, { data: GeoIP; expiresAt: number }>();
const MEMORY_CACHE_TTL = 14 * 24 * 60 * 60 * 1000; // 14 days
const MEMORY_CACHE_MAX = 100000;

// Negative cache: remember total lookup failures briefly so a rate-limited / down provider
// is not hammered by every query that touches the same IP.
const negativeCache = new Map<string, number>();
const NEGATIVE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const NEGATIVE_CACHE_MAX = 5000;

// In-flight de-duplication: concurrent lookups of the same IP share one network round-trip.
const inflight = new Map<string, Promise<GeoIP | null>>();

/** Per-provider network timeout so a hung provider can never stall background work. */
const PROVIDER_TIMEOUT_MS = 3000;

/**
 * Normalizes an IP for lookup/caching: strips IPv6 brackets and unwraps IPv4-mapped IPv6
 * (::ffff:1.2.3.4) so equivalent addresses share one cache entry and URLs stay valid.
 */
function normalizeIp(ip: string): string {
  let clean = ip.trim();
  if (clean.startsWith("[") && clean.endsWith("]")) {
    clean = clean.slice(1, -1);
  }
  const mapped = clean.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) clean = mapped[1];
  return clean.toLowerCase();
}

function setBounded<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/**
 * Looks up GeoIP data for a public IP. Never throws; returns null if unavailable.
 * Lookup order: memory cache -> Cache API -> ip-api.com -> ipwho.is.
 */
export async function fetchGeoIP(rawIp: string): Promise<GeoIP | null> {
  if (!isPublicInternetIP(rawIp)) {
    return null;
  }

  const ip = normalizeIp(rawIp);
  const cacheKey = `geoip:${ip}`;

  const memCached = memoryCache.get(cacheKey);
  if (memCached) {
    if (Date.now() < memCached.expiresAt) {
      return memCached.data;
    }
    memoryCache.delete(cacheKey); // Expired
  }

  const negUntil = negativeCache.get(cacheKey);
  if (negUntil !== undefined) {
    if (Date.now() < negUntil) return null;
    negativeCache.delete(cacheKey);
  }

  const pending = inflight.get(cacheKey);
  if (pending) return pending;

  const promise = lookupGeoIP(ip, cacheKey).finally(() => {
    inflight.delete(cacheKey);
  });
  inflight.set(cacheKey, promise);
  return promise;
}

async function lookupGeoIP(ip: string, cacheKey: string): Promise<GeoIP | null> {
  // Cloudflare Cache API (if available and enabled on custom domains)
  let cache: any = null;
  if (typeof caches !== "undefined" && (caches as any).default) {
    cache = (caches as any).default;
  }

  if (cache) {
    try {
      const cached = await cacheUtils.get<GeoIP>(cache, cacheKey);
      if (cached) {
        setBounded(memoryCache, cacheKey, { data: cached, expiresAt: Date.now() + MEMORY_CACHE_TTL }, MEMORY_CACHE_MAX);
        return cached;
      }
    } catch (err) {
      console.warn("Cloudflare Cache API read error, falling back to network:", err);
    }
  }

  const storeInCache = async (geo: GeoIP) => {
    // Expiry is measured from when the lookup finished, not from when it started.
    setBounded(memoryCache, cacheKey, { data: geo, expiresAt: Date.now() + MEMORY_CACHE_TTL }, MEMORY_CACHE_MAX);
    if (cache) {
      try {
        await cacheUtils.set(cache, cacheKey, geo, 86400 * 14);
      } catch (err) {
        console.warn("Cloudflare Cache API write error:", err);
      }
    }
  };

  // 1. Primary provider: ip-api.com
  try {
    const response = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName,city,isp,org,as,timezone`,
      {
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        cf: {
          cacheTtlByStatus: {
            "200-299": 86400 * 14, // 14 days
            "400-499": 5,
            "500-599": 0,
          },
          cacheEverything: true,
        },
      }
    );
    if (response.ok) {
      const data = (await response.json()) as any;
      if (data.status === "success" && data.countryCode) {
        const geo: GeoIP = {
          country: data.country,
          country_code: data.countryCode,
          region: data.regionName,
          city: data.city,
          isp: data.isp,
          org: data.org,
          as: data.as,
          timezone: data.timezone,
        };
        await storeInCache(geo);
        return geo;
      }
    }
  } catch {
    // Fall through to fallback provider
  }

  // 2. Secondary fallback provider: ipwho.is (HTTPS, no auth required)
  try {
    const response2 = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (response2.ok) {
      const data2 = (await response2.json()) as any;
      if (data2.success && data2.country_code) {
        const geo: GeoIP = {
          country: data2.country,
          country_code: data2.country_code,
          region: data2.region,
          city: data2.city,
          isp: data2.connection?.isp,
          org: data2.connection?.org,
          as: data2.connection?.asn
            ? `AS${data2.connection.asn} ${data2.connection?.org || ""}`.trim()
            : undefined,
          timezone: data2.timezone?.id,
        };
        await storeInCache(geo);
        return geo;
      }
    }
  } catch (e2) {
    console.error("GeoIP Fetch Error:", e2);
  }

  setBounded(negativeCache, cacheKey, Date.now() + NEGATIVE_CACHE_TTL, NEGATIVE_CACHE_MAX);
  return null;
}

/**
 * Resolves the 2-letter country code (or 'LAN' for local/private network clients)
 * for a DNS client IP. Prefers Cloudflare edge headers if valid; falls back to
 * cached GeoIP resolution for public IPs, or 'LAN' for private/reserved IPs.
 *
 * @param request - Inbound HTTP Request.
 * @param clientIp - Client IP address.
 * @returns 2-letter uppercase ISO country code, 'LAN', or 'UNKNOWN'.
 */
export async function resolveClientGeoCountry(
  request: Request,
  clientIp: string
): Promise<string> {
  const edgeCountry =
    (request as unknown as { cf?: { country?: string } }).cf?.country ||
    request.headers.get("CF-IPCountry");

  if (
    edgeCountry &&
    edgeCountry !== "UN" &&
    edgeCountry !== "UNKNOWN" &&
    edgeCountry !== "XX"
  ) {
    return edgeCountry.toUpperCase();
  }

  if (!isPublicInternetIP(clientIp)) {
    return "LAN";
  }

  try {
    const geo = await fetchGeoIP(clientIp);
    if (geo?.country_code) {
      return geo.country_code.toUpperCase();
    }
  } catch {
    // Gracefully ignore geo resolution errors
  }

  return "UNKNOWN";
}
