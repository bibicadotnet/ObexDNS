import { Context, DNSQuery, ProfileSettings, ResolutionResult } from "../../types";
import {
  buildResponse,
  buildResponseMulti,
  buildDNSQuery,
  parseDNSAnswer,
  DNSRecord
} from "../../utils/dns";
import { resolveClientGeoCountry } from "../../utils/geoip";
import { enqueueLog, shouldLogQuery, isLogPolicyEnabled } from "../logBatcher";
import { dnsCache, getProfileGeneration, isBlockLogged, markBlockLogged, unmarkBlockLogged } from "../cache";
import { countCacheHit } from "../cacheHit";
import { applyEcs } from "./ecs";
import { envNumber } from "../../utils/envNumber";


/**
 * Resolver function type used for resolving CNAME targets during redirection.
 */
/**
 * Default cache lifetime (s) of a REDIRECT answer built only from the rule (no upstream lookup involved):
 * effectively until cleared (1 year). Rule/setting changes clear dnsCache; LRU eviction bounds memory.
 * Override with STATIC_REDIRECT_CACHE_TTL.
 */
const DEFAULT_STATIC_REDIRECT_CACHE_TTL = 365 * 24 * 3600;

export type RecursiveResolverFn = (
  request: Request,
  query: DNSQuery,
  context: Context,
  settings: ProfileSettings,
  action: "PASS"
) => Promise<ResolutionResult>;

/**
 * Synthesizes DNS responses for blocked or redirected queries.
 *
 * For REDIRECT:
 * - If user queries A or AAAA and rule targets a CNAME domain, recursively resolves
 *   the target domain's IP addresses and constructs a multi-record response.
 * - Otherwise synthesizes a single record answer.
 *
 * For BLOCK:
 * - Supports NXDOMAIN (RCODE 3), NODATA (RCODE 0), CUSTOM_IP, or NULL_IP (0.0.0.0 / ::).
 *
 * Persists the block/redirect event asynchronously to the log batcher.
 *
 * Log dedupe / caching:
 * - REDIRECT answers are stored in dnsCache like PASS answers (hits write no log row but are
 *   counted in the rollups). TTL = smallest TTL of the answer's records, like PASS answers; a CNAME
 *   redirect also uses the ECS scope of the target lookup; degraded answers (target unresolved) are never cached.
 * - BLOCK answers are not cached (they are free to build). Instead the first blocked query of a
 *   domain per profile is logged and marked in RAM; later ones only count into the rollups.
 *   Marks are dropped with dnsCache and whenever logs are deleted.
 *
 * @param request - Inbound HTTP Request.
 * @param query - The incoming DNS query.
 * @param context - Request context.
 * @param settings - Current profile settings.
 * @param action - Either 'BLOCK' or 'REDIRECT'.
 * @param reason - Explanation for the action (e.g., rule pattern or category).
 * @param customAnswer - Custom IP or CNAME target domain if redirecting.
 * @param responseType - Target DNS record type (e.g. 'A', 'AAAA', 'CNAME').
 * @param recursiveResolver - Resolver callback for recursive target domain lookups.
 * @returns Standard ResolutionResult.
 */
