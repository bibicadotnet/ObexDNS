/**
 * @file systemListSync.ts
 * @description Synchronization engine for system-wide shared filter lists.
 * Downloads and compiles shared external filter lists once globally, eliminating redundant
 * per-profile downloads and filter duplication.
 */

import { Env } from "../../types";
import { SystemListModel } from "../../models/systemList";
import { FingerprintSet } from "../fingerprintSet";
import { getListFetchTuning } from "../listFetcher";
import { runListParse } from "./listParseClient";
import { encodeLimitWarnings, keepLimitWarning, ListLimitKind } from "./syncWarnings";
import { systemListsManager } from "../../lib/filtering/systemListsManager";
import { pipelineCache } from "../../pipeline/cache";

const DEFAULT_MAX_LIST_BYTES = 25 * 1024 * 1024; // 25 MB

export interface SystemListSyncResult {
  syncError: string | null;
  notModified: boolean;
}

/**
 * Synchronizes a single system-wide shared list.
 */
export async function syncSingleSystemList(
  systemListId: number,
  env: Env,
  force: boolean = false
): Promise<SystemListSyncResult> {
  const model = new SystemListModel(env.DB);
  const systemList = await model.getSystemListById(systemListId);
  if (!systemList) {
    return { syncError: `System list #${systemListId} not found`, notModified: false };
  }

  const now = Math.floor(Date.now() / 1000);
  const timeoutMs = Number(env.SYNC_TIMEOUT_MS) || 30000;
  const maxListDomains = Number(env.MAX_LIST_DOMAINS) || 500000;
  const maxListBytes = Number(env.MAX_LIST_BYTES) || DEFAULT_MAX_LIST_BYTES;
  const maxRegexRules = Number(env.MAX_REGEX_RULES) || 1000;

  const existingFilterHead = await model.getSystemListFilterHeader(systemListId);
  const hasExistingRules = await model.hasSystemListAdguardRules(systemListId);
  const hasLocalData = Boolean(existingFilterHead || hasExistingRules);
  const isFilterCurrent = existingFilterHead ? FingerprintSet.isCurrentVersion(existingFilterHead) : hasLocalData;
  const useCacheHeaders = !force && isFilterCurrent && Boolean(systemList.etag || systemList.last_modified) && systemList.description != null;

  // Download, parse, hash, sort and serialize run on a worker thread (inline fallback), never on the DNS thread.
  const parsed = await runListParse(
    {
      url: systemList.url,
      maxListBytes,
      timeoutMs,
      maxListDomains,
      maxRegexRules,
      ...(useCacheHeaders ? { etag: systemList.etag, lastModified: systemList.last_modified } : {}),
      tuning: getListFetchTuning(env)
    },
    env
  );
  const {
    fetchError, truncated, notModified, etag, lastModified, title, description,
    count, domainLimitHit, regexLimitHit, adguardPayload
  } = parsed;

  // 304 Not Modified
  if (notModified) {
    console.log(`[SystemListSync] System list #${systemListId} (${systemList.url}) 304 Not Modified.`);
    const keptWarning = keepLimitWarning(systemList.sync_error);
    await model.updateMetadata(systemListId, {
      last_synced_at: now,
      etag: etag ?? systemList.etag,
      last_modified: lastModified ?? systemList.last_modified,
      sync_error: keptWarning
    });

    await syncProfileListRows(env.DB, systemList.url, now, keptWarning);
    return { syncError: keptWarning, notModified: true };
  }

  let syncError: string | null = fetchError;
  if (!fetchError) {
    const limitHits: Partial<Record<ListLimitKind, number>> = {};
    if (truncated) limitHits.bytes = maxListBytes;
    if (domainLimitHit) limitHits.domains = maxListDomains;
    if (regexLimitHit) limitHits.regex = maxRegexRules;
    syncError = encodeLimitWarnings(limitHits);
    if (syncError) {
      console.warn(`[SystemListSync] System list #${systemListId} truncated with ${count} rules. Warning: ${syncError}`);
    }

    // The sorted fingerprint set was already built (and serialized) by the parse worker.
    const saveOps: Promise<any>[] = [
      model.upsertSystemListAdguard(systemListId, adguardPayload, now)
    ];
    if (parsed.filterBytes) {
      saveOps.push(model.upsertSystemListFilter(systemListId, parsed.filterBytes.buffer as ArrayBuffer, now));
    } else {
      saveOps.push(model.clearSystemListFilter(systemListId));
    }
    await Promise.all(saveOps);

    await model.updateMetadata(systemListId, {
      etag: etag || null,
      last_modified: lastModified || null,
      last_synced_at: now,
      sync_error: syncError,
      rule_count: count,
      description: description ?? ''
    });
    if (title) await model.setNameIfEmpty(systemListId, title);

    await syncProfileListRows(env.DB, systemList.url, now, syncError);

    systemListsManager.invalidate();
    await systemListsManager.ensureLoaded(env.DB, true);

    if (env?.DB) {
      try {
        const affected = await env.DB
          .prepare("SELECT DISTINCT profile_id FROM lists WHERE url = ? AND enabled = 1")
          .bind(systemList.url.trim())
          .all<{ profile_id: string }>();

        if (affected?.results && affected.results.length > 0) {
          const profileIds = affected.results.map((row) => row.profile_id);
          await pipelineCache.clearMany(profileIds, false, env);
          console.log(`[SystemListSync] Cleared pipeline cache for ${profileIds.length} profile(s) using system list #${systemListId}.`);
        }
      } catch (err) {
        console.warn("[SystemListSync] Failed to clear pipeline cache for affected profiles:", err);
      }
    }

    console.log(`[SystemListSync] Successfully updated system list #${systemListId} with ${count} rules.`);
  } else {
    console.warn(`[SystemListSync] Failed to fetch system list #${systemListId}: ${fetchError}`);
    await model.updateMetadata(systemListId, {
      last_synced_at: now,
      sync_error: fetchError
    });
    await syncProfileListRows(env.DB, systemList.url, now, fetchError);
  }

  return { syncError, notModified: false };
}

