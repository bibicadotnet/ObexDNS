import { Context, DNSQuery, ProfileSettings, ResolutionResult } from "../types";
import { DEFAULT_FAIL_OPEN_UPSTREAM } from "../constants/presets";
import { buildResponse, capResponseTtl } from "../utils/dns";
import { dnsCache, pipelineCache, getProfileGeneration } from "./cache";
import { pipelineConfig } from "./config";
import { pipelineResolver, ecsCacheScope } from "./resolver";
import { pipelineFilter } from "./filter";
import { recordCacheHit, isLogWriteSilenced } from "./logBatcher";
import { resolveClientGeoCountry } from "../utils/geoip";
import { scheduleStaleRefresh, staleAnswerTtl } from "./lazyRefresh";

interface DnsCacheHit {
  key: string;
  entry: any;
  /** True when the entry is past its TTL but still inside the lazy-cache window. */
  stale: boolean;
}

/**
 * Looks the keys up in order. A fresh entry wins immediately; otherwise the first entry that is only stale is
 * used (lazy cache). Entries past their stale window, or malformed, are removed on the spot.
 */
function lookupDnsCache(keys: string[], now: number): DnsCacheHit | undefined {
  let staleHit: DnsCacheHit | undefined;
  for (const key of keys) {
    const entry = dnsCache.get(key);
    if (!entry) continue;
    if (!(entry.answer instanceof Uint8Array)) {
      dnsCache.delete(key);
      continue;
    }
    if (now < entry.expiresAt) return { key, entry, stale: false };
    const usableUntil = typeof entry.staleUntil === "number" ? entry.staleUntil : entry.expiresAt;
    if (now < usableUntil) {
      staleHit ??= { key, entry, stale: true };
      continue;
    }
    dnsCache.delete(key);
  }
  return staleHit;
}

/**
 * Registers a cache hit in the in-memory rollup counters.
 * Client and access point are known here, so per-device statistics stay accurate.
 */
