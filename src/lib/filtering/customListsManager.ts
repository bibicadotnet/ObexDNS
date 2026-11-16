/**
 * @file customListsManager.ts
 * @description In-memory manager and LRU cache for user-defined custom subscription lists.
 * Caches individual custom lists by listId using ByteCappedMap, avoiding the need to
 * merge lists per profile.
 */

import { D1Database } from "@cloudflare/workers-types";
import { ListFilterModel } from "../../models/listFilter";
import { AdguardRulesModel } from "../../models/adguardRules";
import { FingerprintSet } from "../../utils/fingerprintSet";
import { AdGuardProfileEngine } from "../adguard";
import { ByteCappedMap, SizeCappedMap } from "../../pipeline/cache";

export interface CustomListFilterEntry {
  filter: FingerprintSet;
  byteLength: number;
  ts: number;
}

export interface CustomListAdguardEntry {
  engine: AdGuardProfileEngine;
  ts: number;
}

function getEnvNumber(key: string, defaultVal: number): number {
  if (typeof process !== "undefined" && process?.env && process.env[key]) {
    const val = Number(process.env[key]);
    if (Number.isFinite(val) && val > 0) return val;
  }
  return defaultVal;
}

class CustomListsManager {
  private filterCache: ByteCappedMap<number, CustomListFilterEntry>;
  private adguardCache: SizeCappedMap<number, CustomListAdguardEntry>;
  private inFlightLoads: Map<number, Promise<void>> = new Map();

  constructor() {
    const memBytes = getEnvNumber("FILTER_MEM_BYTES", getEnvNumber("BLOOM_MEM_BYTES", 32 * 1024 * 1024));
    this.filterCache = new ByteCappedMap<number, CustomListFilterEntry>(memBytes);
    this.adguardCache = new SizeCappedMap<number, CustomListAdguardEntry>(100);
  }

  getFilter(listId: number): FingerprintSet | null {
    return this.filterCache.get(listId)?.filter || null;
  }

  getAdguard(listId: number): AdGuardProfileEngine | null {
    return this.adguardCache.get(listId)?.engine || null;
  }

  hasFilter(listId: number): boolean {
    return this.filterCache.has(listId);
  }

  invalidate(listId: number): void {
    this.filterCache.delete(listId);
    this.adguardCache.delete(listId);
  }

  clear(): void {
    this.filterCache.clear();
    this.adguardCache.clear();
  }

  /**
   * Loads a custom list's filter and AdGuard rules from DB into memory cache.
   */
  async loadList(listId: number, db: D1Database): Promise<void> {
    if (this.filterCache.has(listId)) {
      return;
    }

    const inFlight = this.inFlightLoads.get(listId);
    if (inFlight) {
      return inFlight;
    }

    const loadPromise = (async () => {
      try {
        const listFilterModel = new ListFilterModel(db);
        const adguardRulesModel = new AdguardRulesModel(db);

        const [filterBuf, rulesPayload] = await Promise.all([
          listFilterModel.getListFilter(listId).catch(() => null),
          adguardRulesModel.getListRules(listId).catch(() => null)
        ]);

        if (filterBuf && FingerprintSet.isCurrentVersion(filterBuf)) {
          try {
            const filter = FingerprintSet.fromUint8Array(new Uint8Array(filterBuf));
            this.filterCache.set(listId, {
              filter,
              byteLength: filter.byteLength,
              ts: Date.now()
            });
          } catch (e: any) {
            console.warn(`[CustomListsManager] Failed to deserialize filter for list #${listId}:`, e?.message || e);
          }
        }

        // Negative caching: nếu list không có domain rules hoặc filter rỗng/lỗi,
        // lưu một FingerprintSet rỗng (0 byte) để tránh lặp lại truy vấn SQLite trên mỗi query DNS.
        if (!this.filterCache.has(listId)) {
          this.filterCache.set(listId, {
            filter: new FingerprintSet(new BigUint64Array(0)),
            byteLength: 0,
            ts: Date.now()
          });
        }

        if (rulesPayload) {
          try {
            const engine = new AdGuardProfileEngine(rulesPayload);
            this.adguardCache.set(listId, {
              engine,
              ts: Date.now()
            });
          } catch (e: any) {
            console.warn(`[CustomListsManager] Failed to instantiate AdGuard engine for list #${listId}:`, e?.message || e);
          }
        }
      } finally {
        this.inFlightLoads.delete(listId);
      }
    })();

    this.inFlightLoads.set(listId, loadPromise);
    return loadPromise;
  }

  /**
   * Ensures that the specified custom lists are loaded in RAM.
   */
  async ensureLoaded(listIds: number[], db: D1Database): Promise<void> {
    if (!listIds || listIds.length === 0) return;
    const missing = listIds.filter(id => !this.filterCache.has(id));
    if (missing.length === 0) return;

    await Promise.all(missing.map(id => this.loadList(id, db)));
  }
}

export const customListsManager = new CustomListsManager();