async function syncProfileListRows(
  db: any,
  url: string,
  now: number,
  syncError: string | null
): Promise<void> {
  if (!db) return;
  try {
    await db
      .prepare(
        "UPDATE lists SET last_synced_at = ?, sync_error = ? WHERE url = ?"
      )
      .bind(now, syncError, url.trim())
      .run();
  } catch (err) {
    console.warn("[SystemListSync] Failed to update matching profile list rows:", err);
  }
}

export async function syncAllSystemLists(env: Env, force: boolean = false, profileId?: string): Promise<void> {
  if (env?.DB) {
    await systemListsManager.ensureLoaded(env.DB, false, env);
  }
  const model = new SystemListModel(env.DB);
  const lists = await model.getSystemLists();

  const activeUrls = new Set<string>();
  if (env?.DB) {
    try {
      const activeRows = profileId
        ? await env.DB
            .prepare("SELECT DISTINCT url FROM lists WHERE enabled = 1 AND profile_id = ?")
            .bind(profileId)
            .all<{ url: string }>()
        : await env.DB
            .prepare("SELECT DISTINCT url FROM lists WHERE enabled = 1")
            .all<{ url: string }>();

      if (activeRows?.results) {
        for (const row of activeRows.results) {
          activeUrls.add(row.url.trim().toLowerCase());
        }
      }
    } catch (e) {
      console.warn("[SystemListSync] Could not check active profile lists:", e);
    }
  }

  for (const list of lists) {
    const listNorm = list.url.trim().toLowerCase();
    const isActiveInProfile = activeUrls.has(listNorm);

    if (!isActiveInProfile && (!force || profileId)) {
      continue;
    }

    try {
      await syncSingleSystemList(list.id, env, force);
    } catch (err) {
      console.error(`[SystemListSync] Error syncing system list #${list.id}:`, err);
    }
  }
}
