/**
 * @file systemListsManager.ts
 * @description In-memory manager and cache for system-wide shared filter lists, Blooms, and AdGuard rules.
 */

import { D1Database } from "@cloudflare/workers-types";
import { SystemListModel } from "../../models/systemList";
import { BloomFilter } from "../../utils/bloom";
import { AdGuardProfileEngine, AdGuardPayload } from "../adguard";

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
  async ensureLoaded(db: D1Database, force: boolean = false): Promise<void> {
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
        const lists = await model.getSystemLists();
        const newItems = new Map<number, SystemListCacheItem>();
        const newUrlToId = new Map<string, number>();

        for (const list of lists) {
          newUrlToId.set(list.url, list.id);

          const existing = this.items.get(list.id);
          const lastSync = list.last_synced_at || 0;

          // If already in memory and not modified since last load, preserve existing instances
          if (existing && existing.updatedAt === lastSync && !force) {
            newItems.set(list.id, existing);
            continue;
          }

          let bloom: BloomFilter | null = null;
          let adguard: AdGuardProfileEngine | null = null;

          try {
            const bloomBuf = await model.getSystemListBloom(list.id);
            if (bloomBuf) {
              bloom = BloomFilter.fromUint8Array(new Uint8Array(bloomBuf));
            }
          } catch (e) {
            console.error(`[SystemListsManager] Failed to load Bloom for system list #${list.id}:`, e);
          }

          try {
            const adguardPayload = await model.getSystemListAdguard(list.id);
            if (adguardPayload) {
              adguard = new AdGuardProfileEngine(adguardPayload);
            }
          } catch (e) {
            console.error(`[SystemListsManager] Failed to load AdGuard rules for system list #${list.id}:`, e);
          }

          newItems.set(list.id, {
            id: list.id,
            url: list.url,
            name: list.name || null,
            bloom,
            adguard,
            updatedAt: lastSync
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

