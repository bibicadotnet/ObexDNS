/**
 * @file store.ts
 * @description Runtime state of the guard: per-IP Map (two independent token buckets + penalty),
 * bounded eviction, idle cleanup, and the swap-able range tables. All times are milliseconds.
 */

import type { GuardConfig, GuardEntry } from './types';
import { mergeRangeArrays } from './ip';

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
  nextSyncAt: 0
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

/** elapsed < 0 counts as 0; tokens never exceed the burst. */
export function refill(tokens: number, last: number, now: number, ratePerSec: number, burst: number): number {
  const elapsed = now - last;
  return Math.min(burst, tokens + (elapsed > 0 ? elapsed : 0) / 1000 * ratePerSec);
}

function evictOne(map: Map<number, GuardEntry>, now: number): void {
  for (let i = 0; i < 16; i++) {
    const first = map.keys().next();
    if (first.done) return;
    const key = first.value;
    const entry = map.get(key)!;
    if (entry.penaltyUntil > now) {
      // Still being punished: rotate to the back instead of forgetting it.
      map.delete(key);
      map.set(key, entry);
    } else {
      map.delete(key);
      return;
    }
  }
  // 16 in a row were penalised: drop the current first key to stay under the hard cap.
  const first = map.keys().next();
  if (!first.done) map.delete(first.value);
}

/** Returns the entry for `ip`, creating it (full buckets) and evicting if the Map is at its hard cap. */
export function getOrCreateEntry(ip: number, now: number): GuardEntry {
  const cfg = state.cfg!;
  const existing = state.map.get(ip);
  if (existing) {
    existing.lastSeen = now;
    return existing;
  }
  if (state.map.size >= cfg.maxEntries) evictOne(state.map, now);
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

/** Removes entries idle for longer than the TTL that are no longer penalised. */
export function cleanupEntries(now: number): number {
  const cfg = state.cfg;
  if (!cfg) return 0;
  const cutoff = now - cfg.idleTtlSec * 1000;
  let removed = 0;
  for (const [key, entry] of state.map) {
    if (entry.lastSeen < cutoff && entry.penaltyUntil < now) {
      state.map.delete(key);
      removed++;
    }
  }
  return removed;
}
