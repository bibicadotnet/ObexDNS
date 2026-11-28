/**
 * @file sync.ts
 * @description Downloads country IP lists and the allowlist, validates them, persists them in system_settings
 * (base64 of the merged Uint32Array) and swaps the in-memory tables. No `node:*` imports.
 */

import type { Env } from '../../types';
import { SystemSettingsModel } from '../../models/systemSettings';
import { decodeRanges, encodeRanges, mergeRanges, parseRangeLines, rangeCount } from './ip';
import { rebuildAllowlist, recomputeGeoActive, state } from './store';

let isSyncing = false;

/** True while a sync is running (used by tests). */
export function isSyncRunning(): boolean {
  return isSyncing;
}

export const geoKey = (cc: string): string => `guard:geo:${cc}`;
export const geoUpdatedKey = (cc: string): string => `guard:geo:${cc}:updated_at`;
export const ALLOWLIST_KEY = 'guard:allowlist';
export const ALLOWLIST_UPDATED_KEY = 'guard:allowlist:updated_at';
/** The source lists a saved list was built from, so a changed config is noticed at boot. */
export const geoSourcesKey = (cc: string): string => `guard:geo:${cc}:sources`;
export const ALLOWLIST_URLS_KEY = 'guard:allowlist:urls';

/** Order- and whitespace-insensitive signature of a source list (stored in the DB next to the data it produced). */
export function sourcesSignature(list: readonly string[]): string {
  return list.map((s) => s.trim()).filter(Boolean).sort().join('\n');
}

/** Replaces {cc} (lower-case) and {CC} (upper-case) in a source template. */
export function buildSourceUrl(template: string, cc: string): string {
  return template.split('{cc}').join(cc.toLowerCase()).split('{CC}').join(cc.toUpperCase());
}

/** Downloads one list. Throws on network error, timeout or a non-2xx status. */
async function fetchList(url: string, timeoutMs: number): Promise<Array<[number, number]>> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'DNS-Worker/1.0' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseRangeLines(await res.text());
}

/** Downloads every URL in parallel and returns the merged ranges plus the failed URLs. */
async function fetchAndMerge(urls: string[], timeoutMs: number): Promise<{ merged: Uint32Array; failed: string[] }> {
  const results = await Promise.allSettled(urls.map((u) => fetchList(u, timeoutMs)));
  const pairs: Array<[number, number]> = [];
  const failed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const p of r.value) pairs.push(p);
    } else {
      failed.push(urls[i]);
      console.warn(`[Guard] Failed to fetch ${urls[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  });
  return { merged: mergeRanges(pairs), failed };
}

/** Syncs one country. Returns true when accepted (or nothing needed changing), false on error / rejection. */
async function syncCountry(cc: string, settings: SystemSettingsModel): Promise<boolean> {
  const cfg = state.cfg!;
  try {
    const urls = cfg.geoSources.map((t) => buildSourceUrl(t, cc));
    const { merged } = await fetchAndMerge(urls, cfg.fetchTimeoutMs);
    const count = rangeCount(merged);
    const current = state.geo.get(cc);
    const currentCount = rangeCount(current);

    // The ratio compares against the previous list; it is meaningless when the sources themselves were changed.
    const checkRatio = !!current && !state.sourcesChanged.has(cc);
    if (count < cfg.minRanges || (checkRatio && count < cfg.minRangesRatio * currentCount)) {
      console.warn(`[Guard] Rejected ${cc} list (${count} ranges; min ${cfg.minRanges}${checkRatio ? `, current ${currentCount} x ratio ${cfg.minRangesRatio}` : ''}). Keeping the previous version.`);
      return false;
    }

    await settings.setMany({
      [geoKey(cc)]: encodeRanges(merged),
      [geoUpdatedKey(cc)]: String(Math.floor(Date.now() / 1000)),
      [geoSourcesKey(cc)]: sourcesSignature(cfg.geoSources)
    });
    state.sourcesChanged.delete(cc);
    state.geo.set(cc, merged);
    recomputeGeoActive();
    console.log(`[Guard] Synced ${cc}: ${count} ranges`);
    return true;
  } catch (err) {
    console.warn(`[Guard] Sync ${cc} failed, keeping the previous version:`, err instanceof Error ? err.message : err);
    return false;
  }
}

async function syncAllowlist(settings: SystemSettingsModel): Promise<boolean> {
  const cfg = state.cfg!;
  try {
    const { merged } = await fetchAndMerge(cfg.allowlistUrls, cfg.fetchTimeoutMs);
    const count = rangeCount(merged);
    if (count < 1) {
      console.warn('[Guard] Allowlist download produced no ranges. Keeping the previous version.');
      return false;
    }
    await settings.setMany({
      [ALLOWLIST_KEY]: encodeRanges(merged),
      [ALLOWLIST_UPDATED_KEY]: String(Math.floor(Date.now() / 1000)),
      [ALLOWLIST_URLS_KEY]: sourcesSignature(cfg.allowlistUrls)
    });
    state.urlAllow = merged;
    rebuildAllowlist();
    console.log(`[Guard] Synced allowlist: ${count} ranges`);
    return true;
  } catch (err) {
    console.warn('[Guard] Allowlist sync failed, keeping the previous version:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Runs one full sync (countries, then allowlist). Shared by the boot background sync and guardTick.
 * Overlapping calls return immediately. Each item is independent: a failed one keeps its old data.
 */
export async function runSync(env: Env): Promise<void> {
  if (isSyncing) return;
  isSyncing = true;
  try {
    const cfg = state.cfg;
    if (!cfg) return;
    const settings = new SystemSettingsModel(env.DB);
    let allOk = true;
    let items = 0;

    if (cfg.enableGeo) {
      for (const cc of cfg.countries) {
        items++;
        if (!(await syncCountry(cc, settings))) allOk = false;
      }
    }
    if (cfg.allowlistUrls.length > 0) {
      items++;
      if (!(await syncAllowlist(settings))) allOk = false;
    }

    if (items === 0) {
      state.nextSyncAt = Infinity;
    } else {
      const delay = allOk ? cfg.syncIntervalHours * 3600 * 1000 : cfg.syncRetryMinutes * 60 * 1000;
      state.nextSyncAt = Date.now() + delay;
    }
  } catch (err) {
    console.error('[Guard] Sync crashed:', err);
    const cfg = state.cfg;
    if (cfg) state.nextSyncAt = Date.now() + cfg.syncRetryMinutes * 60 * 1000;
  } finally {
    isSyncing = false;
  }
}

/** Loads one range list from system_settings. Null when missing or malformed. */
export async function loadRanges(settings: SystemSettingsModel, key: string): Promise<Uint32Array | null> {
  try {
    const raw = await settings.get(key);
    if (!raw) return null;
    const arr = decodeRanges(raw);
    if (!arr) console.warn(`[Guard] ${key} in the database is malformed, ignoring it.`);
    return arr;
  } catch (err) {
    console.warn(`[Guard] Could not read ${key}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Reads a timestamp in SECONDS from system_settings. Null when missing / invalid. */
export async function loadUpdatedAtSec(settings: SystemSettingsModel, key: string): Promise<number | null> {
  try {
    const raw = await settings.get(key);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
