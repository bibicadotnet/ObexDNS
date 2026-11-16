/**
 * @file systemListSync.ts
 * @description Synchronization engine for system-wide shared filter lists.
 * Downloads and compiles shared external filter lists once globally, eliminating redundant
 * per-profile downloads and filter duplication.
 */

import { Env } from "../../types";
import { SystemListModel } from "../../models/systemList";
import { FingerprintSet, FingerprintSetBuilder } from "../fingerprintSet";
import { fetchListContent, getListFetchTuning } from "../listFetcher";
import { encodeLimitWarnings, keepLimitWarning, ListLimitKind } from "./syncWarnings";
import { AdGuardRuleKind, AdGuardPayload, ParsedAdGuardRule } from "../../lib/adguard";
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

  const yieldBatchSize = Number(env.SYNC_YIELD_BATCH_SIZE) || 5000;
  const yieldSleepMs = Number(env.SYNC_YIELD_SLEEP_MS) || 10;

  const filterBuilder = new FingerprintSetBuilder();
  const adguardPayload: AdGuardPayload = {
    exceptions: [],
    rewrites: {},
    patterns: []
  };

  let count = 0;
  let domainsSinceYield = 0;
  let domainLimitHit = false;
  let regexLimitHit = false;

  const existingFilterHead = await model.getSystemListFilterHeader(systemListId);
  const hasExistingRules = await model.hasSystemListAdguardRules(systemListId);
  const hasLocalData = Boolean(existingFilterHead || hasExistingRules);
  const isFilterCurrent = existingFilterHead ? FingerprintSet.isCurrentVersion(existingFilterHead) : hasLocalData;
  const useCacheHeaders = !force && isFilterCurrent && Boolean(systemList.etag || systemList.last_modified) && systemList.description != null;

  // Fast-path: hash simple ||domain^ and plain domain lines directly without parseAdGuardLine
  const fastPath = (line: string): boolean => {
    if (line.length === 0) return true; // skip empty

    const first = line.charCodeAt(0);

    // Skip comments: '!' (33), '#' (35), '[' (91) — no need for parser
    if (first === 33 || first === 35 || first === 91) return true;

    // Skip exceptions: '@@' (64, 64) — need parser for adguardPayload
    if (first === 64 && line.charCodeAt(1) === 64) return false;

    // Skip regex: '/' (47) — need parser
    if (first === 47) return false;

    // Skip cosmetic: '##' — need parser to mark as UNSUPPORTED
    if (first === 35 && line.charCodeAt(1) === 35) return false;
    // Also check for '#@#' and '#?#'
    if (line.includes('##') || line.includes('#@#') || line.includes('#?#')) return false;

    if (count >= maxListDomains) {
      domainLimitHit = true;
      return true; // handled (skip)
    }

    // ||domain^ fast path
    if (first === 124 && line.charCodeAt(1) === 124) {
      // Check for $, *, #, /, \ in the rest — if found, need parser
      let end = line.length;
      let hasSpecial = false;
      for (let j = 2; j < line.length; j++) {
        const c = line.charCodeAt(j);
        if (c === 94) { end = j; break; }  // '^'
        if (c === 36 || c === 42 || c === 35 || c === 47 || c === 92) { hasSpecial = true; break; }
      }
      if (!hasSpecial && end > 2) {
        filterBuilder.addPipePipeFromLine(line, 2, end);
        count++;
        return true;
      }
      return false; // complex || rule — need parser
    }

    // Single pipe | — rare, let parser handle
    if (first === 124) return false;

    // Hosts format: digit + space + domain (e.g., "0.0.0.0 example.com")
    if (first >= 48 && first <= 57) {
      let spaceIdx = -1;
      for (let j = 0; j < line.length; j++) {
        if (line.charCodeAt(j) === 32) { spaceIdx = j; break; }
      }
      if (spaceIdx === -1) return false; // no space — might be plain domain starting with digit
      // Check if prefix is IP-like (has dots and digits only)
      let isIpLike = true;
      for (let j = 0; j < spaceIdx; j++) {
        const c = line.charCodeAt(j);
        if (c !== 46 && (c < 48 || c > 57) && c !== 58) { isIpLike = false; break; }
      }
      if (isIpLike && spaceIdx > 6) {
        // Find domain end (next whitespace or \r or end)
        let dEnd = line.length;
        for (let j = spaceIdx + 1; j < line.length; j++) {
          const c = line.charCodeAt(j);
          if (c === 32 || c === 13) { dEnd = j; break; }
        }
        if (dEnd > spaceIdx + 1) {
          // Check for localhost/0.0.0.0/127.0.0.1 — skip those
          const d = line.substring(spaceIdx + 1, dEnd).toLowerCase();
          if (d !== 'localhost' && d !== '0.0.0.0' && d !== '127.0.0.1') {
            filterBuilder.addFromLine(line, spaceIdx + 1, dEnd);
            count++;
          }
          return true;
        }
      }
      // Not hosts format — fall through to plain domain check
    }

    // Plain domain fast path
    let end = line.length;
    let hasSpecial = false;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c === 94 || c === 36) { end = j; break; }  // '^' or '$'
      if (c === 42 || c === 35 || c === 47 || c === 92 || c === 124) { hasSpecial = true; break; }
    }
    if (!hasSpecial && end > 0) {
      filterBuilder.addFromLine(line, 0, end);
      count++;
      return true;
    }

    return false; // complex — need parser
  };

  const { error: fetchError, truncated, notModified, etag, lastModified, title, description } = await fetchListContent(
    systemList.url,
    maxListBytes,
    timeoutMs,
    (rule: ParsedAdGuardRule) => {
      if (count < maxListDomains) {
        if (rule.kind === AdGuardRuleKind.BLOOM_DOMAIN && rule.domain) {
          if (rule.includeSubdomains) {
            filterBuilder.addPipePipe(rule.domain);
          } else {
            filterBuilder.add(rule.domain);
          }
          count++;
        } else if (rule.kind === AdGuardRuleKind.EXCEPTION && rule.domain) {
          adguardPayload.exceptions.push({
            domain: rule.domain,
            includeSubdomains: Boolean(rule.includeSubdomains),
            raw: rule.raw
          });
          count++;
        } else if (rule.kind === AdGuardRuleKind.DNS_REWRITE && rule.domain && rule.rewrite) {
          adguardPayload.rewrites[rule.domain] = {
            ...rule.rewrite,
            includeSubdomains: Boolean(rule.includeSubdomains),
            raw: rule.raw
          };
          count++;
        } else if (rule.kind === AdGuardRuleKind.COMPLEX_PATTERN && rule.patternRegex) {
          if (adguardPayload.patterns.length < maxRegexRules) {
            adguardPayload.patterns.push({
              pattern: rule.patternRegex,
              apexIndex: rule.apexIndex,
              raw: rule.raw
            });
            count++;
          } else {
            regexLimitHit = true;
          }
        }

        domainsSinceYield++;
        if (domainsSinceYield >= yieldBatchSize) {
          domainsSinceYield = 0;
          return new Promise<void>((resolve) => setTimeout(resolve, yieldSleepMs));
        }
      } else {
        domainLimitHit = true;
      }
    },
    {
      ...(useCacheHeaders ? { etag: systemList.etag, lastModified: systemList.last_modified } : {}),
      ...getListFetchTuning(env),
      fastPath,
      fastPathYieldBatch: yieldBatchSize,
      fastPathYieldSleep: yieldSleepMs
    }
  );

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

    const listFilter = await filterBuilder.build();

    const saveOps: Promise<any>[] = [
      model.upsertSystemListAdguard(systemListId, adguardPayload, now)
    ];
    if (!listFilter.isEmpty()) {
      saveOps.push(model.upsertSystemListFilter(systemListId, listFilter.toUint8Array().buffer as ArrayBuffer, now));
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
          const clearTasks = affected.results.map((row) =>
            pipelineCache.clear(row.profile_id, false, env).catch((e) =>
              console.warn(`[SystemListSync] Failed to clear cache for profile ${row.profile_id}:`, e)
            )
          );
          await Promise.all(clearTasks);
          console.log(`[SystemListSync] Cleared pipeline cache for ${affected.results.length} profile(s) using system list #${systemListId}.`);
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
