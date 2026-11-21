import { Context, DNSQuery, ProfileSettings, ResolutionResult } from "../../types";
import { fetchGeoIP, resolveClientGeoCountry } from "../../utils/geoip";
import { dnsCache, getProfileGeneration } from "../cache";
import { enqueueLog, shouldLogQuery, isLogPolicyEnabled, recordCacheHit } from "../logBatcher";
import { UpstreamHttpError, ParsedDNSAnswerRecord } from "./types";
import { staleWindowMs } from "../lazyRefresh";
import {
  allowRefreshError,
  domainStateKey,
  observeAnswer,
  snapshotFromAnswer,
  type EventDecision
} from "../domainState";

/**
 * Caches the result in memory immediately (synchronously), then - only if the log will
 * actually be persisted - enriches it with GeoIP in the background and either enqueues a log row or,
 * when the query adds nothing new (same answer as before, see domainState.ts), counts it like a cache hit.
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
 * @param ecsScope - Cache scope when the answer depends on the client's subnet (use_client_ip).
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
  ecs?: string,
  ecsScope?: string
): void {
  // 1. Cache first, synchronously. Nothing log-related (GeoIP, batching) may delay it,
  //    otherwise identical queries arriving meanwhile miss the cache and hit upstream again.
  //    Guard against race: if profile config was invalidated while query was resolving, discard stale write.
  const currentGen = getProfileGeneration(context.profileId);
  const isGenerationValid = context.profileGeneration === undefined || context.profileGeneration === currentGen;

  let cacheEntry: Record<string, any> | undefined;
  // A background refresh must not replace a good cached answer with an upstream error (SERVFAIL / REFUSED).
  const rcode = answer.length >= 4 ? answer[3] & 0x0f : 0;
  const isRefresh = context.isBackgroundRefresh === true;
  const refreshFailed = isRefresh && (rcode === 2 || rcode === 5);
  // Answers resolved with a per-client ECS subnet are keyed by that subnet so they are
  // never served to clients in other networks.
  const baseKey = `${context.profileId}:${query.name}:${query.type}`;
  const cacheKey = ecsScope ? `${baseKey}|${ecsScope}` : baseKey;
  // The entry this resolution replaces: a refresh needs to know whether its stale hit was counted (countHits).
  const previousEntry = isRefresh ? dnsCache.get(cacheKey) : undefined;
  if (answer.length > 0 && isGenerationValid && !refreshFailed) {
    const expiresAt = Date.now() + minTTL * 1000;
    cacheEntry = {
      answer,
      ttl: minTTL,
      action,
      reason: effectiveReason,
      expiresAt,
      // Lazy cache: the entry may still be served (with a short TTL) after expiresAt, until this moment.
      staleUntil: expiresAt + staleWindowMs(context.env),
      // Cache hits are counted into the hourly rollups (not logged) only when a miss
      // would have been logged for this profile. Profile setting changes clear dnsCache.
      countHits: !context.noLog && isLogPolicyEnabled(settings, action),
      destCountryCode: null,
      destCountry: null
    };
    dnsCache.set(cacheKey, cacheEntry);
  }

  const firstIp = parsedAnswers.find((a) => a.type === "A" || a.type === "AAAA")?.data;
  const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";

  // Lazy-cache refresh. The client's query was already served (and counted as a cache hit) from the stale entry,
  // so no row is written - except when the refresh found something worth showing: the answer changed behind the
  // user's back (the CDN-returns-a-wrong-IP case), or the upstream stopped answering. Such a row is that very
  // query: it is logged retroactively and the cache hit it was counted as is taken back (`count: -1`), so
  // Analytics still counts it once.
  if (isRefresh) {
    // Only the destination country is re-learned for the entry, because cache hits are counted into the destination rollups.
    if (cacheEntry?.countHits && firstIp) {
      context.ctx?.waitUntil?.(
        fetchGeoIP(firstIp)
          .then((geo) => {
            if (cacheEntry && geo?.country_code) {
              cacheEntry.destCountryCode = geo.country_code.toUpperCase();
              cacheEntry.destCountry = geo.country || null;
            }
          })
          .catch(() => undefined)
      );
    }
    if (!previousEntry?.countHits || context.noLog || !shouldLogQuery(settings, action)) return;

    const stateKey = domainStateKey(context.profileId, query.name, query.type, ecsScope);
    const nowMs = Date.now();
    let decision: EventDecision;
    let rowAction: string = action;
    let rowReason = effectiveReason;
    let rowAnswer = parsedAnswers.map((a) => a.data).join(", ");
    if (refreshFailed) {
      if (!allowRefreshError(stateKey, context.env as any, nowMs)) return;
      decision = { event: "error" };
      rowAction = previousEntry.action || action;
      rowReason = `Refresh failed: ${rcode === 2 ? "SERVFAIL" : "REFUSED"} (cached answer still served)`;
      rowAnswer = "";
    } else {
      decision = observeAnswer(stateKey, snapshotFromAnswer(action, query.type, rcode, parsedAnswers), {
        background: true,
        env: context.env as any,
        settings
      });
      if (!decision.event) return;
    }
    emitQueryEvent({
      request,
      query,
      context,
      settings,
      action: rowAction,
      reason: rowReason,
      answer: rowAnswer,
      decision,
      firstIp: refreshFailed ? undefined : firstIp,
      clientIp,
      upstream: rawUpstreamUrl,
      ecs,
      timestampMs: context.startTime,
      latency: nowMs - context.startTime,
      takeBack: { action: previousEntry.action, destCountryCode: previousEntry.destCountryCode, destCountry: previousEntry.destCountry }
    });
    return;
  }

  // 2. Skip everything below (including GeoIP lookups) when the log would be discarded.
  if (context.noLog || !shouldLogQuery(settings, action)) {
    return;
  }

  // 3. Freeze latency and timestamp now: GeoIP time must not leak into the logged latency.
  const nowMs = Date.now();
  const latency = nowMs - context.startTime;

  // Does this miss deserve a row? Only when it is new, the answer changed, or the same answer was last logged long ago.
  // Otherwise it is counted like a cache hit (Analytics stays exact) and Query Logs stay readable.
  const decision = observeAnswer(
    domainStateKey(context.profileId, query.name, query.type, ecsScope),
    snapshotFromAnswer(action, query.type, rcode, parsedAnswers),
    { background: false, env: context.env as any, settings, now: nowMs }
  );

  emitQueryEvent({
    request,
    query,
    context,
    settings,
    action,
    reason: effectiveReason,
    answer: parsedAnswers.map((a) => a.data).join(", "),
    decision,
    firstIp,
    clientIp,
    upstream: rawUpstreamUrl,
    ecs,
    timestampMs: nowMs,
    latency,
    cacheEntry
  });
}

interface EmitQueryEventInput {
  request: Request;
  query: DNSQuery;
  context: Context;
  settings: ProfileSettings;
  action: string;
  reason?: string;
  answer: string;
  decision: EventDecision;
  firstIp?: string;
  clientIp: string;
  upstream: string;
  ecs?: string;
  timestampMs: number;
  latency: number;
  /** Cache entry to remember the destination country on (so later hits count into the destination rollups). */
  cacheEntry?: Record<string, any>;
  /** Refresh only: the cache hit that this row replaces, to be taken out of the counters. */
  takeBack?: { action?: string; destCountryCode?: string | null; destCountry?: string | null };
}

