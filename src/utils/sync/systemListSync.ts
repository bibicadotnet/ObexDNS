/**
 * @file systemListSync.ts
 * @description Synchronization engine for system-wide shared filter lists.
 * Downloads and compiles shared external filter lists once globally, eliminating redundant
 * per-profile downloads and Bloom filter duplication.
 */

import { Env } from "../../types";
import { SystemListModel } from "../../models/systemList";
import { ListModel } from "../../models/list";
import { BloomFilter } from "../bloom";
import { fetchListContent } from "../listFetcher";
import { AdGuardRuleKind, AdGuardPayload, ParsedAdGuardRule } from "../../lib/adguard";
import { systemListsManager } from "../../lib/filtering/systemListsManager";

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
  const timeoutMs = Number(env.SYNC_TIMEOUT_MS) || 90000;
  const maxListDomains = Number(env.MAX_LIST_DOMAINS) || 500000;
  const maxDomains = Number(env.MAX_SYNC_DOMAINS) || 1000000;
  const maxListBytes = Number(env.MAX_LIST_BYTES) || DEFAULT_MAX_LIST_BYTES;
  const falsePositiveRate = Number(env.BLOOM_FALSE_POSITIVE_RATE) || 0.0001;
  const maxRegexRules = Number(env.MAX_REGEX_RULES) || 1000;

  const yieldBatchSize = Number(env.SYNC_YIELD_BATCH_SIZE) || 5000;
  const yieldSleepMs = Number(env.SYNC_YIELD_SLEEP_MS) || 10;

  const listBloom = BloomFilter.create(maxDomains, falsePositiveRate);
  const adguardPayload: AdGuardPayload = {
    exceptions: [],
    rewrites: {},
    patterns: []
  };

  let count = 0;
  let domainsSinceYield = 0;

  // Check if existing Bloom is current v2 format, or if non-bloom rules (whitelist/rewrite) exist locally
  const existingBloom = await model.getSystemListBloom(systemListId);
  const existingRules = await model.getSystemListAdguard(systemListId);
  const hasLocalData = Boolean(
    existingBloom ||
    (existingRules && (existingRules.exceptions.length > 0 || Object.keys(existingRules.rewrites).length > 0 || existingRules.patterns.length > 0))
  );
  const isBloomCurrent = existingBloom ? BloomFilter.isCurrentVersion(existingBloom) : hasLocalData;
  const useCacheHeaders = !force && isBloomCurrent && Boolean(systemList.etag || systemList.last_modified);

  const { error: fetchError, truncated, notModified, etag, lastModified } = await fetchListContent(
    systemList.url,
    maxListBytes,
    timeoutMs,
    (rule: ParsedAdGuardRule) => {
      if (count < maxListDomains) {
        if (rule.kind === AdGuardRuleKind.BLOOM_DOMAIN && rule.domain) {
          if (rule.includeSubdomains) {
            listBloom.addPipePipe(rule.domain);
          } else {
            listBloom.add(rule.domain);
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
          }
        }

        domainsSinceYield++;
        if (domainsSinceYield >= yieldBatchSize) {
          domainsSinceYield = 0;
          return new Promise<void>((resolve) => setTimeout(resolve, yieldSleepMs));
        }
      }
    },
    useCacheHeaders ? { etag: systemList.etag, lastModified: systemList.last_modified } : {}
  );

  // 304 Not Modified
  if (notModified) {
    console.log(`[SystemListSync] System list #${systemListId} (${systemList.url}) 304 Not Modified.`);
    await model.updateMetadata(systemListId, {
      last_synced_at: now,
      etag: etag ?? systemList.etag,
      last_modified: lastModified ?? systemList.last_modified
    });

    // Update all matching profile list rows so user dashboard displays fresh sync timestamp
    await syncProfileListRows(env.DB, systemList.url, now, null);
    return { syncError: null, notModified: true };
  }

  let syncError: string | null = fetchError;
  if (!fetchError) {
    if (truncated) {
      syncError = `List truncated at ${(maxListBytes / 1024 / 1024).toFixed(0)} MB: Maximum list size reached.`;
      console.warn(`[SystemListSync] System list #${systemListId} truncated with ${count} rules.`);
    }

    // Save Bloom and AdGuard rules (skip saving empty Bloom for whitelist/rewrites to save DB & RAM)
    const saveOps: Promise<any>[] = [
      model.upsertSystemListAdguard(systemListId, adguardPayload, now)
    ];
    if (!listBloom.isEmpty()) {
      saveOps.push(model.upsertSystemListBloom(systemListId, listBloom.toUint8Array().buffer as ArrayBuffer, now));
    } else {
      saveOps.push(model.clearSystemListBloom(systemListId));
    }
    await Promise.all(saveOps);

    await model.updateMetadata(systemListId, {
      etag: etag || null,
      last_modified: lastModified || null,
      last_synced_at: now,
      sync_error: syncError,
      rule_count: count
    });

    // Update matching profile list rows
    await syncProfileListRows(env.DB, systemList.url, now, syncError);

    // Invalidate and reload in-memory cache
    systemListsManager.invalidate();
    await systemListsManager.ensureLoaded(env.DB, true);

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

/**
 * Updates profile list rows corresponding to a system URL so UI reflects current sync status.
 */
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

/**
 * Synchronizes all registered system-wide shared filter lists.
 * Employs on-demand optimization: only lists that are currently active in at least
 * one profile (or explicitly forced) are downloaded/synced, avoiding unnecessary
 * bandwidth and CPU consumption for dormant presets.
 */
export async function syncAllSystemLists(env: Env, force: boolean = false): Promise<void> {
  if (env?.DB) {
    await systemListsManager.ensureLoaded(env.DB, false, env);
  }
  const model = new SystemListModel(env.DB);
  const lists = await model.getSystemLists();

  // Determine which system lists are actively in use by at least one profile
  const activeUrls = new Set<string>();
  if (env?.DB) {
    try {
      const activeRows = await env.DB
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

    // Skip dormant system presets if no profile is actively using them (unless force=true)
    if (!isActiveInProfile && !force) {
      continue;
    }

    try {
      await syncSingleSystemList(list.id, env, force);
    } catch (err) {
      console.error(`[SystemListSync] Error syncing system list #${list.id}:`, err);
    }
  }
}

