/**
 * @file customListsManager.ts
 * @description In-memory manager and LRU cache for user-defined custom subscription lists.
 * Caches individual custom lists by listId using ByteCappedMap, storing both the
 * FingerprintSet filter and AdGuard engine in a single entry to prevent split eviction.
 */

import { D1Database } from "@cloudflare/workers-types";
import { ListFilterModel } from "../../models/listFilter";
import { AdguardRulesModel } from "../../models/adguardRules";
import { FingerprintSet } from "../../utils/fingerprintSet";
import { AdGuardProfileEngine, AdGuardPayload } from "../adguard";
import { ByteCappedMap } from "../../pipeline/cache";

export interface CustomListEntry {
  filter: FingerprintSet;
  engine: AdGuardProfileEngine | null;
  byteLength: number;
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
  private cache: ByteCappedMap<number, CustomListEntry>;
  private inFlightLoads: Map<number, Promise<void>> = new Map();
  private generations: Map<number, number> = new Map();
  private dbErrorBackoffs: Map<number, number> = new Map();
  private ttlMs: number = 0; // 0 = no time expiration by default, managed by ByteCappedMap LRU and invalidation
  private lastEnv: any = null;

  constructor() {
    const memBytes = getEnvNumber("FILTER_MEM_BYTES", getEnvNumber("BLOOM_MEM_BYTES", 32 * 1024 * 1024));
    this.cache = new ByteCappedMap<number, CustomListEntry>(memBytes);
    const ttlSec = getEnvNumber("FILTER_MEM_TTL", getEnvNumber("BLOOM_MEM_TTL", 0));
    this.ttlMs = ttlSec > 0 ? ttlSec * 1000 : 0;
  }

  /**
   * Initializes or updates memory limits and TTL from environment variables (Cloudflare or Serverfull).
   */
  initFromEnv(env: any): void {
    if (!env || env === this.lastEnv) return;
    this.lastEnv = env;
    const memBytes = Number(env.FILTER_MEM_BYTES) || Number(env.BLOOM_MEM_BYTES);
    if (Number.isFinite(memBytes) && memBytes > 0) {
      this.cache.setMaxBytes(memBytes);
    }
    const rawTtl = env.FILTER_MEM_TTL ?? env.BLOOM_MEM_TTL;
    if (rawTtl !== undefined && rawTtl !== '') {
      const ttlSec = Number(rawTtl);
      this.ttlMs = Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec * 1000 : 0;
    }
  }

  getEntry(listId: number): CustomListEntry | null {
    const entry = this.cache.get(listId);
    if (!entry) return null;
    if (this.ttlMs > 0 && Date.now() - entry.ts > this.ttlMs) {
      this.cache.delete(listId);
      return null;
    }
    return entry;
  }

  getFilter(listId: number): FingerprintSet | null {
    return this.getEntry(listId)?.filter || null;
  }

  getAdguard(listId: number): AdGuardProfileEngine | null {
    return this.getEntry(listId)?.engine || null;
  }

  hasFilter(listId: number): boolean {
    return this.getEntry(listId) !== null;
  }

  invalidate(listId: number): void {
    this.generations.set(listId, (this.generations.get(listId) || 0) + 1);
    this.dbErrorBackoffs.delete(listId);
    this.cache.delete(listId);
  }

  clear(): void {
    this.generations.clear();
    this.dbErrorBackoffs.clear();
    this.cache.clear();
  }

  /**
   * Loads a custom list's filter and AdGuard rules from DB into unified memory cache.
   */
  async loadList(listId: number, db: D1Database): Promise<void> {
    if (this.hasFilter(listId)) {
      return;
    }

    const backoffUntil = this.dbErrorBackoffs.get(listId);
    if (backoffUntil && Date.now() < backoffUntil) {
      return;
    }

    const inFlight = this.inFlightLoads.get(listId);
    if (inFlight) {
      return inFlight;
    }

    const loadPromise = (async () => {
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const currentGen = (this.generations.get(listId) || 0) + 1;
          this.generations.set(listId, currentGen);

          const listFilterModel = new ListFilterModel(db);
          const adguardRulesModel = new AdguardRulesModel(db);

          let filterBuf: ArrayBuffer | null = null;
          let rulesPayload: AdGuardPayload | null = null;
          let dbFailed = false;

          try {
            const [fRes, rRes] = await Promise.all([
              listFilterModel.getListFilter(listId),
              adguardRulesModel.getListRules(listId)
            ]);
            filterBuf = fRes;
            rulesPayload = rRes;
          } catch (dbErr: any) {
            dbFailed = true;
            console.warn(`[CustomListsManager] Failed to read database for list #${listId} (skipping cache):`, dbErr?.message || dbErr);
          }

          // Check if load was invalidated while waiting for DB I/O
          if (this.generations.get(listId) !== currentGen) {
            if (attempt === 0) {
              // Retry once so the current query gets the latest data rather than skipping
              continue;
            }
            return;
          }

          // Transient DB error: do NOT negative-cache, apply short backoff (15s) so queries aren't blocked
          if (dbFailed) {
            this.dbErrorBackoffs.set(listId, Date.now() + 15000);
            return;
          }

          // Successful DB read: clear any previous error backoff
          this.dbErrorBackoffs.delete(listId);

          let filter: FingerprintSet | null = null;
          let byteLength = 0;

          if (filterBuf && FingerprintSet.isCurrentVersion(filterBuf)) {
            try {
              filter = FingerprintSet.fromUint8Array(new Uint8Array(filterBuf));
              byteLength = filter.byteLength;
            } catch (e: any) {
              console.warn(`[CustomListsManager] Failed to deserialize filter for list #${listId}:`, e?.message || e);
            }
          }

          // Negative caching: if DB query succeeded but returned no domain filter,
          // use an empty FingerprintSet (0 byteLength) so we don't spam SQLite on every DNS packet
          if (!filter) {
            filter = new FingerprintSet(new BigUint64Array(0));
            byteLength = 0;
          }

          let engine: AdGuardProfileEngine | null = null;
          if (rulesPayload) {
            try {
              engine = new AdGuardProfileEngine(rulesPayload);
              // Account for AdGuard rule memory in byteLength:
              // ~250B per exception, ~200B per rewrite, ~300B per regex pattern
              const exceptionsBytes = (rulesPayload.exceptions?.length || 0) * 250;
              const rewritesBytes = Object.keys(rulesPayload.rewrites || {}).length * 200;
              const patternsBytes = (rulesPayload.patterns?.length || 0) * 300;
              byteLength += (exceptionsBytes + rewritesBytes + patternsBytes);
            } catch (e: any) {
              console.warn(`[CustomListsManager] Failed to instantiate AdGuard engine for list #${listId}:`, e?.message || e);
            }
          }

          this.cache.set(listId, {
            filter,
            engine,
            byteLength,
            ts: Date.now()
          });
          break;
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
    const missing = listIds.filter(id => !this.hasFilter(id));
    if (missing.length === 0) return;

    await Promise.all(missing.map(id => this.loadList(id, db)));
  }
}

export const customListsManager = new CustomListsManager();
