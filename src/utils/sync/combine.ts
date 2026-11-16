import { Env, ExecutionContext } from "../../types";
import { FingerprintSet } from "../fingerprintSet";
import { pipelineCache } from "../../pipeline/cache";
import { ProfileModel } from "../../models/profile";
import { ListModel } from "../../models/list";
import { ProfileFilterModel } from "../../models/profileFilter";
import { ListFilterModel } from "../../models/listFilter";
import { AdguardRulesModel } from "../../models/adguardRules";
import { AdGuardPayload } from "../../lib/adguard/types";
import { systemListsManager } from "../../lib/filtering/systemListsManager";

/**
 * 汇总并合并所有已启用列表的 Fingerprint Filter 与 AdGuard 扩展规则，并原子更新为 Profile 的 active 状态。
 */
export async function combineAndPromote(
  profileId: string,
  listModel: ListModel,
  listFilterModel: ListFilterModel,
  profileFilterModel: ProfileFilterModel,
  profileModel: ProfileModel,
  ctx: ExecutionContext,
  now: number,
  maxDomains?: number,
  falsePositiveRate?: number,
  env?: Env
): Promise<void> {
  const lists = await listModel.getLists(profileId);
  const activeLists = lists.filter((l) => !!l.enabled);
  const adguardRulesModel = env?.DB ? new AdguardRulesModel(env.DB) : null;

  if (env?.DB) {
    await systemListsManager.ensureLoaded(env.DB, false, env);
  }
  // 过滤掉系统共享列表：系统共享列表走全局 Tier 1 Filter，无需合并进各 Profile
  const customLists = activeLists.filter((l) => !systemListsManager.isSystemUrl(l.url));

  const maxProfileDomains = maxDomains || (env
    ? (Number(env.MAX_PROFILE_CUSTOM_DOMAINS) ||
       ((Number(env.MAX_LIST_DOMAINS) || 500000) * (Number(env.MAX_CUSTOM_LISTS_PER_PROFILE) || 5)))
    : 2500000);

  if (customLists.length === 0) {
    await Promise.all([
      profileFilterModel.clearProfileFilters(profileId),
      adguardRulesModel?.clearProfileRules(profileId)
    ]);
  } else if (customLists.length === 1) {
    // 性能优化：单自定义列表短路晋升 (Single-List Direct Promotion)
    const single = customLists[0];
    const [buf, listRules] = await Promise.all([
      listFilterModel.getListFilter(single.id),
      adguardRulesModel ? adguardRulesModel.getListRules(single.id) : Promise.resolve(null)
    ]);

    const saveOps: Promise<any>[] = [];
    if (buf && FingerprintSet.isCurrentVersion(buf)) {
      try {
        const parsed = FingerprintSet.fromUint8Array(new Uint8Array(buf));
        let finalBuf = buf;
        if (parsed.size > maxProfileDomains) {
          console.warn(`[Sync] Profile ${profileId}: single list #${single.id} domains (${parsed.size}) exceeds limit (${maxProfileDomains}). Truncating.`);
          // Truncation samples domains uniformly across the 64-bit hash space up to maxProfileDomains.
          finalBuf = parsed.truncate(maxProfileDomains).toUint8Array().buffer as ArrayBuffer;
        }
        saveOps.push(profileFilterModel.upsertProfileFilter(profileId, finalBuf, now));
      } catch (err: any) {
        console.warn(`[Sync] List #${single.id} has invalid filter format:`, err?.message || err);
      }
    } else if (buf) {
      console.warn(`[Sync] List #${single.id} is in legacy filter format, preserving existing profile filter until synced.`);
    } else {
      saveOps.push(profileFilterModel.clearProfileFilters(profileId));
    }
    if (adguardRulesModel) {
      const payload: AdGuardPayload = listRules || { exceptions: [], rewrites: {}, patterns: [] };
      saveOps.push(adguardRulesModel.upsertProfileRules(profileId, payload, now));
    }
    await Promise.all(saveOps);
  } else {
    // 合并所有自定义列表的 FingerprintSet 与 AdGuard 扩展规则
    const sets: FingerprintSet[] = [];
    const mergedAdguard: AdGuardPayload = {
      exceptions: [],
      rewrites: {},
      patterns: []
    };
    const seenExceptions = new Set<string>();
    let hasInvalidOrLegacyList = false;

    for (const list of customLists) {
      // 1. FingerprintSet 加载
      try {
        const buf = await listFilterModel.getListFilter(list.id);
        if (buf) {
          if (FingerprintSet.isCurrentVersion(buf)) {
            sets.push(FingerprintSet.fromUint8Array(new Uint8Array(buf)));
          } else {
            hasInvalidOrLegacyList = true;
          }
        }
      } catch (err: any) {
        console.error(`[Sync] Failed to load filter for list #${list.id}:`, err?.message || err);
        hasInvalidOrLegacyList = true;
      }

      // 2. AdGuard 扩展规则合并
      try {
        if (adguardRulesModel) {
          const listRules = await adguardRulesModel.getListRules(list.id);
          if (listRules) {
            if (Array.isArray(listRules.exceptions)) {
              for (const exc of listRules.exceptions) {
                const key = `${exc.domain}:${exc.includeSubdomains ? 1 : 0}`;
                if (!seenExceptions.has(key)) {
                  seenExceptions.add(key);
                  mergedAdguard.exceptions.push(exc);
                }
              }
            }
            if (listRules.rewrites && typeof listRules.rewrites === "object") {
              Object.assign(mergedAdguard.rewrites, listRules.rewrites);
            }
            if (Array.isArray(listRules.patterns)) {
              for (const pat of listRules.patterns) {
                mergedAdguard.patterns.push(pat);
              }
            }
          }
        }
      } catch (err) {
        console.error(`[Sync] Failed to load/merge rules for list #${list.id}:`, err);
      }
    }

    if (hasInvalidOrLegacyList) {
      console.warn(
        `[Sync] Profile ${profileId}: one or more custom lists failed to parse as FingerprintSet (e.g. legacy BLMZ). ` +
        `Preserving existing profile filter to prevent dropping rules until all lists are resynced.`
      );
    } else {
      const merged = await FingerprintSet.mergeSets(sets);
      let finalSet = merged;
      if (merged.size > maxProfileDomains) {
        console.warn(
          `[Sync] Profile ${profileId}: total merged domains (${merged.size}) exceeds limit (${maxProfileDomains}). Truncating.`
        );
        // Truncation on sorted 64-bit domain fingerprints provides an unbiased pseudo-random sample
        // across all input lists rather than dropping whole lists or alphabetical subsets.
        finalSet = merged.truncate(maxProfileDomains);
      }

      if (!finalSet.isEmpty()) {
        const binary = finalSet.toUint8Array();
        await profileFilterModel.upsertProfileFilter(profileId, binary.buffer as ArrayBuffer, now);
      } else {
        await profileFilterModel.clearProfileFilters(profileId);
      }
    }

    if (adguardRulesModel) {
      await adguardRulesModel.upsertProfileRules(profileId, mergedAdguard, now);
    }
  }

  await profileModel.updateListUpdatedAt(profileId, now);

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(pipelineCache.clear(profileId, true, env));
  } else {
    await pipelineCache.clear(profileId, true, env);
  }
}
