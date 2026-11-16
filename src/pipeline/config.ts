import { Context, ProfileSettings, Rule } from "../types";
import { ProfileModel } from "../models/profile";
import { RuleModel } from "../models/rule";
import { ListModel } from "../models/list";
import { ProfileFilterModel } from "../models/profileFilter";
import { AdguardRulesModel } from "../models/adguardRules";
import { FingerprintSet } from "../utils/fingerprintSet";
import { cacheUtils } from "../utils/cache";
import { configCache, filterMemoryMap, adguardMemoryMap, pipelineCache, PROFILE_CACHE_KEY_PREFIX } from "./cache";
import { DEFAULT_FAIL_OPEN_UPSTREAM } from "../constants/presets";
import { AdGuardProfileEngine } from "../lib/adguard";
import { systemListsManager } from "../lib/filtering/systemListsManager";
import { isServerfullEnv } from "../utils/serverfullEnv";

export const pipelineConfig = {
  async load(context: Context, track: (name: string) => void): Promise<{
    settings: ProfileSettings;
    rules: Rule[];
    bloom?: FingerprintSet;
    filter?: FingerprintSet;
    adguard?: AdGuardProfileEngine;
    enabledSystemListIds?: number[];
  } | null> {
    const { profileId, env, ctx } = context;

    // Initialize/update memory cache limits from env
    pipelineCache.initFromEnv(env);

    // Ensure system shared lists are active in memory before building/checking config
    if (env.DB) {
      await systemListsManager.ensureLoaded(env.DB, false, env).catch((e) => {
        console.warn("[Config] Non-critical systemListsManager load error:", e);
      });
    }

    // Fast-path: Default profile for unauthenticated access points or emergency fail-open
    if (profileId === 'default') {
      const failOpenUpstream = env.FAIL_OPEN_UPSTREAM || DEFAULT_FAIL_OPEN_UPSTREAM;
      const defaultSettings: ProfileSettings = {
        upstream: [failOpenUpstream],
        default_policy: "ALLOW",
        log_retention_days: 0,
        ecs: { enabled: true, use_client_ip: true }
      };
      return { settings: defaultSettings, rules: [], bloom: undefined, filter: undefined, adguard: undefined, enabledSystemListIds: [] };
    }

    // 1. 检查 L1 Memory (Isolate Global)
    const inMem = filterMemoryMap.get(profileId);
    const inMemAdguard = adguardMemoryMap.get(profileId);
    const cachedConfig = configCache.get(profileId);
    
    const filterMemTtl = (Number(env.FILTER_MEM_TTL) || Number(env.BLOOM_MEM_TTL)) || 600000;
    const configuredMemTtl = Number(env.CONFIG_MEM_TTL) || 300000;
    const configMemTtl = Number.isFinite(configuredMemTtl) && configuredMemTtl > 0
      ? configuredMemTtl
      : 300000;
    if (cachedConfig && (Date.now() - (cachedConfig.timestamp || 0) < configMemTtl)) {
      track('load_config_l1_mem');
      const validFilter = (inMem && Date.now() - inMem.ts < filterMemTtl) ? (inMem.filter || inMem.bloom) : undefined;
      if (!cachedConfig.hasBloom && !cachedConfig.hasFilter || validFilter) {
        const validAdguard = inMemAdguard ? inMemAdguard.engine : (cachedConfig.adguard ? new AdGuardProfileEngine(cachedConfig.adguard) : undefined);
        return { ...cachedConfig, bloom: validFilter, filter: validFilter, adguard: validAdguard, enabledSystemListIds: cachedConfig.enabledSystemListIds || [] };
      }
    }

    // 2. 检查 L2 Cache API (Cloudflare Workers only, skipped on Serverfull)
    const isServerfull = isServerfullEnv(env);
    const cache = !isServerfull && typeof caches !== "undefined" && caches ? (caches as any).default : null;
    const profileCacheKey = `${PROFILE_CACHE_KEY_PREFIX}:${profileId}`;
    const filterInternalUrl = cacheUtils.generateCacheUrl(`filter-bin:${profileId}`);
    
    let apiCached = cache ? await cacheUtils.get<any>(cache, profileCacheKey) : null;
    let filter: FingerprintSet | undefined;
    let adguardEngine: AdGuardProfileEngine | undefined;

    if (apiCached) {
      track('load_config_l2_cache');
      if (inMem && Date.now() - inMem.ts < filterMemTtl) {
        filter = inMem.filter || inMem.bloom;
      } else if (cache) {
        try {
          const filterRes = await cache.match(filterInternalUrl);
          if (filterRes) {
            track('load_filter_l2_cache');
            const buffer = await filterRes.arrayBuffer();
            if (FingerprintSet.isCurrentVersion(buffer)) {
              try {
                filter = FingerprintSet.fromUint8Array(new Uint8Array(buffer));
                filterMemoryMap.set(profileId, { filter, bloom: filter, ts: Date.now(), byteLength: filter.byteLength });
              } catch (e: any) {
                console.warn(`[Config] Failed to deserialize cached filter for profile ${profileId}, ignoring:`, e?.message || e);
              }
            }
          }
        } catch {
          // Non-critical cache read error
        }
      }

      // 回退拉取
      if ((apiCached.hasBloom || apiCached.hasFilter) && !filter && env.DB) {
        try {
          const filterModel = new ProfileFilterModel(env.DB);
          const buffer = await filterModel.getProfileFilter(profileId);
          if (buffer) {
            track('load_filter_d1_fallback');
            if (FingerprintSet.isCurrentVersion(buffer)) {
              try {
                filter = FingerprintSet.fromUint8Array(new Uint8Array(buffer));
                filterMemoryMap.set(profileId, { filter, bloom: filter, ts: Date.now(), byteLength: filter.byteLength });
                if (cache) {
                  const filterRes = new Response(buffer, {
                    headers: {
                      "Content-Type": "application/octet-stream",
                      "Cache-Control": "public, max-age=604800",
                      "Cache-Tag": `filter-${profileId}`
                    }
                  });
                  ctx.waitUntil(cache.put(filterInternalUrl, filterRes));
                }
              } catch (e: any) {
                console.warn(`[Config] D1 filter buffer invalid for profile ${profileId}, skipping:`, e?.message || e);
              }
            }
          }
        } catch (e: any) {
          console.error(`[Config] D1 Filter fallback fetch failed for profile ${profileId}:`, e?.message || e);
        }
      }

      if (inMemAdguard) {
        adguardEngine = inMemAdguard.engine;
      } else if (apiCached.adguard) {
        adguardEngine = new AdGuardProfileEngine(apiCached.adguard);
        adguardMemoryMap.set(profileId, { engine: adguardEngine, ts: Date.now() });
      }
      
      configCache.set(profileId, { ...apiCached, timestamp: Date.now() });
      return { ...apiCached, bloom: filter, filter, adguard: adguardEngine, enabledSystemListIds: apiCached.enabledSystemListIds || [] };
    }

    // 3. 回退到 D1
    try {
      const profileModel = new ProfileModel(env.DB);
      const ruleModel = new RuleModel(env.DB);
      const filterModel = new ProfileFilterModel(env.DB);
      const adguardModel = new AdguardRulesModel(env.DB);
      const listModel = new ListModel(env.DB);

      const [profile, rules, buffer, adguardPayload, profileLists] = await Promise.all([
        profileModel.getById(profileId),
        ruleModel.getRules(profileId),
        filterModel.getProfileFilter(profileId).catch((e) => {
          console.error("[Config] D1 Filter loading failed:", e);
          return null;
        }),
        adguardModel.getProfileRules(profileId).catch((e) => {
          console.error("[Config] D1 AdGuard rules loading failed:", e);
          return null;
        }),
        listModel.getLists(profileId).catch(() => []),
        systemListsManager.ensureLoaded(env.DB, false, env).catch(() => {})
      ]);

      if (!profile) {
        if (cachedConfig) {
          console.warn(`[Config] Profile ${profileId} not in D1, using stale memory config.`);
          return { ...cachedConfig, bloom: inMem?.filter || inMem?.bloom, filter: inMem?.filter || inMem?.bloom, adguard: inMemAdguard?.engine };
        }
        console.warn(`[Config] Profile ${profileId} not found in DB. Serving emergency fail-open fallback.`);
        const failOpenUpstream = env.FAIL_OPEN_UPSTREAM || DEFAULT_FAIL_OPEN_UPSTREAM;
        const fallbackSettings: ProfileSettings = {
          upstream: [failOpenUpstream],
          default_policy: "ALLOW",
          log_retention_days: 0,
          ecs: { enabled: true, use_client_ip: true }
        };
        return { settings: fallbackSettings, rules: [], bloom: undefined, filter: undefined, adguard: undefined };
      }
      
      const settings = JSON.parse(profile.settings);
      
      if (buffer) {
        track('load_filter_l3_d1');
        const uint8 = new Uint8Array(buffer);
        if (FingerprintSet.isCurrentVersion(uint8)) {
          try {
            filter = FingerprintSet.fromUint8Array(uint8);
          } catch (e: any) {
            console.warn(`[Config] Corrupt filter data for profile ${profileId}, will be rebuilt on next sync:`, e?.message || e);
            filter = undefined;
          }
        } else {
          // Legacy BLMZ format - will be rebuilt into FPRT on next sync
          filter = undefined;
        }
      }

      if (adguardPayload) {
        adguardEngine = new AdGuardProfileEngine(adguardPayload);
        adguardMemoryMap.set(profileId, { engine: adguardEngine, ts: Date.now() });
      }

      const enabledSystemListIds: number[] = [];
      for (const l of profileLists) {
        if (l.enabled && systemListsManager.isSystemUrl(l.url)) {
          const sysId = systemListsManager.getIdByUrl(l.url);
          if (sysId) enabledSystemListIds.push(sysId);
        }
      }

      const config = { settings, rules, adguard: adguardPayload, hasBloom: Boolean(filter), hasFilter: Boolean(filter), enabledSystemListIds };
      if (filter) {
        filterMemoryMap.set(profileId, { filter, bloom: filter, ts: Date.now(), byteLength: filter.byteLength });
      }
      
      configCache.set(profileId, { ...config, timestamp: Date.now() });
      if (cache) {
        ctx.waitUntil(cacheUtils.set(cache, profileCacheKey, config, 86400, [`profile-${profileId}`]));
        if (filter && buffer) {
          const filterRes = new Response(buffer, {
            headers: {
              "Content-Type": "application/octet-stream",
              "Cache-Control": "public, max-age=604800",
              "Cache-Tag": `filter-${profileId}`
            }
          });
          ctx.waitUntil(cache.put(filterInternalUrl, filterRes));
        }
      }
      
      track('load_config_full_sync');
      return { ...config, bloom: filter, filter, adguard: adguardEngine, enabledSystemListIds };
    } catch (e: any) {
      console.warn(`[Config] D1 profile fetch failed for ${profileId}:`, e?.message || e);
      
      if (cachedConfig) {
        console.warn(`[Config] Serving stale config from memory for profile ${profileId}`);
        return { ...cachedConfig, bloom: inMem?.filter || inMem?.bloom, filter: inMem?.filter || inMem?.bloom, adguard: inMemAdguard?.engine, enabledSystemListIds: cachedConfig.enabledSystemListIds || [] };
      }

      console.warn(`[Config] Serving emergency fail-open safe fallback for profile ${profileId}`);
      const failOpenUpstream = env.FAIL_OPEN_UPSTREAM || DEFAULT_FAIL_OPEN_UPSTREAM;
      const fallbackSettings: ProfileSettings = {
        upstream: [failOpenUpstream],
        default_policy: "ALLOW",
        log_retention_days: 0,
        ecs: { enabled: true, use_client_ip: true }
      };
      return { settings: fallbackSettings, rules: [], bloom: undefined, filter: undefined, adguard: undefined, enabledSystemListIds: [] };
    }
  }
};
