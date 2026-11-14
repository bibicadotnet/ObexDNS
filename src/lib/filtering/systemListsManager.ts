/**
 * @file systemListsManager.ts
 * @description In-memory manager and cache for system-wide shared filter lists, Blooms, and AdGuard rules.
 */

import { D1Database } from "@cloudflare/workers-types";
import { SystemListModel } from "../../models/systemList";
import { BloomFilter } from "../../utils/bloom";
import { AdGuardProfileEngine, AdGuardPayload } from "../adguard";
import { getSystemFilterUrls, getSystemFilterEntries } from "../../constants/presets";

export interface SystemListCacheItem {
  id: number;
  url: string;
  name: string | null;
  bloom: BloomFilter | null;
  adguard: AdGuardProfileEngine | null;
  updatedAt: number;
}

class SystemListsManager {
  private items: Map<number, SystemListCacheItem> = new Map();
  private urlToId: Map<string, number> = new Map();
  private lastLoadedTs: number = 0;
  private loadPromise: Promise<void> | null = null;
  private version: number = 1;

  /**
   * Returns whether a given URL is a registered system shared list.
   */
  isSystemUrl(url: string): boolean {
    const norm = url.trim().toLowerCase();
    for (const [sysUrl] of this.urlToId) {
      if (sysUrl.toLowerCase() === norm) return true;
    }
    return false;
  }

  /**
   * Resolves the system list ID for a given URL.
   */
  getIdByUrl(url: string): number | undefined {
    const norm = url.trim().toLowerCase();
    for (const [sysUrl, id] of this.urlToId) {
      if (sysUrl.toLowerCase() === norm) return id;
    }
    return undefined;
  }

  /**
   * Resolves the display name (admin label or title parsed from the list header) of a system list URL.
   */
  getNameByUrl(url: string): string | null {
    const id = this.getIdByUrl(url);
    return id === undefined ? null : this.items.get(id)?.name || null;
  }

  /**
   * Invalidates in-memory system list cache, forcing a refresh on next access.
   */
  invalidate(): void {
    this.lastLoadedTs = 0;
    this.version++;
  }

  getVersion(): number {
    return this.version;
  }

  getBloom(id: number): BloomFilter | null {
    return this.items.get(id)?.bloom || null;
  }

  getAdguard(id: number): AdGuardProfileEngine | null {
    return this.items.get(id)?.adguard || null;
  }

  getAllSystemUrls(): string[] {
    return Array.from(this.urlToId.keys());
  }

  /**
   * Ensures system lists are loaded in memory.
   * Cached with TTL (10 minutes) or refreshed immediately if invalidated.
   */
  async ensureLoaded(db: D1Database, force: boolean = false, env?: any): Promise<void> {
    const now = Date.now();
    if (!force && this.lastLoadedTs > 0 && now - this.lastLoadedTs < 600000 && this.items.size > 0) {
      return;
    }

    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.loadPromise = (async () => {
      try {
        const model = new SystemListModel(db);

        // Auto-seed/register any configured system lists and preset filters from env
        if (env) {
          const configuredEntries = getSystemFilterEntries(env);
          for (const entry of configuredEntries) {
            await model.addSystemList(entry.url, entry.label);
          }

          // Cleanup obsolete system_lists in DB no longer present in configured entries
          if (configuredEntries.length > 0) {
            const configuredSet = new Set(configuredEntries.map((e) => e.url.trim().toLowerCase()));
            const currentDbLists = await model.getSystemLists();
            for (const cl of currentDbLists) {
              if (!configuredSet.has(cl.url.trim().toLowerCase())) {
                await db.prepare("DELETE FROM system_lists WHERE id = ?").bind(cl.id).run().catch(() => {});
                // Reset sync state for existing profile list rows so they immediately re-download as fresh custom lists
                await db.prepare("UPDATE lists SET etag = NULL, last_modified = NULL, last_synced_at = NULL WHERE url = ?").bind(cl.url).run().catch(() => {});
              }
            }
          }
        }

        const lists = await model.getSystemLists();
        const newItems = new Map<number, SystemListCacheItem>();
        const newUrlToId = new Map<string, number>();

        for (const list of lists) {
          newUrlToId.set(list.url, list.id);

          const existing = this.items.get(list.id);
          // 以「内容版本」而不是 last_synced_at 判断是否需要重载：
          // 304 Not Modified 也会刷新 last_synced_at，但内容没变，不应触发 inflate + JSON.parse + 正则重编译。
          // force 只绕过 TTL（见上方），不再强制重载每一个列表（否则 K 个列表变更 => O(N*K) 次全量重载）。
          const contentStamp = await model.getContentStamp(list.id);

          if (existing && existing.updatedAt === contentStamp) {
            newItems.set(list.id, existing.name === (list.name || null) ? existing : { ...existing, name: list.name || null });
            continue;
          }

          let loadFailed = false;

          let bloom: BloomFilter | null = null;
          let adguard: AdGuardProfileEngine | null = null;

          try {
            const bloomBuf = await model.getSystemListBloom(list.id);
            if (bloomBuf) {
              bloom = BloomFilter.fromUint8Array(new Uint8Array(bloomBuf));
              if (bloom.isEmpty()) {
                bloom = null;
              }
            }
          } catch (e) {
            loadFailed = true;
            console.error(`[SystemListsManager] Failed to load Bloom for system list #${list.id}:`, e);
          }

          try {
            const adguardPayload = await model.getSystemListAdguard(list.id);
            if (adguardPayload) {
              adguard = new AdGuardProfileEngine(adguardPayload);
            }
          } catch (e) {
            loadFailed = true;
            console.error(`[SystemListsManager] Failed to load AdGuard rules for system list #${list.id}:`, e);
          }

          newItems.set(list.id, {
            id: list.id,
            url: list.url,
            name: list.name || null,
            bloom,
            adguard,
            // -1: 加载失败的条目不会被复用，下一次 ensureLoaded 会重试
            updatedAt: loadFailed ? -1 : contentStamp
          });
        }

        this.items = newItems;
        this.urlToId = newUrlToId;
        this.lastLoadedTs = Date.now();
      } catch (err) {
        console.error("[SystemListsManager] Failed to load system lists:", err);
      } finally {
        this.loadPromise = null;
      }
    })();

    return this.loadPromise;
  }
}

export const systemListsManager = new SystemListsManager();

