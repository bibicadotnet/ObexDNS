import { Env, ProfileSettings, Rule } from "../types";
import { cacheUtils } from "../utils/cache";
import { isServerfullEnv } from "../utils/serverfullEnv";

export interface ConfigCacheEntry {
  settings: ProfileSettings;
  rules: Rule[];
  timestamp: number;
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

  /** Reads a value without refreshing its LRU position (safe while iterating). */
  peek(key: K): V | undefined {
    return super.get(key);
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

function getEnvNumber(key: string, defaultVal: number): number {
  if (typeof process !== "undefined" && process?.env && process.env[key]) {
    const val = Number(process.env[key]);
    if (Number.isFinite(val) && val > 0) return val;
  }
  return defaultVal;
}

// 基础配置体积较小，允许缓存 5000 个 Profile (CONFIG_CACHE_LIMIT)
export const configCache = new SizeCappedMap<string, ConfigCacheEntry>(
  getEnvNumber("CONFIG_CACHE_LIMIT", 5000)
);

// DNS 缓存限制最多 50000 条记录 (DNS_CACHE_LIMIT)
export const dnsCache = new SizeCappedMap<string, any>(
  getEnvNumber("DNS_CACHE_LIMIT", 50000)
);

// Block "already logged" marks (BLOCK_LOG_MARK_LIMIT): profile:domain -> unix time (s) the log row was written.
// A blocked domain is logged once per profile; later blocked queries only bump the rollup counters.
// No TTL: a mark is dropped when its row is deleted (clearBlockLogMarksFor with the cutoff time) or
// when the profile config changes (clearDnsCacheFor).
export const blockLogMarks = new SizeCappedMap<string, number>(
  getEnvNumber("BLOCK_LOG_MARK_LIMIT", 50000)
);

function blockLogMarkKey(profileId: string, domain: string): string {
  return `${profileId}:${domain.toLowerCase()}`;
}

export function isBlockLogged(profileId: string, domain: string): boolean {
  return blockLogMarks.get(blockLogMarkKey(profileId, domain)) !== undefined;
}

export function markBlockLogged(profileId: string, domain: string): void {
  blockLogMarks.set(blockLogMarkKey(profileId, domain), Math.floor(Date.now() / 1000));
}

/** Drops one mark (the log it stood for never reached the queue or was lost before it was written). */
export function unmarkBlockLogged(profileId: string, domain: string): void {
  blockLogMarks.delete(blockLogMarkKey(profileId, domain));
}

/** Drops every block mark (used after global retention deleted log rows). */
export function clearAllBlockLogMarks(): void {
  blockLogMarks.clear();
}

/**
 * Purges expired DNS query records from in-memory dnsCache.
 * Called during system maintenance (CLEANUP_INTERVAL_SEC) to free RAM from orphan queries.
 */
export function sweepExpiredDnsCache(): number {
  const now = Date.now();
  let count = 0;
  for (const [key, entry] of dnsCache) {
    if (entry && typeof entry.expiresAt === "number" && now >= entry.expiresAt) {
      dnsCache.delete(key);
      count++;
    }
  }
  return count;
}

// Profile Key 到 Profile 元数据映射缓存 (L1 内存缓存，限制最多 10000 个 Key, PROFILE_KEY_CACHE_LIMIT)
export const profileKeyMemoryMap = new SizeCappedMap<string, { data: any; ts: number }>(
  getEnvNumber("PROFILE_KEY_CACHE_LIMIT", 10000)
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

export const PROFILE_CACHE_KEY_PREFIX = "profile_v9";

const profileGenerations = new Map<string, number>();

/**
 * Returns the current generation counter for a profile.
 */
export function getProfileGeneration(profileId: string): number {
  return profileGenerations.get(profileId) || 0;
}

/**
 * Increments the generation counter for a profile, invalidating any in-flight
 * query resolutions that started before this cache invalidation.
 */
export function bumpProfileGeneration(profileId: string): number {
  const next = (profileGenerations.get(profileId) || 0) + 1;
  profileGenerations.set(profileId, next);
  return next;
}

/**
 * Clears dnsCache entries for a given set of profile IDs in a single O(N) pass.
 */
export function clearDnsCacheFor(profileIds: Set<string> | string[]): void {
  const pSet = profileIds instanceof Set ? profileIds : new Set(profileIds);
  if (pSet.size === 0) return;
  for (const key of dnsCache.keys()) {
    const colonIdx = key.indexOf(':');
    if (colonIdx > 0 && pSet.has(key.slice(0, colonIdx))) {
      dnsCache.delete(key);
    }
  }
  clearBlockLogMarksFor(pSet);
}

/**
 * Drops the block "already logged" marks of the given profiles. With `before` (unix seconds) only marks
 * logged before that time are dropped (their rows were deleted); without it all marks of the profiles go.
 */
export function clearBlockLogMarksFor(profileIds: Set<string> | string[], before?: number): void {
  const pSet = profileIds instanceof Set ? profileIds : new Set(profileIds);
  if (pSet.size === 0 || blockLogMarks.size === 0) return;
  for (const key of blockLogMarks.keys()) {
    const colonIdx = key.indexOf(':');
    if (colonIdx > 0 && pSet.has(key.slice(0, colonIdx))) {
      if (before === undefined || (blockLogMarks.peek(key) ?? 0) < before) blockLogMarks.delete(key);
    }
  }
}

let lastPipelineCacheEnv: Env | undefined;

export const pipelineCache = {
  /**
   * Cập nhật giới hạn dung lượng cache động từ env (hỗ trợ cả Workers và Serverfull).
   */
  initFromEnv(env?: Env): void {
    if (!env || env === lastPipelineCacheEnv) return;
    lastPipelineCacheEnv = env;

    const configLimit = Number(env.CONFIG_CACHE_LIMIT);
    if (configLimit && configLimit > 0) configCache.setMaxEntries(configLimit);

    const dnsLimit = Number(env.DNS_CACHE_LIMIT);
    if (dnsLimit && dnsLimit > 0) dnsCache.setMaxEntries(dnsLimit);

    const markLimit = Number(env.BLOCK_LOG_MARK_LIMIT);
    if (markLimit && markLimit > 0) blockLogMarks.setMaxEntries(markLimit);

    const keyLimit = Number(env.PROFILE_KEY_CACHE_LIMIT);
    if (keyLimit && keyLimit > 0) profileKeyMemoryMap.setMaxEntries(keyLimit);
  },

  /**
   * 清理多个 Profile 的各级缓存，单次扫描 dnsCache 避免事件循环阻塞。
   */
  async clearMany(
    profileIds: string[],
    clearFilterOrEnv: boolean | Env = true,
    envOrClearFilter?: Env | boolean
  ): Promise<void> {
    if (!profileIds || profileIds.length === 0) return;

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

    const pSet = new Set(profileIds);
    for (const pid of profileIds) {
      bumpProfileGeneration(pid);
      configCache.delete(pid);
    }

    // 清理 L1 (内存): 单次遍历 dnsCache，O(N) 复杂度
    profileKeyMemoryMap.clear();
    defaultProfileMemoryCache = null;
    clearDnsCacheFor(pSet);

    // 清理 L2 (本地数据中心 Cache API - Workers only, skipped on Serverfull)
    const isServerfull = isServerfullEnv(targetEnv);
    if (!isServerfull && typeof caches !== "undefined" && caches && (caches as any).default) {
      try {
        const cache = (caches as any).default;
        const tasks: Promise<any>[] = [];
        for (const pid of profileIds) {
          tasks.push(
            cacheUtils.delete(cache, `${PROFILE_CACHE_KEY_PREFIX}:${pid}`),
            cacheUtils.delete(cache, `profile_v8:${pid}`),
            cacheUtils.delete(cache, `profile_v7:${pid}`),
            cacheUtils.delete(cache, `profile_v6:${pid}`)
          );
          if (clearFilter) {
            tasks.push(cacheUtils.delete(cache, `filter-bin:${pid}`));
          }
        }
        await Promise.all(tasks);
      } catch (e) {
        console.error("Failed to clear cache API:", e);
      }
    }

    // 清理 L2 全球边缘节点 (Cloudflare Zone Cache Purge by Tag)
    if (targetEnv && targetEnv.CF_ZONE_ID && targetEnv.CF_PURGE_TOKEN) {
      const tags: string[] = [];
      for (const pid of profileIds) {
        tags.push(`profile-${pid}`);
        if (clearFilter) {
          tags.push(`filter-${pid}`);
        }
      }
      const PURGE_TAG_CHUNK = 30;
      for (let i = 0; i < tags.length; i += PURGE_TAG_CHUNK) {
        await purgeTags(targetEnv, tags.slice(i, i + PURGE_TAG_CHUNK));
      }
    }
  },

  /**
   * 清理指定 Profile 的各级缓存。
   */
  async clear(
    profileId: string,
    clearFilterOrEnv: boolean | Env = true,
    envOrClearFilter?: Env | boolean
  ): Promise<void> {
    return pipelineCache.clearMany([profileId], clearFilterOrEnv, envOrClearFilter);
  },

  purgeTags
};
