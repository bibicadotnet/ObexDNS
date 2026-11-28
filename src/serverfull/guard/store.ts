/**
 * @file store.ts
 * @description Runtime state of the guard: per-IP Map (two independent token buckets + penalty),
 * bounded eviction, idle cleanup, and the swap-able range tables. All times are milliseconds.
 */

import type { GuardConfig, GuardEntry } from './types';
import { mergeRangeArrays } from './ip';
import { createPacer, type Pacer } from './pace';

export interface GuardState {
  cfg: GuardConfig | null;
  /** True once initGuard has run with at least one switch on. */
  active: boolean;
  /** Per-IP entries, key = uint32. Insertion order is used for eviction. */
  map: Map<number, GuardEntry>;
  /** Merged ranges per country code. */
  geo: Map<string, Uint32Array>;
  /** True when the geo filter is on AND every configured country has a valid list. */
  geoActive: boolean;
  /** ALLOWLIST_IPS (env). */
  envAllow: Uint32Array;
  /** Downloaded ALLOWLIST_URLS (DB). */
  urlAllow: Uint32Array;
  /** envAllow ∪ urlAllow. */
  allow: Uint32Array;
  /** Epoch ms. 0 = sync as soon as possible, Infinity = nothing to sync. */
  nextSyncAt: number;
  /** Countries whose saved list was built from different GUARD_GEO_SOURCES than the current config. */
  sourcesChanged: Set<string>;
}

export const state: GuardState = {
  cfg: null,
  active: false,
  map: new Map(),
  geo: new Map(),
  geoActive: false,
  envAllow: new Uint32Array(0),
  urlAllow: new Uint32Array(0),
  allow: new Uint32Array(0),
  nextSyncAt: 0,
  sourcesChanged: new Set()
};

/** Clears everything (used on init and by tests). */
export function resetState(): void {
  state.cfg = null;
  state.active = false;
  state.map = new Map();
  state.geo = new Map();
  state.geoActive = false;
  state.envAllow = new Uint32Array(0);
  state.urlAllow = new Uint32Array(0);
  state.allow = new Uint32Array(0);
  state.nextSyncAt = 0;
  state.sourcesChanged = new Set();
}

/** Recomputes `allow` after envAllow or urlAllow changed. */
export function rebuildAllowlist(): void {
  state.allow = mergeRangeArrays([state.envAllow, state.urlAllow]);
}

/** Recomputes `geoActive`: filter on, at least one country, and every country has a list. */
export function recomputeGeoActive(): void {
  const cfg = state.cfg;
  state.geoActive = !!cfg && cfg.enableGeo && cfg.countries.length > 0 && cfg.countries.every((cc) => state.geo.has(cc));
}

/** A fresh pacer for one CPU-bound phase (create it right before the phase starts). */
export function newPacer(): Pacer {
  const cfg = state.cfg;
  return createPacer(cfg ? cfg.yieldSliceMs : 2, cfg ? cfg.yieldSleepMs : 10);
}

/** 28983 -> "28,983". Plain string work on purpose: the first toLocaleString() call initialises ICU and costs ~10 ms. */
export function fmtCount(n: number): string {
  const [int, frac] = String(n).split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
}

/** 86400000 -> "24h", 1800000 -> "30 min". */
export function fmtDuration(ms: number): string {
  if (ms >= 3600_000) return `${Number((ms / 3600_000).toFixed(2))}h`;
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}

/** "VN=1,669, SG=8,459" (a country without a list shows "missing"). */
export function geoBreakdown(sep: string = '='): string {
  const cfg = state.cfg;
  if (!cfg) return '';
  return cfg.countries.map((cc) => {
    const arr = state.geo.get(cc);
    return `${cc}${sep}${arr ? fmtCount(arr.length >>> 1) : 'missing'}`;
  }).join(', ');
}

/** Sum of the per-country range counts. */
export function geoTotalRanges(): number {
  let total = 0;
  for (const arr of state.geo.values()) total += arr.length >>> 1;
  return total;
}

/** "104 ranges (env=1, urls=103)": the total is after merging, so it can be below env + urls. */
export function allowlistSummary(): string {
  return `${fmtCount(state.allow.length >>> 1)} ranges (env=${fmtCount(state.envAllow.length >>> 1)}, urls=${fmtCount(state.urlAllow.length >>> 1)})`;
}

/** elapsed < 0 counts as 0; tokens never exceed the burst. */
export function refill(tokens: number, last: number, now: number, ratePerSec: number, burst: number): number {
  const elapsed = now - last;
  return Math.min(burst, tokens + (elapsed > 0 ? elapsed : 0) / 1000 * ratePerSec);
}

/**
 * Frees room in one pass instead of one entry per call: deleting the first key of a Map over and over makes every
 * following keys().next() walk past more tombstones, which gets slow when new IPs keep arriving at the cap.
 * Drops about 1 % of the cap from the front (oldest first). Entries still under penalty are rotated to the back
 * instead of being forgotten. If everything scanned is penalised, the first one is dropped so the hard cap holds.
 */
function evictBatch(map: Map<number, GuardEntry>, now: number, maxEntries: number): void {
  const target = Math.max(1, Math.floor(maxEntries / 100));
  const scanLimit = target * 4;
  const drop: number[] = [];
  const rotate: Array<[number, GuardEntry]> = [];
  let scanned = 0;
  for (const [key, entry] of map) {
    if (drop.length >= target || scanned >= scanLimit) break;
    scanned++;
    if (entry.penaltyUntil > now) rotate.push([key, entry]);
    else drop.push(key);
  }
  if (drop.length === 0 && rotate.length > 0) {
    // Everything scanned is penalised: forget the oldest one, keep the rest.
    map.delete(rotate[0][0]);
    rotate.shift();
  }
  for (const key of drop) map.delete(key);
  for (const [key, entry] of rotate) {
    map.delete(key);
    map.set(key, entry);
  }
}

/** Returns the entry for `ip`, creating it (full buckets) and evicting if the Map is at its hard cap. */
export function getOrCreateEntry(ip: number, now: number): GuardEntry {
  const cfg = state.cfg!;
  const existing = state.map.get(ip);
  if (existing) {
    existing.lastSeen = now;
    return existing;
  }
  if (state.map.size >= cfg.maxEntries) evictBatch(state.map, now, cfg.maxEntries);
  const entry: GuardEntry = {
    tokConn: cfg.burstTcp,
    tConn: now,
    tokReq: cfg.burstReq,
    tReq: now,
    penaltyUntil: 0,
    lastSeen: now
  };
  state.map.set(ip, entry);
  return entry;
}

let cleaning = false;

/**
 * Removes entries idle for longer than the TTL that are no longer penalised.
 * Sweeps in CPU slices (rests when `pace` says so) because a full Map has up to 100,000 entries.
 * Map iterators are live, so entries added or evicted while it rests are handled safely.
 */
export async function cleanupEntries(now: number, pace?: Pacer): Promise<number> {
  const cfg = state.cfg;
  if (!cfg || cleaning) return 0;
  cleaning = true;
  try {
    const cutoff = now - cfg.idleTtlSec * 1000;
    let removed = 0;
    let n = 0;
    for (const [key, entry] of state.map) {
      if (entry.lastSeen < cutoff && entry.penaltyUntil < now) {
        state.map.delete(key);
        removed++;
      }
      if (pace && (++n & 255) === 0 && pace.due()) await pace.rest();
    }
    return removed;
  } finally {
    cleaning = false;
  }
}
