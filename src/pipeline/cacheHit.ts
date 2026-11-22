import { Context, DNSQuery } from "../types";
import { recordCacheHit } from "./logBatcher";
import { resolveClientGeoCountry } from "../utils/geoip";

/**
 * Registers a cache hit (or a deduplicated, not-logged query) in the in-memory rollup counters.
 * Client and access point are known here, so per-device statistics stay accurate.
 */
export function countCacheHit(
  request: Request,
  query: DNSQuery,
  context: Context,
  cached: { action: string; destCountryCode?: string | null; destCountry?: string | null }
): void {
  const timestamp = Math.floor(Date.now() / 1000);
  const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
  const record = (geoCountry: string) =>
    recordCacheHit(
      {
        profileId: context.profileId,
        accessPointId: context.accessPointId,
        timestamp,
        action: cached.action,
        domain: query.name,
        clientIp,
        geoCountry,
        destCountryCode: cached.destCountryCode,
        destCountry: cached.destCountry
      },
      context.env,
      context.ctx
    );

  // Same country resolution as logged queries; usually answered from the CF header without I/O.
  const task = resolveClientGeoCountry(request, clientIp)
    .catch(() => "UNKNOWN")
    .then(record);
  if (context.ctx && typeof context.ctx.waitUntil === "function") {
    context.ctx.waitUntil(task);
  }
}
