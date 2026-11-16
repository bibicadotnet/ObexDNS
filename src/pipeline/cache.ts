import { Env, ProfileSettings, Rule } from "../types";
import { FingerprintSet } from "../utils/fingerprintSet";
import { cacheUtils } from "../utils/cache";
import { isServerfullEnv } from "../utils/serverfullEnv";
import { AdGuardProfileEngine, AdGuardPayload } from "../lib/adguard";

export interface ConfigCacheEntry {
  settings: ProfileSettings;
  rules: Rule[];
  timestamp: number;
  adguard?: AdGuardPayload | null;
  hasBloom?: boolean;
  hasFilter?: boolean;
  enabledSystemListIds?: number[];
  enabledCustomListIds?: number[];
}

/**
 * 高性能、零依赖的容量受限 Map (LRU 淘汰策略)。
 * 利用 JavaScript Map 保证的“按插入顺序迭代”特性，在 O(1) 复杂度内自动淘汰最旧的数据。
 */
export class SizeCappedMap<K, V> extends Map<K, V> {
  constructor(private maxEntries: number) {
    super();
  }

  setMaxEntries(entries: number): void {
    if (entries > 0) {
      this.maxEntries = entries;
      while (this.size > this.maxEntries) {
        const oldestKey = this.keys().next().value;
        if (oldestKey === undefined) break;
        this.delete(oldestKey);
      }
    }
  }

  getMaxEntries(): number {
    return this.maxEntries;
  }

  override get(key: K): V | undefined {
    const val = super.get(key);
    if (val !== undefined) {
      super.delete(key);
      super.set(key, val);
    }
    return val;
  }

  override set(key: K, value: V): this {
    if (!this.has(key) && this.size >= this.maxEntries) {
      const oldestKey = this.keys().next().value;
      if (oldestKey !== undefined) {
        this.delete(oldestKey);
      }
    }
    this.delete(key);
    super.set(key, value);
    return this;
  }
}

/**
 * Byte-budget capped Map with LRU eviction.
 * Entries larger than the budget are still admitted, evicting other entries.
 */
export class ByteCappedMap<K, V extends { byteLength?: number }> extends Map<K, V> {
  private currentBytes: number = 0;

  constructor(private maxBytes: number = 32 * 1024 * 1024) {
    super();
  }

  setMaxBytes(bytes: number): void {
    if (bytes > 0) {
      this.maxBytes = bytes;
      while (this.size > 0 && this.currentBytes > this.maxBytes) {
        const oldestKey = this.keys().next().value;
        if (oldestKey === undefined) break;
        this.delete(oldestKey);
      }
    }
  }

  getMaxBytes(): number {
    return this.maxBytes;
  }

  override get(key: K): V | undefined {
    const val = super.get(key);
    if (val !== undefined) {
      super.delete(key);
      super.set(key, val);
    }
    return val;
  }

  override set(key: K, value: V): this {
    const itemBytes = value.byteLength || 0;
    this.delete(key);

    // Evict oldest until within budget
    while (this.size > 0 && this.currentBytes + itemBytes > this.maxBytes) {
      const oldestKey = this.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }

    super.set(key, value);
    this.currentBytes += itemBytes;
    return this;
  }

  override delete(key: K): boolean {
    const existing = super.get(key);
    if (existing) {
      this.currentBytes -= existing.byteLength || 0;
    }
    return super.delete(key);
  }

  override clear(): void {
    this.currentBytes = 0;
    super.clear();
  }

  get totalBytes(): number {
    return this.currentBytes;
  }
}

export interface FilterMemoryEntry {
  filter: FingerprintSet;
  ts: number;
  byteLength: number;
  // Backward compatibility getter/alias
  bloom?: FingerprintSet;
}

function getEnvNumber(key: string, defaultVal: number): number {
  if (typeof process !== "undefined" && process?.env && process.env[key]) {
    const val = Number(process.env[key]);
    if (Number.isFinite(val) && val > 0) return val;
  }
  return defaultVal;
}

// --- L1 Memory Cache (Isolate 全局，字节预算限制) ---
// Bảng lọc có ngân sách RAM mặc định 32 MiB (FILTER_MEM_BYTES)
export const filterMemoryMap = new ByteCappedMap<string, FilterMemoryEntry>(
  getEnvNumber("FILTER_MEM_BYTES", getEnvNumber("BLOOM_MEM_BYTES", 32 * 1024 * 1024))
);
export const bloomMemoryMap = filterMemoryMap;

// 基础配置体积较小，允许缓存 200 个 Profile (CONFIG_CACHE_LIMIT)
export const configCache = new SizeCappedMap<string, ConfigCacheEntry>(
  getEnvNumber("CONFIG_CACHE_LIMIT", 200)
);

// AdGuard 扩展规则引擎内存缓存 (L1 内存缓存，限制最多 20 个 Profile, ADGUARD_CACHE_LIMIT)
export const adguardMemoryMap = new SizeCappedMap<string, { engine: AdGuardProfileEngine; ts: number }>(
  getEnvNumber("ADGUARD_CACHE_LIMIT", 20)
);

