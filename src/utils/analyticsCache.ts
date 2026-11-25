/**
 * @file analyticsCache.ts
 * @description Cache policy for the analytics endpoints (Cloudflare cache only; serverfull has none).
 *
 * The cache key carries a time bucket and the TTL equals the bucket, so an answer is at most one bucket
 * old. The bucket grows with the size of the window, because that is what keeps the answer accurate:
 *   - up to 24h:      60 s   (same minute resolution as the cache-hit buckets; 10M / 1H / 24H of one
 *                            minute are mutually consistent)
 *   - up to 7 days:   5 min  (<= 0.05% of the window)
 *   - longer:         15 min (<= 0.04% of 30 days) — these are the expensive ones: a 30-day domain query
 *                            reads tens of thousands of rollup rows on a metered D1
 *   - a window that already ended in the past can only change through late writes: 1 hour
 */

const PAST_GRACE_SEC = 120;

export interface AnalyticsCachePolicy {
  /** Key granularity and TTL in seconds. */
  bucketSec: number;
  /** Part of the cache key that identifies the window and its time bucket. */
  windowKey: string;
}

export function analyticsCachePolicy(
  range: string | null,
  since: number,
  until: number,
  customRange: boolean,
  nowSec: number = Math.floor(Date.now() / 1000)
): AnalyticsCachePolicy {
  const endedInPast = until < nowSec - PAST_GRACE_SEC;
  const span = until - since;
  const bucketSec = endedInPast ? 3600 : span <= 86400 + 59 ? 60 : span <= 7 * 86400 + 59 ? 300 : 900;
  // A relative range is named by its label (its since/until slide); a custom one by its exact edges.
  const name = customRange ? `${since}-${until}` : (range || "default");
  const timeKey = endedInPast ? "past" : String(Math.floor(until / bucketSec));
  return { bucketSec, windowKey: `${name}:${timeKey}` };
}