function countCacheHit(
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

/**
 * Lazy-cache refresh: resolves the same query again with the profile's current settings and lets the normal
 * resolver overwrite the cache entry. No log row is written (see `isBackgroundRefresh`), and a failed refresh
 * leaves the old entry in place until its stale window ends.
 */
async function refreshStaleEntry(
  request: Request,
  query: DNSQuery,
  context: Context,
  reason?: string
): Promise<void> {
  const refreshContext: Context = { ...context, isBackgroundRefresh: true, startTime: Date.now() };
  const config = await pipelineConfig.load(refreshContext, () => {});
  // Emergency fail-open config (DB down, nothing in RAM): its upstream is not the profile's own, so keep the old entry.
  if (!config || config.isFallback) return;
  // `reason` keeps the cached entry's reason (e.g. "Whitelist") across the refresh; ECH/DDR paths still set their own.
  await pipelineResolver.resolve(request, query, refreshContext, config.settings, "PASS", reason);
}

/**
 * Lazy-cache refresh of a REDIRECT entry: runs the same redirect again (re-resolving a CNAME target) instead of
 * asking the upstream for the name itself, which would replace the redirect with the real answer.
 * No log row is written; a failed lookup leaves the old entry in place (see `handleBlockOrRedirect`).
 */
async function refreshStaleRedirect(
  request: Request,
  query: DNSQuery,
  context: Context,
  reason: string,
  redirect: { value: string; type?: string }
): Promise<void> {
  const refreshContext: Context = { ...context, isBackgroundRefresh: true, startTime: Date.now() };
  const config = await pipelineConfig.load(refreshContext, () => {});
  if (!config || config.isFallback) return;
  await pipelineResolver.block(request, query, refreshContext, config.settings, "REDIRECT", reason, redirect.value, redirect.type);
}

export const pipeline = {
  clearCache: pipelineCache.clear,
  clearCacheMany: pipelineCache.clearMany,

  async process(request: Request, query: DNSQuery, context: Context): Promise<ResolutionResult> {
    context.profileGeneration = getProfileGeneration(context.profileId);
    const timings: Record<string, number> = {};
    let mark = context.startTime;
    const track = (name: string) => {
      const now = Date.now();
      timings[name] = (timings[name] || 0) + (now - mark);
      mark = now;
    };

    // 特殊域名 & 缓存检查 (L1)
    if (query.name.toLowerCase() === 'obex' && query.type === 'TXT') {
      const answer = buildResponse(query.raw, 'TXT', context.profileId || 'obex');
      return { answer, ttl: 60, action: "PASS", reason: "Internal Verification", latency: Date.now() - context.startTime, timings: { total: Date.now() - context.startTime } };
    }

    // Unscoped entry first, then the entry scoped to this client's ECS subnet.
    // An expired entry is still used for a while (lazy cache) and refreshed in the background.
    const cacheBaseKey = `${context.profileId}:${query.name}:${query.type}`;
    const hit = lookupDnsCache([cacheBaseKey, `${cacheBaseKey}|${ecsCacheScope(request)}`], Date.now());
    const cached = hit?.entry;

    if (hit && cached && cached.answer instanceof Uint8Array) {
      if (hit.stale) {
        // The query buffer may be reused by the transport once this call returns: keep a private copy.
        // new Uint8Array(raw) always copies; Buffer.slice() (DoT) would only return a shared view.
        const refreshQuery: DNSQuery = { ...query, raw: new Uint8Array(query.raw) };
        scheduleStaleRefresh(
          hit.key,
          cached,
          cached.action === "REDIRECT" && cached.redirect
            ? () => refreshStaleRedirect(request, refreshQuery, context, cached.reason, cached.redirect)
            : () => refreshStaleEntry(request, refreshQuery, context, cached.reason),
          context.env,
          context.ctx
        );
      }
      // 这里的 cached.answer 已经是完整的 DNS 报文
      // 关键：DNS ID 必须匹配原始查询。ID 位于报文的前 2 字节。
      // A stale answer carries a short TTL so the client comes back soon for the refreshed one.
      const staleTtl = hit.stale ? staleAnswerTtl(context.env) : 0;
      const response = hit.stale ? capResponseTtl(cached.answer, staleTtl) : new Uint8Array(cached.answer);
      if (response.length >= 2 && query.raw.length >= 2) {
        response[0] = query.raw[0];
        response[1] = query.raw[1];
      }

      const latency = Date.now() - context.startTime;

      // Cache hits write no log row, but they are real queries: count them in RAM and let the
      // 15s flush add them to hourly_rollups so Analytics (totals, block ratio, per-device) stays correct.
      if (cached.countHits && !context.noLog && !isLogWriteSilenced()) {
        countCacheHit(request, query, context, cached);
      }

      return {
        answer: response,
        ttl: hit.stale ? staleTtl : Math.ceil((cached.expiresAt - Date.now()) / 1000),
        action: cached.action,
        reason: cached.reason,
        latency,
        timings: { dns_cache_mem: latency }
      };
    }

    // 加载配置
    const config = await pipelineConfig.load(context, track);
    if (!config) {
      const failOpenUpstream = context.env.FAIL_OPEN_UPSTREAM || DEFAULT_FAIL_OPEN_UPSTREAM;
      console.warn(`[Pipeline] Config unavailable for profile ${context.profileId}. Failing open to ${failOpenUpstream}`);
      const fallbackSettings: ProfileSettings = {
        upstream: [failOpenUpstream],
        default_policy: "ALLOW",
        log_retention_days: 0,
        ecs: { enabled: true, use_client_ip: true }
      };
      const final = await pipelineResolver.resolve(request, query, context, fallbackSettings, "PASS", "Fail-Open Fallback");
      return { ...final, timings: { ...timings, ...final.timings } };
    }

    // 匹配规则 (本地 + 外部)
    const matchResult = await pipelineFilter.match(
      request,
      query,
      context,
      config.settings,
      config.rules,
      track,
      config.enabledSystemListIds,
      config.enabledCustomListIds
    );
    if (matchResult) return { ...matchResult, timings: { ...timings, ...matchResult.timings } };

    // 默认策略 & 最终解析
    if (config.settings.default_policy === 'BLOCK') {
      const block = await pipelineResolver.block(request, query, context, config.settings, "BLOCK", "Default Policy");
      return { ...block, timings: { ...timings, ...block.timings } };
    }

    const final = await pipelineResolver.resolve(request, query, context, config.settings, "PASS");
    return { ...final, timings: { ...timings, ...final.timings } };
  }
};
