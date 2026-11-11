import { Context, DNSQuery, ProfileSettings, ResolutionResult } from "../../types";
import { fetchGeoIP, resolveClientGeoCountry } from "../../utils/geoip";
import { dnsCache } from "../cache";
import { enqueueLog, shouldLogQuery } from "../logBatcher";
import { UpstreamHttpError, ParsedDNSAnswerRecord } from "./types";

/**
 * Caches the result in memory immediately (synchronously), then - only if the log will
 * actually be persisted - enriches it with GeoIP in the background and enqueues it.
 * Latency is captured before any GeoIP work so it reflects the real resolution time.
 *
 * @param request - Inbound HTTP Request.
 * @param query - The incoming DNS query.
 * @param context - Request context.
 * @param settings - Current profile settings.
 * @param action - Action status ('PASS').
 * @param effectiveReason - Resolution reason note.
 * @param parsedAnswers - Decoded DNS answer records.
 * @param answer - Raw wire-format DNS answer.
 * @param minTTL - Minimum TTL across answers (bounded between 10 and 3600 seconds).
 * @param rawUpstreamUrl - Upstream URL or stamp string.
 * @param ecs - Normalized ECS string if applied.
 */
export function recordSuccessAndCache(
  request: Request,
  query: DNSQuery,
  context: Context,
  settings: ProfileSettings,
  action: "PASS",
  effectiveReason: string | undefined,
  parsedAnswers: ParsedDNSAnswerRecord[],
  answer: Uint8Array,
  minTTL: number,
  rawUpstreamUrl: string,
  ecs?: string
): void {
  // 1. Cache first, synchronously. Nothing log-related (GeoIP, batching) may delay it,
  //    otherwise identical queries arriving meanwhile miss the cache and hit upstream again.
  if (answer.length > 0) {
    dnsCache.set(`${context.profileId}:${query.name}:${query.type}`, {
      answer,
      ttl: minTTL,
      action,
      reason: effectiveReason,
      expiresAt: Date.now() + minTTL * 1000
    });
  }

  // 2. Skip everything below (including GeoIP lookups) when the log would be discarded.
  if (!shouldLogQuery(settings, action)) {
    return;
  }

  // 3. Freeze latency and timestamp now: GeoIP time must not leak into the logged latency.
  const nowMs = Date.now();
  const latency = nowMs - context.startTime;
  const timestamp = Math.floor(nowMs / 1000);
  const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";

  context.ctx.waitUntil(
    (async () => {
      try {
        const firstIp = parsedAnswers.find(
          (a) => a.type === "A" || a.type === "AAAA"
        )?.data;

        // Resolve client and destination GeoIP concurrently; never let GeoIP failure drop the log.
        const [clientCountry, destGeo] = await Promise.all([
          resolveClientGeoCountry(request, clientIp).catch(() => "UNKNOWN"),
          firstIp ? fetchGeoIP(firstIp).catch(() => null) : Promise.resolve(null)
        ]);

        enqueueLog(
          {
            profile_id: context.profileId,
            access_point_id: context.accessPointId,
            timestamp,
            client_ip: clientIp,
            geo_country: clientCountry,
            domain: query.name,
            record_type: query.type,
            action,
            reason: effectiveReason,
            answer: parsedAnswers.map((a) => a.data).join(", "),
            dest_geoip: destGeo ? JSON.stringify(destGeo) : "",
            dest_country_code: destGeo?.country_code ? destGeo.country_code.toUpperCase() : null,
            dest_country: destGeo?.country || null,
            dest_isp: destGeo?.isp || null,
            upstream: rawUpstreamUrl,
            latency,
            ecs
          },
          settings,
          context.env,
          context.ctx
        );
      } catch {
        // Ignore non-critical background logging errors
      }
    })()
  );
}

/**
 * Handles upstream resolution failures, records diagnostic failure logs,
 * and formats the failure ResolutionResult.
 *
 * @param request - Inbound HTTP Request.
 * @param query - The incoming DNS query.
 * @param context - Request context.
 * @param settings - Current profile settings.
 * @param rawUpstreamUrl - Configured upstream URL or stamp.
 * @param error - The error caught during resolution.
 * @param ecs - Normalized ECS string if applied.
 * @param diagTarget - Diagnostic target address.
 * @param diagMethod - Diagnostic protocol method.
 * @returns ResolutionResult populated with FAIL status and diagnostic metadata.
 */
export function recordFailure(
  request: Request,
  query: DNSQuery,
  context: Context,
  settings: ProfileSettings,
  rawUpstreamUrl: string,
  error: unknown,
  ecs?: string,
  diagTarget?: string,
  diagMethod?: string
): ResolutionResult {
  let status = 0;
  let statusText: string | undefined;
  let errorDetail =
    error instanceof Error ? error.message : String(error);
  let responseBodySnippet: string | undefined;
  let cfRay: string | undefined;

  if (error instanceof UpstreamHttpError) {
    status = error.status;
    statusText = error.statusText || undefined;
    responseBodySnippet = error.responseBodySnippet || undefined;
    cfRay = error.cfRay;
  } else if (
    error &&
    typeof error === "object" &&
    "cause" in error &&
    error.cause
  ) {
    const cause = error.cause;
    const causeMsg =
      typeof cause === "object" && cause && "message" in cause
        ? String((cause as { message: unknown }).message)
        : String(cause);
    errorDetail += ` (Cause: ${causeMsg})`;
  }

  const failReason =
    status > 0
      ? `Upstream HTTP ${status}${statusText ? ` ${statusText}` : ""}`
      : `Upstream Error: ${errorDetail}`;

  const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
  const failNowMs = Date.now();
  const failLatency = failNowMs - context.startTime;

  // Asynchronously persist failure log for upstream troubleshooting
  // (skip entirely, including client GeoIP, when the log would be discarded)
  if (shouldLogQuery(settings, "FAIL")) context.ctx.waitUntil(
    (async () => {
      try {
        const clientCountry = await resolveClientGeoCountry(request, clientIp).catch(() => "UNKNOWN");
        enqueueLog(
          {
            profile_id: context.profileId,
            access_point_id: context.accessPointId,
            timestamp: Math.floor(failNowMs / 1000),
            client_ip: clientIp,
            geo_country: clientCountry,
            domain: query.name,
            record_type: query.type,
            action: "FAIL",
            reason: failReason,
            answer: "",
            dest_geoip: "",
            dest_country_code: null,
            dest_country: null,
            dest_isp: null,
            upstream: rawUpstreamUrl,
            latency: failLatency,
            ecs
          },
          settings,
          context.env,
          context.ctx
        );
      } catch {
        // Ignore background logging failures
      }
    })()
  );

  const effectiveDiagTarget = diagTarget || rawUpstreamUrl;
  const effectiveDiagMethod = diagMethod || "POST";

  return {
    answer: new Uint8Array(),
    ttl: 0,
    action: "FAIL",
    reason: failReason,
    latency: Date.now() - context.startTime,
    diagnostics: {
      upstream_url: rawUpstreamUrl.startsWith("sdns://")
        ? `${rawUpstreamUrl} (${effectiveDiagTarget})`
        : effectiveDiagTarget,
      method: effectiveDiagMethod,
      status,
      status_text: statusText,
      error_detail: errorDetail,
      response_body: responseBodySnippet,
      cf_ray: cfRay
    }
  };
}