// DNS 缓存限制最多 500 条记录 (DNS_CACHE_LIMIT)
export const dnsCache = new SizeCappedMap<string, any>(
  getEnvNumber("DNS_CACHE_LIMIT", 500)
);

// Profile Key 到 Profile 元数据映射缓存 (L1 内存缓存，限制最多 500 个 Key, PROFILE_KEY_CACHE_LIMIT)
export const profileKeyMemoryMap = new SizeCappedMap<string, { data: any; ts: number }>(
  getEnvNumber("PROFILE_KEY_CACHE_LIMIT", 500)
);

// 默认 Profile 元数据内存缓存 (L1 内存缓存，5 分钟 TTL，防范 UDP DNS 高频穿透)
export let defaultProfileMemoryCache: { data: any; ts: number } | null = null;
export function setDefaultProfileMemoryCache(entry: { data: any; ts: number } | null): void {
  defaultProfileMemoryCache = entry;
}

/**
 * 通过 Cloudflare Zone Cache Purge API 全球按 Tag 主动失效缓存。
 * 需配置 CF_ZONE_ID 与 CF_PURGE_TOKEN (具备 Zone -> Cache Purge 权限)。
 */
async function purgeTags(env: Env, tags: string[]): Promise<void> {
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_PURGE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[Cache] Global cache purge failed (HTTP ${res.status}):`, errorText);
    }
  } catch (e: any) {
    console.error("[Cache] Global cache purge error:", e?.message || e);
  }
}

export const PROFILE_CACHE_KEY_PREFIX = "profile_v8";

export const pipelineCache = {
  /**
   * Cập nhật giới hạn dung lượng cache động từ env (hỗ trợ cả Workers và Serverfull).
   */
  initFromEnv(env?: Env): void {
    if (!env) return;
    const filterBytes = Number(env.FILTER_MEM_BYTES) || Number(env.BLOOM_MEM_BYTES);
    if (filterBytes && filterBytes > 0) filterMemoryMap.setMaxBytes(filterBytes);

    const configLimit = Number(env.CONFIG_CACHE_LIMIT);
    if (configLimit && configLimit > 0) configCache.setMaxEntries(configLimit);

    const adguardLimit = Number(env.ADGUARD_CACHE_LIMIT);
    if (adguardLimit && adguardLimit > 0) adguardMemoryMap.setMaxEntries(adguardLimit);

    const dnsLimit = Number(env.DNS_CACHE_LIMIT);
    if (dnsLimit && dnsLimit > 0) dnsCache.setMaxEntries(dnsLimit);

    const keyLimit = Number(env.PROFILE_KEY_CACHE_LIMIT);
    if (keyLimit && keyLimit > 0) profileKeyMemoryMap.setMaxEntries(keyLimit);
  },

  /**
   * 清理指定 Profile 的各级缓存。
   */
  async clear(
    profileId: string,
    clearFilterOrEnv: boolean | Env = true,
    envOrClearFilter?: Env | boolean
  ): Promise<void> {
    let clearFilter = true;
    let targetEnv: Env | undefined;

    if (typeof clearFilterOrEnv === "boolean") {
      clearFilter = clearFilterOrEnv;
      if (envOrClearFilter && typeof envOrClearFilter === "object") {
        targetEnv = envOrClearFilter as Env;
      }
    } else if (clearFilterOrEnv && typeof clearFilterOrEnv === "object") {
      targetEnv = clearFilterOrEnv as Env;
      if (typeof envOrClearFilter === "boolean") {
        clearFilter = envOrClearFilter;
      }
    }

    // 清理 L1 (内存)
    configCache.delete(profileId);
    adguardMemoryMap.delete(profileId);
    if (clearFilter) {
      filterMemoryMap.delete(profileId);
    }
    profileKeyMemoryMap.clear();
    defaultProfileMemoryCache = null;
    for (const key of dnsCache.keys()) {
      if (key.startsWith(`${profileId}:`)) {
        dnsCache.delete(key);
      }
    }

    // 清理 L2 (本地数据中心 Cache API - Workers only, skipped on Serverfull)
    const isServerfull = isServerfullEnv(targetEnv);
    if (!isServerfull && typeof caches !== "undefined" && caches && (caches as any).default) {
      try {
        const cache = (caches as any).default;
        const tasks: Promise<any>[] = [
          cacheUtils.delete(cache, `${PROFILE_CACHE_KEY_PREFIX}:${profileId}`),
          cacheUtils.delete(cache, `profile_v7:${profileId}`),
          cacheUtils.delete(cache, `profile_v6:${profileId}`)
        ];
        if (clearFilter) {
          tasks.push(cacheUtils.delete(cache, `filter-bin:${profileId}`));
        }
        await Promise.all(tasks);
      } catch (e) {
        console.error("Failed to clear cache API:", e);
      }
    }

    // 清理 L2 全球边缘节点 (Cloudflare Zone Cache Purge by Tag)
    if (targetEnv && targetEnv.CF_ZONE_ID && targetEnv.CF_PURGE_TOKEN) {
      const tags = [`profile-${profileId}`];
      if (clearFilter) {
        tags.push(`filter-${profileId}`);
      }
      await purgeTags(targetEnv, tags);
    }
  }
};
