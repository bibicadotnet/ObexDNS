import { Context, ProfileSettings, Rule } from "../types";
import { ProfileModel } from "../models/profile";
import { RuleModel } from "../models/rule";
import { ListModel } from "../models/list";
import { cacheUtils } from "../utils/cache";
import { configCache, pipelineCache, PROFILE_CACHE_KEY_PREFIX } from "./cache";
import { DEFAULT_FAIL_OPEN_UPSTREAM } from "../constants/presets";
import { systemListsManager } from "../lib/filtering/systemListsManager";
import { customListsManager } from "../lib/filtering/customListsManager";
import { isServerfullEnv } from "../utils/serverfullEnv";

export const pipelineConfig = {
  async load(context: Context, track: (name: string) => void): Promise<{
    settings: ProfileSettings;
    rules: Rule[];
    enabledSystemListIds?: number[];
    enabledCustomListIds?: number[];
  } | null> {
    const { profileId, env, ctx } = context;

    // Initialize/update memory cache limits from env
    pipelineCache.initFromEnv(env);
    customListsManager.initFromEnv(env);

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
      return { settings: defaultSettings, rules: [], enabledSystemListIds: [], enabledCustomListIds: [] };
    }

    // 1. 检查 L1 Memory (Isolate Global)
    const cachedConfig = configCache.get(profileId);
    const configuredMemTtl = Number(env.CONFIG_MEM_TTL) || 300000;
    const configMemTtl = Number.isFinite(configuredMemTtl) && configuredMemTtl > 0
      ? configuredMemTtl
      : 300000;

    if (cachedConfig && (Date.now() - (cachedConfig.timestamp || 0) < configMemTtl)) {
      track('load_config_l1_mem');
      const enabledCustomListIds = cachedConfig.enabledCustomListIds || [];
      if (env.DB && enabledCustomListIds.length > 0) {
        await customListsManager.ensureLoaded(enabledCustomListIds, env.DB).catch(() => {});
      }
      return {
        ...cachedConfig,
        enabledSystemListIds: cachedConfig.enabledSystemListIds || [],
        enabledCustomListIds
      };
    }

    // 2. 检查 L2 Cache API (Cloudflare Workers only, skipped on Serverfull)
    const isServerfull = isServerfullEnv(env);
    const cache = !isServerfull && typeof caches !== "undefined" && caches ? (caches as any).default : null;
    const profileCacheKey = `${PROFILE_CACHE_KEY_PREFIX}:${profileId}`;
    
    let apiCached = cache ? await cacheUtils.get<any>(cache, profileCacheKey) : null;

    if (apiCached) {
      track('load_config_l2_cache');
      const enabledCustomListIds = apiCached.enabledCustomListIds || [];
      if (env.DB && enabledCustomListIds.length > 0) {
        await customListsManager.ensureLoaded(enabledCustomListIds, env.DB).catch(() => {});
      }
      configCache.set(profileId, { ...apiCached, timestamp: Date.now() });
      return {
        ...apiCached,
        enabledSystemListIds: apiCached.enabledSystemListIds || [],
        enabledCustomListIds
      };
    }

    // 3. 回退到 D1 / SQLite
    try {
      const profileModel = new ProfileModel(env.DB);
      const ruleModel = new RuleModel(env.DB);
      const listModel = new ListModel(env.DB);

      const [profile, rules, profileLists] = await Promise.all([
        profileModel.getById(profileId),
        ruleModel.getRules(profileId),
        listModel.getLists(profileId).catch(() => []),
        systemListsManager.ensureLoaded(env.DB, false, env).catch(() => {})
      ]);

      if (!profile) {
        if (cachedConfig) {
          console.warn(`[Config] Profile ${profileId} not in D1, using stale memory config.`);
          return {
            ...cachedConfig,
            enabledSystemListIds: cachedConfig.enabledSystemListIds || [],
            enabledCustomListIds: cachedConfig.enabledCustomListIds || []
          };
        }
        console.warn(`[Config] Profile ${profileId} not found in DB. Serving emergency fail-open fallback.`);
        const failOpenUpstream = env.FAIL_OPEN_UPSTREAM || DEFAULT_FAIL_OPEN_UPSTREAM;
        const fallbackSettings: ProfileSettings = {
          upstream: [failOpenUpstream],
          default_policy: "ALLOW",
          log_retention_days: 0,
          ecs: { enabled: true, use_client_ip: true }
        };
        return { settings: fallbackSettings, rules: [], enabledSystemListIds: [], enabledCustomListIds: [] };
      }
      
      const settings = JSON.parse(profile.settings);

      const enabledSystemListIds: number[] = [];
      const enabledCustomListIds: number[] = [];
      for (const l of profileLists) {
        if (l.enabled) {
          if (systemListsManager.isSystemUrl(l.url)) {
            const sysId = systemListsManager.getIdByUrl(l.url);
            if (sysId) enabledSystemListIds.push(sysId);
          } else {
            enabledCustomListIds.push(l.id);
          }
        }
      }

      if (env.DB && enabledCustomListIds.length > 0) {
        await customListsManager.ensureLoaded(enabledCustomListIds, env.DB).catch((e) => {
          console.warn(`[Config] Failed to preload custom lists for profile ${profileId}:`, e?.message || e);
        });
      }

      const config = { settings, rules, enabledSystemListIds, enabledCustomListIds };
      configCache.set(profileId, { ...config, timestamp: Date.now() });

      if (cache) {
        ctx.waitUntil(cacheUtils.set(cache, profileCacheKey, config, 86400, [`profile-${profileId}`]));
      }
      
      track('load_config_full_sync');
      return {
        ...config,
        enabledSystemListIds,
        enabledCustomListIds
      };
    } catch (e: any) {
      console.warn(`[Config] D1 profile fetch failed for ${profileId}:`, e?.message || e);
      
      if (cachedConfig) {
        console.warn(`[Config] Serving stale config from memory for profile ${profileId}`);
        return {
          ...cachedConfig,
          enabledSystemListIds: cachedConfig.enabledSystemListIds || [],
          enabledCustomListIds: cachedConfig.enabledCustomListIds || []
        };
      }

      console.warn(`[Config] Serving emergency fail-open safe fallback for profile ${profileId}`);
      const failOpenUpstream = env.FAIL_OPEN_UPSTREAM || DEFAULT_FAIL_OPEN_UPSTREAM;
      const fallbackSettings: ProfileSettings = {
        upstream: [failOpenUpstream],
        default_policy: "ALLOW",
        log_retention_days: 0,
        ecs: { enabled: true, use_client_ip: true }
      };
      return { settings: fallbackSettings, rules: [], enabledSystemListIds: [], enabledCustomListIds: [] };
    }
  }
};
