import { Env } from "../../types";
import { FingerprintSet, FingerprintSetBuilder } from "../fingerprintSet";
import { fetchListContent, getListFetchTuning } from "../listFetcher";
import { encodeLimitWarnings, keepLimitWarning, ListLimitKind } from "./syncWarnings";
import { envNumber } from "../envNumber";
import { ListModel } from "../../models/list";
import { ListFilterModel } from "../../models/listFilter";
import { SystemListModel } from "../../models/systemList";
import { AdguardRulesModel } from "../../models/adguardRules";
import { AdGuardRuleKind, AdGuardPayload, ParsedAdGuardRule } from "../../lib/adguard";
import { systemListsManager } from "../../lib/filtering/systemListsManager";
import { customListsManager } from "../../lib/filtering/customListsManager";
import { syncSingleSystemList } from "./systemListSync";
import { logMemoryUsage } from "../memory";

const DEFAULT_MAX_LIST_BYTES = 25 * 1024 * 1024; // 25 MB default limit

export interface SingleListSyncResult {
  syncError: string | null;
  notModified: boolean;
}

/**
 * Synchronizes a single filter list.
 */
export async function syncSingleList(
  profileId: string,
  list: { id: number; url: string; etag?: string | null; last_modified?: string | null; sync_error?: string | null; description?: string | null },
  env: Env,
  listModel: ListModel,
  listFilterModel: ListFilterModel,
  now: number,
  force: boolean = false
): Promise<SingleListSyncResult> {
  // ── 系统共享列表快速通道 (System Shared List Fast Path) ───────────────────
  if (env?.DB) {
    try {
      await systemListsManager.ensureLoaded(env.DB, false, env);
    } catch {}
    if (systemListsManager.isSystemUrl(list.url)) {
      const sysId = systemListsManager.getIdByUrl(list.url);
      if (sysId) {
        const sysModel = new SystemListModel(env.DB);
        let sysList = await sysModel.getSystemListById(sysId);
        const isFresh = Boolean(sysList?.last_synced_at && (now - sysList.last_synced_at < envNumber(env.SYNC_FORCE_COOLDOWN_SEC, 60)));
        const neverSynced = !sysList?.last_synced_at;
        if ((force && !isFresh) || neverSynced) {
          await syncSingleSystemList(sysId, env, force || neverSynced);
          sysList = await sysModel.getSystemListById(sysId);
          await systemListsManager.ensureLoaded(env.DB, true, env);
        }
        await listModel.updateListSyncStatus(
          list.id,
          sysList?.last_synced_at || now,
          null,
          sysList?.sync_error || null,
          null,
          null
        );
        return { syncError: sysList?.sync_error || null, notModified: true };
      }
    }
  }

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

  const existingFilterHead = await listFilterModel.getListFilterHeader(list.id);
  const hasExistingRules = env?.DB ? await new AdguardRulesModel(env.DB).hasListRules(list.id) : false;
  const hasLocalData = Boolean(existingFilterHead || hasExistingRules);
  const isFilterCurrent = existingFilterHead ? FingerprintSet.isCurrentVersion(existingFilterHead) : hasLocalData;
  const useCacheHeaders = !force && isFilterCurrent && Boolean(list.etag || list.last_modified) && list.description != null;

  const { error: fetchError, truncated, notModified, etag, lastModified, title, description } = await fetchListContent(
    list.url,
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
      ...(useCacheHeaders ? { etag: list.etag, lastModified: list.last_modified } : {}),
      ...getListFetchTuning(env)
    }
  );

  if (notModified) {
    console.log(`[Sync] Profile ${profileId}: list #${list.id} 304 Not Modified (using cached rules).`);
    const keptWarning = keepLimitWarning(list.sync_error);
    await listModel.updateListSyncStatus(list.id, now, null, keptWarning, etag, lastModified);
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
      console.warn(`[Sync] Profile ${profileId}: list #${list.id} truncated with ${count} rules. Warning: ${syncError}`);
    }

    logMemoryUsage(`SyncList:BeforeBuild listId=${list.id}`);
    // Build the sorted fingerprint set asynchronously (with event loop yields)
    const listFilter = await filterBuilder.build();
    logMemoryUsage(`SyncList:AfterBuild listId=${list.id}`);

    const saveOps: Promise<any>[] = [];
    if (!listFilter.isEmpty()) {
      saveOps.push(listFilterModel.upsertListFilter(list.id, listFilter.toUint8Array().buffer as ArrayBuffer, now));
    } else {
      saveOps.push(listFilterModel.deleteListFilter(list.id));
    }
    if (env?.DB) {
      saveOps.push(new AdguardRulesModel(env.DB).upsertListRules(list.id, adguardPayload, now));
    }
    await Promise.all(saveOps);
    customListsManager.invalidate(list.id);
    logMemoryUsage(`SyncList:AfterSave listId=${list.id}`);
    if (!syncError) {
      console.log(
        `[Sync] Profile ${profileId}: successfully updated list #${list.id} with ${count} rules.`
      );
    }
  } else {
    console.warn(
      `[Sync] Profile ${profileId}: failed to fetch/parse list #${list.id}. ` +
        `Skipping and keeping old filter. Error: ${fetchError}`
    );
  }

  await listModel.updateListSyncStatus(
    list.id, now, null, syncError, etag, lastModified,
    fetchError ? null : title,
    fetchError ? undefined : (description ?? '')
  );
  return { syncError, notModified: false };
}
