/**
 * sw-icon-cache.ts - Icon Caching Business Logic (TypeScript)
 *
 * This file contains the single responsibility of managing the cache,
 * fetch logic, and prefetching for DuckDuckGo favicon icons, including
 * fallback to an SVG placeholder on 404 errors or network failures.
 */

export const CACHE_NAME = "dns-worker-icons-v2";
export const DUCKDUCKGO_ICON_PREFIX = "/api/icon/";

/**
 * Number of days after which a cached icon entry is considered expired and
 * will be purged by cleanExpiredCache(). Entries older than this are deleted;
 * entries between half this value and this value are served stale while a
 * background revalidation is queued (stale-while-revalidate).
 *
 * Reducing this value directly reduces the maximum Cache Storage footprint.
 */
export const ICON_ENTRIES_CACHE_DAYS = 30;

export const ONE_DAY = 24 * 60 * 60 * 1000;
/** Fresh threshold: icons younger than this are served directly without revalidation. */
export const ICON_FRESH_THRESHOLD = Math.floor(ICON_ENTRIES_CACHE_DAYS / 2) * ONE_DAY;
/** Expiry threshold: icons older than this are removed by the cleanup sweep. */
export const ICON_EXPIRY_THRESHOLD = ICON_ENTRIES_CACHE_DAYS * ONE_DAY;
/** Negative cache threshold for missing icons (404/placeholder): 2 hours. */
export const ICON_MISS_FRESH_THRESHOLD = 2 * 60 * 60 * 1000;

