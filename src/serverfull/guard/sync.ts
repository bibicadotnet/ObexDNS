/**
 * @file sync.ts
 * @description Downloads country IP lists and the allowlist, validates them, persists them in system_settings
 * (base64 of the merged Uint32Array) and swaps the in-memory tables. No `node:*` imports.
 */

import type { Env } from '../../types';
import { SystemSettingsModel } from '../../models/systemSettings';
import { decodeRanges, encodeRangesPaced, mergeRangeArraysPaced, mergeRangesPaced, parseRangeLinesPaced, rangeCount } from './ip';
import {
  allowlistSummary, fmtCount, fmtDuration, geoBreakdown, geoTotalRanges, newPacer, rebuildAllowlist, recomputeGeoActive, state
} from './store';

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

/**
 * Downloads one list. Throws on network error, timeout or a non-2xx status.
 * 404 / 410 mean "this source has nothing for this country (or the URL is gone)": returned as `missing`, not as a failure,
 * otherwise a dead URL would keep every sync "incomplete" forever.
 */
async function fetchList(url: string, timeoutMs: number): Promise<{ pairs: Array<[number, number]>; missing: boolean }> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'DNS-Worker/1.0' }
  });
  if (res.status === 404 || res.status === 410) return { pairs: [], missing: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return { pairs: await parseRangeLinesPaced(text, newPacer()), missing: false };
}

/**
 * Downloads every URL in parallel. `merged` is what the sources really delivered; `failed` are transient failures
 * (the list may be incomplete); `missing` are 404 / 410 answers (warned about, not counted as failures).
 */
async function fetchAndMerge(urls: string[], timeoutMs: number): Promise<{ merged: Uint32Array; failed: string[]; missing: string[] }> {
  const results = await Promise.allSettled(urls.map((u) => fetchList(u, timeoutMs)));
  const chunks: Array<Array<[number, number]>> = [];
  const failed: string[] = [];
  const missing: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      if (r.value.missing) {
        missing.push(urls[i]);
        console.warn(`[Guard] ${urls[i]} answered 404/410: no data from this source (check GUARD_GEO_SOURCES / ALLOWLIST_URLS if the URL was removed).`);
      }
      chunks.push(r.value.pairs);
    } else {
      failed.push(urls[i]);
      console.warn(`[Guard] Failed to fetch ${urls[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  });
  // concat copies natively; pushing 100k+ pairs one by one would hold the event loop for several ms
  const pairs = ([] as Array<[number, number]>).concat(...chunks);
  return { merged: await mergeRangesPaced(pairs, newPacer()), failed, missing };
}

/** Outcome of one item. `partial` = the new list was applied but some sources failed, so it is retried soon. */
type ItemResult = { status: 'ok' } | { status: 'partial'; detail: string } | { status: 'rejected'; detail: string };

/** Syncs one country. */
async function syncCountry(cc: string, settings: SystemSettingsModel): Promise<ItemResult> {
  const cfg = state.cfg!;
  try {
    const urls = cfg.geoSources.map((t) => buildSourceUrl(t, cc));
    const fetched = await fetchAndMerge(urls, cfg.fetchTimeoutMs);
    const current = state.geo.get(cc);
    // A source that failed transiently may be the one carrying part of this country. Never let that shrink the list:
    // keep everything already known (union) and retry soon.
    const partial = fetched.failed.length > 0;
    const merged = partial && current ? await mergeRangeArraysPaced([fetched.merged, current], newPacer()) : fetched.merged;
    const count = rangeCount(merged);
    const downloaded = rangeCount(fetched.merged); // what the sources really delivered (a union is not a download)
    const currentCount = rangeCount(current);

    // The ratio compares against the previous list: meaningless when the sources themselves were changed,
    // and unnecessary after a partial fetch (the union is never smaller than the current list).
    const checkRatio = !!current && !partial && !state.sourcesChanged.has(cc);
    if (downloaded < cfg.minRanges || (checkRatio && count < cfg.minRangesRatio * currentCount)) {
      console.warn(`[Guard] Rejected ${cc} list (${downloaded} ranges; min ${cfg.minRanges}${checkRatio ? `, current ${currentCount} x ratio ${cfg.minRangesRatio}` : ''}). Keeping the previous version.`);
      return {
        status: 'rejected',
        detail: downloaded < cfg.minRanges
          ? `rejected: ${fmtCount(downloaded)} ranges < min ${fmtCount(cfg.minRanges)}`
          : `rejected: ${fmtCount(count)} ranges < ${cfg.minRangesRatio} x current ${fmtCount(currentCount)}`
      };
    }

    const values: Record<string, string> = {
      [geoKey(cc)]: await encodeRangesPaced(merged, newPacer()),
      [geoUpdatedKey(cc)]: String(Math.floor(Date.now() / 1000))
    };
    // Only a complete download proves the list matches the configured sources.
    if (!partial) values[geoSourcesKey(cc)] = sourcesSignature(cfg.geoSources);
    await settings.setMany(values);
    if (!partial) state.sourcesChanged.delete(cc);
    state.geo.set(cc, merged);
    recomputeGeoActive();
    console.log(`[Guard] Synced ${cc}: ${fmtCount(count)} ranges${partial ? ` (incomplete: ${fetched.failed.length}/${urls.length} sources failed, kept known ranges)` : ''}`);
    return partial
      ? { status: 'partial', detail: `${fetched.failed.length}/${urls.length} sources failed` }
      : { status: 'ok' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Guard] Sync ${cc} failed, keeping the previous version:`, msg);
    return { status: 'rejected', detail: `error: ${msg}` };
  }
}

