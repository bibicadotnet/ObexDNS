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
      ...getListFetchTuning(env),
      fastPath,
      fastPathYieldBatch: yieldBatchSize,
      fastPathYieldSleep: yieldSleepMs,
      onRetry: () => {
        filterBuilder.clear();
        adguardPayload.exceptions = [];
        adguardPayload.rewrites = {};
        adguardPayload.patterns = [];
        count = 0;
        domainsSinceYield = 0;
        domainLimitHit = false;
        regexLimitHit = false;
      }
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

    // Build the sorted fingerprint set asynchronously (with event loop yields)
    const listFilter = await filterBuilder.build();

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
