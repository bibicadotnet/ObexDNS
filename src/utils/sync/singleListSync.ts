import { Env } from "../../types";
import { FingerprintSet } from "../fingerprintSet";
import { getListFetchTuning } from "../listFetcher";
import { runListParse } from "./listParseClient";
import { encodeLimitWarnings, keepLimitWarning, ListLimitKind } from "./syncWarnings";
import { envNumber } from "../envNumber";
import { ListModel } from "../../models/list";
import { ListFilterModel } from "../../models/listFilter";
import { SystemListModel } from "../../models/systemList";
import { AdguardRulesModel } from "../../models/adguardRules";
import { systemListsManager } from "../../lib/filtering/systemListsManager";
import { customListsManager } from "../../lib/filtering/customListsManager";
import { syncSingleSystemList } from "./systemListSync";

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

  const existingFilterHead = await listFilterModel.getListFilterHeader(list.id);
  const hasExistingRules = env?.DB ? await new AdguardRulesModel(env.DB).hasListRules(list.id) : false;
  const hasLocalData = Boolean(existingFilterHead || hasExistingRules);
  const isFilterCurrent = existingFilterHead ? FingerprintSet.isCurrentVersion(existingFilterHead) : hasLocalData;
  const useCacheHeaders = !force && isFilterCurrent && Boolean(list.etag || list.last_modified) && list.description != null;

  // Download, parse, hash, sort and serialize run on a worker thread (inline fallback), never on the DNS thread.
  const parsed = await runListParse(
    {
      url: list.url,
      maxListBytes,
      timeoutMs,
      maxListDomains,
      maxRegexRules,
      ...(useCacheHeaders ? { etag: list.etag, lastModified: list.last_modified } : {}),
      tuning: getListFetchTuning(env)
    },
    env
  );
  const {
    fetchError, truncated, notModified, etag, lastModified, title, description,
    count, domainLimitHit, regexLimitHit, adguardPayload
  } = parsed;

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

    // The sorted fingerprint set was already built (and serialized) by the parse worker.
    const saveOps: Promise<any>[] = [];
    if (parsed.filterBytes) {
      saveOps.push(listFilterModel.upsertListFilter(list.id, parsed.filterBytes.buffer as ArrayBuffer, now));
    } else {
      saveOps.push(listFilterModel.deleteListFilter(list.id));
    }
    if (env?.DB) {
      saveOps.push(new AdguardRulesModel(env.DB).upsertListRules(list.id, adguardPayload, now));
    }
    await Promise.all(saveOps);
    customListsManager.invalidate(list.id);
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