// An elegant, lightweight SVG placeholder showing a generic globe icon
export const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`;

/**
 * Returns a new Response object containing the SVG placeholder.
 */
export function getPlaceholderResponse(): Response {
  return new Response(PLACEHOLDER_SVG, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=7200",
      "X-Icon-Miss": "1"
    }
  });
}

/**
 * Fetches the icon URL using CORS by default to catch 404 status codes.
 * Falls back to no-cors if CORS request fails (e.g., due to CORS policy block).
 */
export async function fetchIcon(url: string): Promise<Response> {
  try {
    const response = await fetch(url, { mode: "cors" });
    return response;
  } catch (err) {
    // Fallback to no-cors (returns opaque response with status: 0)
    return fetch(url, { mode: "no-cors" });
  }
}

/**
 * Checks if a given request URL matches the DuckDuckGo icon prefix.
 */
export function isIconRequest(url: string): boolean {
  // event.request.url is absolute ("https://host/api/icon/..."), so compare the path, not the whole URL.
  try {
    return new URL(url, self.location.origin).pathname.startsWith(DUCKDUCKGO_ICON_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Helper to write a request-response pair along with a timestamp to the cache.
 */
export async function putInCache(cache: Cache, request: Request | string, response: Response): Promise<void> {
  const url = typeof request === "string" ? request : request.url;
  const timestampRequest = new Request(url + "?sw-cached-at");
  const timestampResponse = new Response(Date.now().toString());

  await cache.put(request, response);
  await cache.put(timestampRequest, timestampResponse);
}

/**
 * Helper to get the age of a cached request in milliseconds.
 */
export async function getCacheAge(cache: Cache, request: Request): Promise<number> {
  try {
    const timestampRequest = new Request(request.url + "?sw-cached-at");
    const timestampResponse = await cache.match(timestampRequest);
    if (!timestampResponse) return Infinity;

    const cachedTimeText = await timestampResponse.text();
    const cachedTime = parseInt(cachedTimeText, 10);
    if (isNaN(cachedTime)) return Infinity;

    return Date.now() - cachedTime;
  } catch (err) {
    return Infinity;
  }
}

/**
 * Handles fetching of icon requests with Timed Stale-While-Revalidate policy.
 */
export async function handleIconFetch(event: FetchEvent): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cachedResponse = await cache.match(event.request);

  if (cachedResponse) {
    const age = await getCacheAge(cache, event.request);
    const isMiss = cachedResponse.headers.get("X-Icon-Miss") === "1";
    const freshThreshold = isMiss ? ICON_MISS_FRESH_THRESHOLD : ICON_FRESH_THRESHOLD;

    // Fresh cache: return immediately, no network request.
    if (age < freshThreshold) {
      return cachedResponse;
    }

    // Stale cache (between fresh threshold and expiry): serve immediately,
    // trigger a background revalidation.
    if (age < ICON_EXPIRY_THRESHOLD) {
      fetchIcon(event.request.url)
        .then((networkResponse) => {
          if (networkResponse && (networkResponse.ok || networkResponse.status === 0)) {
            putInCache(cache, event.request, networkResponse);
          } else {
            putInCache(cache, event.request, getPlaceholderResponse());
          }
        })
        .catch(() => {
          /* Ignore background update errors */
        });
      return cachedResponse;
    }
  }

  // Expired or not cached: fetch from network.
  try {
    const networkResponse = await fetchIcon(event.request.url);
    if (networkResponse && (networkResponse.ok || networkResponse.status === 0)) {
      await putInCache(cache, event.request, networkResponse.clone());
      return networkResponse;
    }
    // 404 or other error → return in-memory placeholder, and persist placeholder briefly to cache.
    const placeholder = getPlaceholderResponse();
    await putInCache(cache, event.request, placeholder.clone());
    return placeholder;
  } catch {
    return cachedResponse ?? getPlaceholderResponse();
  }
}

/**
 * Prefetches and caches a list of domains in throttled batches.
 */
export function handleIconPrefetch(domains: string[] = []): void {
  caches.open(CACHE_NAME).then((cache) => {
    const uniqueDomains = Array.from(new Set(domains));
    const batchSize = 6;
    let index = 0;

    const processNextBatch = () => {
      if (index >= uniqueDomains.length) return;
      const batch = uniqueDomains.slice(index, index + batchSize);
      index += batchSize;

      Promise.all(
        batch.map(async (domain) => {
          const url = `${DUCKDUCKGO_ICON_PREFIX}${domain.replace(/^\*\./, "")}.ico`;
          const request = new Request(url);

          const res = await cache.match(request);
          if (res) {
            const age = await getCacheAge(cache, request);
            const isMiss = res.headers.get("X-Icon-Miss") === "1";
            if (age < (isMiss ? ICON_MISS_FRESH_THRESHOLD : ICON_FRESH_THRESHOLD)) {
              return; // Already fresh in cache
            }
          }

          try {
            const networkResponse = await fetchIcon(url);
            if (networkResponse && (networkResponse.ok || networkResponse.status === 0)) {
              await putInCache(cache, request, networkResponse);
            } else {
              await putInCache(cache, request, getPlaceholderResponse());
            }
          } catch {
            /* Prefetch failures are silently ignored */
          }
        })
      ).finally(() => {
        if (index < uniqueDomains.length) {
          setTimeout(processNextBatch, 50);
        }
      });
    };

    processNextBatch();
  });
}

/**
 * Iterates through all cached items in CACHE_NAME and deletes any items
 * that have been cached for more than 30 days.
 */
export async function cleanExpiredCache(): Promise<void> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    const now = Date.now();

    const timestampKeys = keys.filter((req) => req.url.includes("?sw-cached-at"));

    for (const tsReq of timestampKeys) {
      const tsRes = await cache.match(tsReq);
      if (tsRes) {
        const cachedTimeText = await tsRes.text();
        const cachedTime = parseInt(cachedTimeText, 10);
        // Delete entries that have exceeded the configured expiry threshold.
        if (!isNaN(cachedTime) && now - cachedTime > ICON_EXPIRY_THRESHOLD) {
          const resourceUrl = tsReq.url.split("?")[0];
          await cache.delete(new Request(resourceUrl));
          await cache.delete(tsReq);
        }
      }
    }
  } catch (err) {
    console.error("Failed to execute service worker cache cleanup:", err);
  }
}

/**
 * Cleans up old cache versions that no longer match the current CACHE_NAME.
 */
export async function cleanOldCaches(): Promise<void> {
  try {
    const keys = await caches.keys();
    for (const key of keys) {
      if (key.startsWith("dns-worker-icons-") && key !== CACHE_NAME) {
        await caches.delete(key);
      }
    }
  } catch (err) {
    console.error("Failed to clean up old caches:", err);
  }
}
