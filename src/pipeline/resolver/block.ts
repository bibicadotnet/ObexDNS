import { Context, DNSQuery, ProfileSettings, ResolutionResult } from "../../types";
import {
  buildResponse,
  buildResponseMulti,
  buildDNSQuery,
  parseDNSAnswer,
  DNSRecord
} from "../../utils/dns";
import { resolveClientGeoCountry } from "../../utils/geoip";
import { enqueueLog, shouldLogQuery, isLogPolicyEnabled, recordCacheHit } from "../logBatcher";
import { domainStateKey, observeAnswer, snapshotFromSynthetic } from "../domainState";
import { dnsCache, getProfileGeneration } from "../cache";
import { envBool, envNumber } from "../../utils/envNumber";
import { staleWindowMs } from "../lazyRefresh";

/** 1 day: BLOCK entries are never served stale and every rule/list/settings change clears them. */
export const DEFAULT_BLOCKED_CACHE_TTL_SEC = 86400;

/**
 * Stores a BLOCK / REDIRECT answer in the in-memory DNS cache so repeated queries skip rule matching and
 * are counted in the rollups instead of being logged (same as cached PASS answers).
 *
 * - Off when `DNS_CACHE_BLOCKED` (BLOCK) or `DNS_CACHE_REDIRECT` (REDIRECT) is false.
 * - BLOCK is never served stale (`staleUntil === expiresAt`): a background refresh would resolve the name
 *   upstream and replace the block with a PASS answer.
 * - REDIRECT follows the normal lazy cache (`DNS_STALE_WINDOW_SEC`): after its TTL it is still served, and the
 *   background refresh re-runs this same redirect (`redirect` keeps its value/type), so hits never reach the log.
 * - Dropped when the profile changed while this query was being matched (profile generation moved on).
 * - Rule / list / settings changes remove it through `pipelineCache.clear*` like any other entry.
 */
function cacheBlockedAnswer(
  query: DNSQuery,
  context: Context,
  settings: ProfileSettings,
  action: "BLOCK" | "REDIRECT",
  reason: string,
  answer: Uint8Array,
  redirect?: { value: string; type?: string }
): void {
  const env = context.env;
  const isRedirect = action === "REDIRECT";
  if (!envBool(isRedirect ? env?.DNS_CACHE_REDIRECT : env?.DNS_CACHE_BLOCKED, true)) return;
  if (answer.length === 0) return;
  if (context.profileGeneration !== undefined && context.profileGeneration !== getProfileGeneration(context.profileId)) {
    return;
  }

  let ttlSec: number;
  if (isRedirect) {
    // A redirect behaves like a normal domain: lives for the shortest TTL of its answer (same formula as PASS).
    const records = parseDNSAnswer(answer);
    ttlSec = records.length > 0 ? Math.max(10, Math.min(...records.map((r) => r.ttl))) : 60;
  } else {
    // A block answer is synthetic and only changes with the profile, so it can live long.
    ttlSec = envNumber(env?.DNS_CACHE_BLOCKED_TTL_SEC, DEFAULT_BLOCKED_CACHE_TTL_SEC, { min: 1 });
  }
  const expiresAt = Date.now() + ttlSec * 1000;
  dnsCache.set(`${context.profileId}:${query.name}:${query.type}`, {
    answer,
    ttl: ttlSec,
    action,
    reason,
    expiresAt,
    staleUntil: isRedirect && redirect ? expiresAt + staleWindowMs(env) : expiresAt,
    ...(isRedirect && redirect ? { redirect } : {}),
    countHits: !context.noLog && isLogPolicyEnabled(settings, action),
    destCountryCode: null,
    destCountry: null
  });
}

/**
 * Resolver function type used for resolving CNAME targets during redirection.
 */
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
  // A redirect that depends on a live upstream lookup is cached only when that lookup succeeded.
  let cacheable = true;

  if (action === "REDIRECT" && customAnswer) {
    if (
      responseType === "CNAME" &&
      (query.type === "A" || query.type === "AAAA") &&
      recursiveResolver
    ) {
      cacheable = false;
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
          // A refresh whose target lookup gave no address (SERVFAIL, empty answer) keeps the old entry.
          cacheable = !context.isBackgroundRefresh || parsedTargetAnswers.some((a) => a.type === query.type);
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

  if (cacheable) {
    cacheBlockedAnswer(
      query,
      context,
      settings,
      action,
      reason,
      answer,
      action === "REDIRECT" && customAnswer ? { value: customAnswer, type: responseType } : undefined
    );
  }

  // Lazy-cache refresh of a REDIRECT: the client was already served (and counted) from the stale entry.
  if (context.isBackgroundRefresh) {
    return { answer, ttl: 3600, action, reason, latency: Date.now() - context.startTime };
  }

  const nowMs = Date.now();
  const latency = nowMs - context.startTime;

  // Skip GeoIP entirely when the log would be discarded (retention 0, circuit breaker, ...)
  if (!context.noLog && shouldLogQuery(settings, action)) {
    // A repeated BLOCK / REDIRECT with the same answer (e.g. the cache was cleared by a list update, or the
    // redirect target is resolved live and never cached) is not worth another row: it is counted like a cache hit.
    // A first sighting, an action change (PASS -> BLOCK after a list update) or an answer change gets a row.
    const decision = observeAnswer(
      domainStateKey(context.profileId, query.name, query.type),
      snapshotFromSynthetic(action, displayAnswer),
      { background: false, env: context.env as any, settings, now: nowMs }
    );
    const task = (async () => {
      try {
        const clientCountry = await resolveClientGeoCountry(request, clientIp).catch(() => "UNKNOWN");
        const timestamp = Math.floor(nowMs / 1000);
        if (!decision.event) {
          recordCacheHit(
            {
              profileId: context.profileId,
              accessPointId: context.accessPointId,
              timestamp,
              action,
              domain: query.name,
              clientIp,
              geoCountry: clientCountry
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
            client_ip: clientIp,
            geo_country: clientCountry,
            domain: query.name,
            record_type: query.type,
            action,
            reason,
            answer: displayAnswer,
            latency,
            event: decision.event,
            prev_answer: decision.prevAnswer || null
          },
          settings,
          context.env,
          context.ctx
        );
      } catch {
        // Ignore non-critical background logging errors
      }
    })();
    context.ctx?.waitUntil?.(task);
  }

  return { answer, ttl: 3600, action, reason, latency };
}