export async function handleBlockOrRedirect(
  request: Request,
  query: DNSQuery,
  context: Context,
  settings: ProfileSettings,
  action: "BLOCK" | "REDIRECT",
  reason: string,
  customAnswer?: string,
  responseType?: string,
  recursiveResolver?: RecursiveResolverFn
): Promise<ResolutionResult> {
  const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
  let answer: Uint8Array;
  let displayAnswer = customAnswer || "";
  // Set only when a REDIRECT answer is complete and safe to serve from dnsCache.
  let redirectCacheable = false;
  let redirectEcsScope: string | undefined;
  // The answer starts with the synthetic CNAME record of the rule (fixed 60s TTL): it must not cap the cache TTL.
  let leadingSyntheticCname = false;

  if (action === "REDIRECT" && customAnswer) {
    if (
      responseType === "CNAME" &&
      (query.type === "A" || query.type === "AAAA") &&
      recursiveResolver
    ) {
      try {
        // If client requested A/AAAA but rule returns CNAME, resolve the target domain's A/AAAA
        const targetQueryRaw = buildDNSQuery(customAnswer, query.type);
        const targetQuery: DNSQuery = {
          name: customAnswer,
          type: query.type,
          raw: targetQueryRaw
        };
        const upstreamRes = await recursiveResolver(
          request,
          targetQuery,
          context,
          settings,
          "PASS"
        );

        if (upstreamRes.answer && upstreamRes.answer.length > 0) {
          const parsedTargetAnswers = parseDNSAnswer(upstreamRes.answer);
          const records: DNSRecord[] = [
            { type: "CNAME", value: customAnswer, ttl: 60 }
          ];

          for (const a of parsedTargetAnswers) {
            if (a.type === query.type || a.type === "CNAME") {
              records.push({
                name: a.name,
                type: a.type,
                value: a.data,
                ttl: a.ttl
              });
            }
          }
          answer = buildResponseMulti(query.raw, records, 0);
          leadingSyntheticCname = true;
          // Complete = the upstream answered the target lookup with NOERROR. That includes NODATA
          // (e.g. AAAA for a target without IPv6): the CNAME alone is then the correct answer.
          // An upstream failure (rcode != 0, FAIL action, truncated packet) stays uncached.
          const upstreamOk =
            upstreamRes.action !== "FAIL" &&
            upstreamRes.answer.length >= 12 &&
            (upstreamRes.answer[3] & 0x0f) === 0;
          if (upstreamOk) {
            redirectCacheable = true;
            redirectEcsScope = applyEcs(request, targetQuery, settings).ecsScope;
          }
        } else {
          answer = buildResponse(query.raw, responseType, customAnswer);
        }
      } catch (e) {
        console.error("CNAME resolution failed:", e);
        answer = buildResponse(query.raw, responseType, customAnswer);
      }
    } else {
      answer = buildResponse(
        query.raw,
        responseType || query.type,
        customAnswer
      );
      // A static CNAME answer is complete for every type except A/AAAA, where it is the degraded
      // fallback of a missing resolver (the target addresses were not resolved) and stays uncached.
      if (!(responseType === "CNAME" && (query.type === "A" || query.type === "AAAA"))) {
        redirectCacheable = true;
      }
    }
  } else {
    // Handling BLOCK modes
    const mode = settings.block_mode || "NULL_IP";

    if (mode === "NXDOMAIN") {
      answer = buildResponse(query.raw, query.type, "", 3600, 3);
      displayAnswer = "NXDOMAIN";
    } else if (mode === "NODATA") {
      answer = buildResponse(query.raw, query.type, "", 3600, 0);
      displayAnswer = "NODATA";
    } else if (mode === "CUSTOM_IP") {
      const customIp =
        query.type === "AAAA"
          ? settings.custom_block_ipv6 || "::"
          : settings.custom_block_ipv4 || "0.0.0.0";
      answer = buildResponse(query.raw, query.type, customIp);
      displayAnswer = customIp;
    } else {
      const nullIp = query.type === "AAAA" ? "::" : "0.0.0.0";
      answer = buildResponse(query.raw, query.type, nullIp);
      displayAnswer = nullIp;
    }
  }

  const nowMs = Date.now();
  const latency = nowMs - context.startTime;

  // Config invalidated while this query was resolving: neither cache nor mark anything.
  const genValid =
    context.profileGeneration === undefined ||
    context.profileGeneration === getProfileGeneration(context.profileId);

  // REDIRECT: store in dnsCache (same key scheme as PASS). Hits are counted, not logged.
  if (action === "REDIRECT" && redirectCacheable && answer.length > 0 && genValid) {
    // Same TTL rule as PASS answers: smallest TTL among the answer's records (min 10s). For a CNAME
    // redirect the rule's own CNAME record (fixed 60s) is skipped, otherwise every redirect would
    // expire after 60s whatever the target's TTL is, and each expiry would write a new log row.
    // Rule changes clear dnsCache, so the rule part never goes stale.
    const parsed = parseDNSAnswer(answer);
    const ttlRecords = leadingSyntheticCname && parsed.length > 1 ? parsed.slice(1) : parsed;
    // A static answer (fixed IP / TXT / CNAME from the rule) never changes by itself, and every rule or
    // setting change clears dnsCache, so it is cached until cleared.
    // The records sent to the client keep their own 60s TTL.
    const cacheTtl = !leadingSyntheticCname
      ? envNumber(context.env?.STATIC_REDIRECT_CACHE_TTL, DEFAULT_STATIC_REDIRECT_CACHE_TTL, { min: 10 })
      : ttlRecords.length > 0 ? Math.max(10, Math.min(...ttlRecords.map((a) => a.ttl))) : 60;
    const baseKey = `${context.profileId}:${query.name}:${query.type}`;
    dnsCache.set(redirectEcsScope ? `${baseKey}|${redirectEcsScope}` : baseKey, {
      answer,
      ttl: cacheTtl,
      action,
      reason,
      expiresAt: nowMs + cacheTtl * 1000,
      countHits: !context.noLog && isLogPolicyEnabled(settings, action),
      destCountryCode: null,
      destCountry: null
    });
  }

  // Skip GeoIP entirely when the log would be discarded (retention 0, circuit breaker, ...)
  let writeLog = !context.noLog && shouldLogQuery(settings, action);
  let markedHere = false;

  // BLOCK: one log row per profile+domain until the mark is dropped; repeats only count.
  if (action === "BLOCK" && writeLog) {
    if (isBlockLogged(context.profileId, query.name)) {
      writeLog = false;
      countCacheHit(request, query, context, { action });
    } else if (genValid) {
      // Marked synchronously: A and AAAA arriving together must not both be logged.
      markBlockLogged(context.profileId, query.name);
      markedHere = true;
    }
  }

  if (writeLog) context.ctx.waitUntil(
    (async () => {
      try {
        const clientCountry = await resolveClientGeoCountry(request, clientIp).catch(() => "UNKNOWN");
        const queued = enqueueLog(
          {
            profile_id: context.profileId,
            access_point_id: context.accessPointId,
            timestamp: Math.floor(nowMs / 1000),
            client_ip: clientIp,
            geo_country: clientCountry,
            domain: query.name,
            record_type: query.type,
            action,
            reason,
            answer: displayAnswer,
            latency
          },
          settings,
          context.env,
          context.ctx
        );
        // Not queued (queue full, logging disabled meanwhile): the mark would hide the domain forever.
        if (!queued && markedHere) unmarkBlockLogged(context.profileId, query.name);
      } catch {
        // Ignore non-critical background logging errors
        if (markedHere) unmarkBlockLogged(context.profileId, query.name);
      }
    })()
  );

  return { answer, ttl: 3600, action, reason, latency };
}
