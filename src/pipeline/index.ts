import { Context, DNSQuery, ProfileSettings, ResolutionResult } from "../types";
import { DEFAULT_FAIL_OPEN_UPSTREAM } from "../constants/presets";
import { buildResponse } from "../utils/dns";
import { dnsCache, pipelineCache, getProfileGeneration } from "./cache";
import { pipelineConfig } from "./config";
import { pipelineResolver, ecsCacheScope } from "./resolver";
import { pipelineFilter } from "./filter";
import { recordCacheHit, isLogWriteSilenced } from "./logBatcher";
import { resolveClientGeoCountry } from "../utils/geoip";

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
    const cacheBaseKey = `${context.profileId}:${query.name}:${query.type}`;
    let cached = dnsCache.get(cacheBaseKey);
    if (cached && (Date.now() >= cached.expiresAt || !(cached.answer instanceof Uint8Array))) {
      dnsCache.delete(cacheBaseKey);
      cached = undefined;
    }

    if (!cached) {
      const ecsKey = `${cacheBaseKey}|${ecsCacheScope(request)}`;
      cached = dnsCache.get(ecsKey);
      if (cached && (Date.now() >= cached.expiresAt || !(cached.answer instanceof Uint8Array))) {
        dnsCache.delete(ecsKey);
        cached = undefined;
      }
    }

    if (cached && cached.answer instanceof Uint8Array) {
      // 这里的 cached.answer 已经是完整的 DNS 报文
      // 关键：DNS ID 必须匹配原始查询。ID 位于报文的前 2 字节。
      const response = new Uint8Array(cached.answer);
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
        ttl: Math.ceil((cached.expiresAt - Date.now()) / 1000),
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