/** Same rules as syncCountry: an unreachable URL must not silently drop the IPs it provided. */
async function syncAllowlist(settings: SystemSettingsModel): Promise<ItemResult> {
  const cfg = state.cfg!;
  try {
    const fetched = await fetchAndMerge(cfg.allowlistUrls, cfg.fetchTimeoutMs);
    const partial = fetched.failed.length > 0;
    const merged = partial ? await mergeRangeArraysPaced([fetched.merged, state.urlAllow], newPacer()) : fetched.merged;
    const count = rangeCount(merged);
    if (rangeCount(fetched.merged) < 1) {
      console.warn('[Guard] Allowlist download produced no ranges. Keeping the previous version.');
      return { status: 'rejected', detail: 'rejected: download produced no ranges' };
    }
    const values: Record<string, string> = {
      [ALLOWLIST_KEY]: await encodeRangesPaced(merged, newPacer()),
      [ALLOWLIST_UPDATED_KEY]: String(Math.floor(Date.now() / 1000))
    };
    if (!partial) values[ALLOWLIST_URLS_KEY] = sourcesSignature(cfg.allowlistUrls);
    await settings.setMany(values);
    state.urlAllow = merged;
    rebuildAllowlist();
    console.log(`[Guard] Synced allowlist: ${fmtCount(count)} ranges${partial ? ` (incomplete: ${fetched.failed.length}/${cfg.allowlistUrls.length} URLs failed, kept known ranges)` : ''}`);
    return partial
      ? { status: 'partial', detail: `${fetched.failed.length}/${cfg.allowlistUrls.length} URLs failed` }
      : { status: 'ok' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[Guard] Allowlist sync failed, keeping the previous version:', msg);
    return { status: 'rejected', detail: `error: ${msg}` };
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
    const failures: string[] = [];
    let items = 0;

    if (cfg.enableGeo) {
      for (const cc of cfg.countries) {
        items++;
        const r = await syncCountry(cc, settings);
        if (r.status === 'rejected') failures.push(`${cc} kept previous list (${r.detail})`);
        else if (r.status === 'partial') failures.push(`${cc} incomplete (${r.detail}; known ranges kept)`);
      }
    }
    if (cfg.allowlistUrls.length > 0) {
      items++;
      const r = await syncAllowlist(settings);
      if (r.status === 'rejected') failures.push(`allowlist kept previous list (${r.detail})`);
      else if (r.status === 'partial') failures.push(`allowlist incomplete (${r.detail}; known ranges kept)`);
    }

    if (items === 0) {
      state.nextSyncAt = Infinity;
      return;
    }
    const delay = failures.length === 0 ? cfg.syncIntervalHours * 3600 * 1000 : cfg.syncRetryMinutes * 60 * 1000;
    state.nextSyncAt = Date.now() + delay;

    // One closing line with what is actually in use now.
    const parts: string[] = [];
    if (cfg.enableGeo) parts.push(`${fmtCount(geoTotalRanges())} geo ranges active (${geoBreakdown(': ')})`);
    if (cfg.allowlistUrls.length > 0) parts.push(`allowlist: ${allowlistSummary()}`);
    if (failures.length === 0) {
      console.log(`[Guard] Sync complete: ${parts.join(', ')}. Next sync in ${fmtDuration(delay)}.`);
    } else {
      console.warn(`[Guard] Sync finished with errors: ${failures.join('; ')}. Retry in ${fmtDuration(delay)}. In use: ${parts.join(', ')}.`);
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