/**
 * Enriches a resolved query with GeoIP in the background and then either writes its log row (decision.event set)
 * or - when the decision says "no row needed" - counts it like a cache hit so the totals stay exact.
 * GeoIP failures never drop the query.
 */
function emitQueryEvent(input: EmitQueryEventInput): void {
  const { request, query, context, settings, decision } = input;
  const timestamp = Math.floor(input.timestampMs / 1000);

  const task = (async () => {
      try {
        // Resolve client and destination GeoIP concurrently; never let GeoIP failure drop the log.
        const [clientCountry, destGeo] = await Promise.all([
          resolveClientGeoCountry(request, input.clientIp).catch(() => "UNKNOWN"),
          input.firstIp ? fetchGeoIP(input.firstIp).catch(() => null) : Promise.resolve(null)
        ]);

        // Remember the destination country on the cache entry so later cache hits
        // can be counted into the destination rollups without another GeoIP lookup.
        if (input.cacheEntry && destGeo?.country_code) {
          input.cacheEntry.destCountryCode = destGeo.country_code.toUpperCase();
          input.cacheEntry.destCountry = destGeo.country || null;
        }

        if (!decision.event) {
          recordCacheHit(
            {
              profileId: context.profileId,
              accessPointId: context.accessPointId,
              timestamp,
              action: input.action,
              domain: query.name,
              clientIp: input.clientIp,
              geoCountry: clientCountry,
              destCountryCode: destGeo?.country_code,
              destCountry: destGeo?.country
            },
            context.env,
            context.ctx
          );
          return;
        }

        enqueueLog(
          {
            profile_id: context.profileId,
            access_point_id: context.accessPointId,
            timestamp,
            client_ip: input.clientIp,
            geo_country: clientCountry,
            domain: query.name,
            record_type: query.type,
            action: input.action,
            reason: input.reason,
            answer: input.answer,
            dest_geoip: destGeo ? JSON.stringify(destGeo) : "",
            dest_country_code: destGeo?.country_code ? destGeo.country_code.toUpperCase() : null,
            dest_country: destGeo?.country || null,
            dest_isp: destGeo?.isp || null,
            upstream: input.upstream,
            latency: input.latency,
            ecs: input.ecs,
            event: decision.event,
            prev_answer: decision.prevAnswer || null
          },
          settings,
          context.env,
          context.ctx
        );

        if (input.takeBack) {
          recordCacheHit(
            {
              profileId: context.profileId,
              accessPointId: context.accessPointId,
              timestamp,
              action: input.takeBack.action || input.action,
              domain: query.name,
              clientIp: input.clientIp,
              geoCountry: clientCountry,
              destCountryCode: input.takeBack.destCountryCode,
              destCountry: input.takeBack.destCountry,
              count: -1
            },
            context.env,
            context.ctx
          );
        }
      } catch {
        // Ignore non-critical background logging errors
      }
    })();
  context.ctx?.waitUntil?.(task);
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
  diagMethod?: string,
  ecsScope?: string
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

  // A lazy-cache refresh that fails: the client was served the stale answer, so without a row nobody would learn
  // that the upstream stopped answering. One row per domain per DOMAIN_STATE_ERROR_MIN_SEC; it keeps the action
  // of the answer that was served (PASS), so Analytics does not count a failure the client never saw.
  if (context.isBackgroundRefresh && !context.noLog) {
    const cacheKey = `${context.profileId}:${query.name}:${query.type}${ecsScope ? `|${ecsScope}` : ""}`;
    const previousEntry = dnsCache.get(cacheKey);
    if (previousEntry?.countHits && shouldLogQuery(settings, previousEntry.action || "PASS")) {
      const stateKey = domainStateKey(context.profileId, query.name, query.type, ecsScope);
      if (allowRefreshError(stateKey, context.env as any, failNowMs)) {
        emitQueryEvent({
          request,
          query,
          context,
          settings,
          action: previousEntry.action || "PASS",
          reason: `Refresh failed: ${failReason} (cached answer still served)`,
          answer: "",
          decision: { event: "error" },
          clientIp,
          upstream: rawUpstreamUrl,
          ecs,
          timestampMs: context.startTime,
          latency: failLatency,
          takeBack: { action: previousEntry.action, destCountryCode: previousEntry.destCountryCode, destCountry: previousEntry.destCountry }
        });
      }
    }
  }

  // Asynchronously persist failure log for upstream troubleshooting
  // (skip entirely, including client GeoIP, when the log would be discarded)
  if (!context.noLog && !context.isBackgroundRefresh && shouldLogQuery(settings, "FAIL")) context.ctx.waitUntil(
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
            ecs,
            event: "error"
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
