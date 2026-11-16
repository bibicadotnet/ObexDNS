import { Env, ExecutionContext } from "../../types";
import { ProfileModel } from "../../models/profile";
import { ListModel } from "../../models/list";
import { ProfileFilterModel } from "../../models/profileFilter";
import { ListFilterModel } from "../../models/listFilter";
import { combineAndPromote } from "./combine";
import { syncSingleList } from "./singleListSync";
import { FingerprintSet } from "../fingerprintSet";
import { AdguardRulesModel } from "../../models/adguardRules";
import { systemListsManager } from "../../lib/filtering/systemListsManager";
import { pipelineCache } from "../../pipeline/cache";

interface InFlightSync {
  type: "all" | "next" | "single" | "rebuild";
  listId?: number;
  promise: Promise<void>;
}

const inFlightSyncs = new Map<string, InFlightSync>();

export function isProfileSyncing(profileId: string): boolean {
  return inFlightSyncs.has(profileId);
}

export function _resetInFlightSyncsForTesting(): void {
  inFlightSyncs.clear();
}

/**
 * True when a stored filter (list or profile) is not in the current FingerprintSet format (e.g. legacy Bloom).
 */
function filterFormatMismatch(head: Uint8Array | null): boolean {
  if (!head) return false;
  return !FingerprintSet.isCurrentVersion(head);
}

/**
 * Lists whose stored filter is in legacy Bloom or incompatible format are re-downloaded
 * so they can be merged into the new FingerprintSet.
 */
async function rebuildMismatchedLists(
  profileId: string,
  env: Env,
  listModel: ListModel,
  listFilterModel: ListFilterModel,
  opts: { excludeListId?: number; skipSyncedAfter?: number } = {}
): Promise<number> {
  if (env?.DB) await systemListsManager.ensureLoaded(env.DB, false, env);
  const lists = (await listModel.getLists(profileId)).filter(
    (l) => !!l.enabled && !systemListsManager.isSystemUrl(l.url)
  );
  let rebuilt = 0;
  for (const list of lists) {
    if (opts.excludeListId !== undefined && list.id === opts.excludeListId) continue;
    if (opts.skipSyncedAfter !== undefined && (list.last_synced_at ?? 0) > opts.skipSyncedAfter) continue;
    const head = await listFilterModel.getListFilterHeader(list.id);
    if (!filterFormatMismatch(head)) continue;
    console.log(`[Sync] Profile ${profileId}: list #${list.id} has legacy filter format; downloading it again.`);
    try {
      await syncSingleList(profileId, list, env, listModel, listFilterModel, Math.floor(Date.now() / 1000), true);
      rebuilt++;
    } catch (e) {
      console.error(`[Sync] Rebuild of list #${list.id} failed:`, e);
    }
  }
  return rebuilt;
}

/**
 * 【Cron 专用】每次触发时处理单个最旧的订阅列表。
 */
export async function syncNextListForProfile(
  profileId: string,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const activeSync = inFlightSyncs.get(profileId);
  if (activeSync) {
    console.log(
      `[Sync] Profile ${profileId}: another sync (${activeSync.type}) is already in-flight. Skipping cron sync pass.`
    );
    return;
  }

  const syncPromise = (async () => {
    try {
      await _executeSyncNextListForProfile(profileId, env, ctx);
    } finally {
      inFlightSyncs.delete(profileId);
    }
  })();

  inFlightSyncs.set(profileId, { type: "next", promise: syncPromise });
  return syncPromise;
}

async function _executeSyncNextListForProfile(
  profileId: string,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const profileModel = new ProfileModel(env.DB);
  const listModel = new ListModel(env.DB);
  const profileFilterModel = new ProfileFilterModel(env.DB);
  const listFilterModel = new ListFilterModel(env.DB);
  const now = Math.floor(Date.now() / 1000);

  try {
    const profile = await profileModel.getById(profileId);
    if (!profile) {
      console.error(`[Sync] Profile ${profileId} not found.`);
      return;
    }

    const lastFullSync: number = profile.list_updated_at ?? 0;
    const lists = await listModel.getLists(profileId);
    const activeLists = lists.filter((l) => !!l.enabled);

    if (activeLists.length === 0) {
      await profileFilterModel.clearProfileFilters(profileId);
      await profileModel.updateListUpdatedAt(profileId, now);
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(pipelineCache.clear(profileId, true, env));
      } else {
        await pipelineCache.clear(profileId, true, env);
      }
      return;
    }

    const isNewCycle = !activeLists.some((l) => (l.last_synced_at ?? 0) > lastFullSync);
    if (isNewCycle) {
      console.log(`[Sync] Profile ${profileId}: starting a new sync cycle.`);
    }

    const pendingLists = activeLists
      .filter((l) => (l.last_synced_at ?? 0) <= lastFullSync)
      .sort((a, b) => (a.last_synced_at ?? 0) - (b.last_synced_at ?? 0));

    if (pendingLists.length === 0) {
      await profileModel.updateListUpdatedAt(profileId, now);
      await combineAndPromote(
        profileId,
        listModel,
        listFilterModel,
        profileFilterModel,
        profileModel,
        ctx,
        now,
        undefined,
        undefined,
        env
      );
      return;
    }

    const list = pendingLists[0];
    await syncSingleList(profileId, list, env, listModel, listFilterModel, now);

    const rebuiltOthers = await rebuildMismatchedLists(profileId, env, listModel, listFilterModel, {
      excludeListId: list.id,
      skipSyncedAfter: lastFullSync
    });

    const updatedLists = await listModel.getLists(profileId);
    const activeUpdatedLists = updatedLists.filter((l) => !!l.enabled);
    const allDone = activeUpdatedLists.every((l) => (l.last_synced_at ?? 0) > lastFullSync);

    if (allDone) {
      await profileModel.updateListUpdatedAt(profileId, now);
      await combineAndPromote(
        profileId,
        listModel,
        listFilterModel,
        profileFilterModel,
        profileModel,
        ctx,
        now,
        undefined,
        undefined,
        env
      );
      console.log(
        `[Sync] Profile ${profileId}: all ${activeUpdatedLists.length} list(s) processed — promoted combined active filter.`
      );
    } else {
      if (rebuiltOthers > 0) {
        await combineAndPromote(
          profileId,
          listModel,
          listFilterModel,
          profileFilterModel,
          profileModel,
          ctx,
          now,
          undefined,
          undefined,
          env
        );
        await profileModel.updateListUpdatedAt(profileId, lastFullSync);
      }
      const remaining = activeUpdatedLists.filter(
        (l) => (l.last_synced_at ?? 0) <= lastFullSync
      ).length;
      console.log(
        `[Sync] Profile ${profileId}: ${remaining} active list(s) remaining in this cycle.`
      );
    }
  } catch (e) {
    console.error(`[Sync] Critical failure for Profile ${profileId}:`, e);
    await profileModel.updateListUpdatedAt(profileId, now);
  }
}

/**
 * 【手动/全量同步专用】同步该 Profile 下的所有已启用订阅列表。
 */
export async function syncAllListsForProfile(
  profileId: string,
  env: Env,
  ctx: ExecutionContext,
  force: boolean = false
): Promise<void> {
  const activeSync = inFlightSyncs.get(profileId);
  if (activeSync) {
    if (activeSync.type === "all") {
      console.log(
        `[Sync] Profile ${profileId}: full sync already in-flight. Joining active promise.`
      );
      return activeSync.promise;
    }
    console.log(
      `[Sync] Profile ${profileId}: waiting for in-flight ${activeSync.type} sync to complete before starting full sync.`
    );
    await activeSync.promise.catch(() => {});
  }

  const postWaitSync = inFlightSyncs.get(profileId);
  if (postWaitSync && postWaitSync.type === "all") {
    return postWaitSync.promise;
  }

  const syncPromise = (async () => {
    try {
      await _executeSyncAllListsForProfile(profileId, env, ctx, force);
    } finally {
      inFlightSyncs.delete(profileId);
    }
  })();

  inFlightSyncs.set(profileId, { type: "all", promise: syncPromise });
  return syncPromise;
}

async function _executeSyncAllListsForProfile(
  profileId: string,
  env: Env,
  ctx: ExecutionContext,
  force: boolean = false
): Promise<void> {
  const profileModel = new ProfileModel(env.DB);
  const listModel = new ListModel(env.DB);
  const profileFilterModel = new ProfileFilterModel(env.DB);
  const listFilterModel = new ListFilterModel(env.DB);
  const now = Math.floor(Date.now() / 1000);

  try {
    const profile = await profileModel.getById(profileId);
    if (!profile) {
      console.error(`[Sync] Profile ${profileId} not found.`);
      return;
    }

    const lists = await listModel.getLists(profileId);
    const activeLists = lists.filter((l) => !!l.enabled);

    if (activeLists.length === 0) {
      await profileFilterModel.clearProfileFilters(profileId);
      await profileModel.updateListUpdatedAt(profileId, now);
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(pipelineCache.clear(profileId, true, env));
      } else {
        await pipelineCache.clear(profileId, true, env);
      }
      return;
    }

    let anyListModified = false;
    for (let i = 0; i < activeLists.length; i++) {
      const list = activeLists[i];
      const res = await syncSingleList(profileId, list, env, listModel, listFilterModel, now, force);
      if (!res.notModified) {
        anyListModified = true;
      }
      if (!res.notModified && i < activeLists.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    const existingProfileFilter = await profileFilterModel.getProfileFilterHeader(profileId);
    const isProfileFilterCurrent = FingerprintSet.isCurrentVersion(existingProfileFilter);

    if (!anyListModified && isProfileFilterCurrent) {
      await profileModel.updateListUpdatedAt(profileId, now);
      console.log(`[Sync] Profile ${profileId}: all ${activeLists.length} list(s) were 304 Not Modified and profile filter is current — skipped combine.`);
      return;
    }

    await profileModel.updateListUpdatedAt(profileId, now);

    await combineAndPromote(
      profileId,
      listModel,
      listFilterModel,
      profileFilterModel,
      profileModel,
      ctx,
      now,
      undefined,
      undefined,
      env
    );
    console.log(`[Sync] Profile ${profileId}: manual sync cycle complete.`);
  } catch (e) {
    console.error(`[Sync] Critical failure in manual sync for Profile ${profileId}:`, e);
    await profileModel.updateListUpdatedAt(profileId, now);
  }
}

/**
 * 【单个列表手动同步专用】针对指定 listId 进行单独同步并触发 Profile 过滤器与 AdGuard 规则重构。
 */
export async function syncSingleListForProfile(
  profileId: string,
  listId: number,
  env: Env,
  ctx: ExecutionContext,
  force: boolean = false
): Promise<void> {
  const activeSync = inFlightSyncs.get(profileId);
  if (activeSync) {
    if (activeSync.type === "single" && activeSync.listId === listId) {
      console.log(
        `[Sync] Profile ${profileId}: sync for list #${listId} already in-flight. Joining active promise.`
      );
      return activeSync.promise;
    }
    if (activeSync.type === "all") {
      console.log(
        `[Sync] Profile ${profileId}: full sync in-flight (covers list #${listId}). Joining active promise.`
      );
      return activeSync.promise;
    }
    console.log(
      `[Sync] Profile ${profileId}: waiting for in-flight ${activeSync.type} sync to finish before syncing list #${listId}.`
    );
    await activeSync.promise.catch(() => {});
  }

  const postWaitSync = inFlightSyncs.get(profileId);
  if (postWaitSync) {
    if (postWaitSync.type === "single" && postWaitSync.listId === listId) {
      return postWaitSync.promise;
    }
    if (postWaitSync.type === "all") {
      return postWaitSync.promise;
    }
  }

  const syncPromise = (async () => {
    try {
      await _executeSyncSingleListForProfile(profileId, listId, env, ctx, force);
    } finally {
      inFlightSyncs.delete(profileId);
    }
  })();

  inFlightSyncs.set(profileId, { type: "single", listId, promise: syncPromise });
  return syncPromise;
}

async function _executeSyncSingleListForProfile(
  profileId: string,
  listId: number,
  env: Env,
  ctx: ExecutionContext,
  force: boolean = false
): Promise<void> {
  const listModel = new ListModel(env.DB);
  const listFilterModel = new ListFilterModel(env.DB);
  const profileFilterModel = new ProfileFilterModel(env.DB);
  const profileModel = new ProfileModel(env.DB);
  const now = Math.floor(Date.now() / 1000);

  try {
    const list = await listModel.getListById(listId, profileId);
    if (!list) {
      console.error(`[Sync] List ${listId} not found in profile ${profileId}`);
      return;
    }

    const { notModified } = await syncSingleList(profileId, list, env, listModel, listFilterModel, now, force);

    const rebuiltOthers = list.enabled
      ? await rebuildMismatchedLists(profileId, env, listModel, listFilterModel, { excludeListId: list.id })
      : 0;

    const existingProfileFilter = await profileFilterModel.getProfileFilterHeader(profileId);
    const isProfileFilterCurrent = FingerprintSet.isCurrentVersion(existingProfileFilter);

    if (list.enabled && (!notModified || !isProfileFilterCurrent || rebuiltOthers > 0)) {
      await profileModel.updateListUpdatedAt(profileId, now);
      await combineAndPromote(
        profileId,
        listModel,
        listFilterModel,
        profileFilterModel,
        profileModel,
        ctx,
        now,
        undefined,
        undefined,
        env
      );
    } else if (list.enabled && notModified) {
      await profileModel.updateListUpdatedAt(profileId, now);
      console.log(`[Sync] Profile ${profileId}: single list #${listId} 304 Not Modified — skipped combine.`);
    }
    console.log(`[Sync] Profile ${profileId}: single list #${listId} sync complete.`);
  } catch (e) {
    console.error(`[Sync] Critical failure in single list sync for Profile ${profileId}, list ${listId}:`, e);
  }
}

/**
 * 快速重构并合并 Profile 的过滤器。
 */
export async function rebuildProfileFilter(
  profileId: string,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const activeSync = inFlightSyncs.get(profileId);
  if (activeSync) {
    console.log(
      `[Sync] Profile ${profileId}: waiting for in-flight ${activeSync.type} sync before rebuilding filter.`
    );
    await activeSync.promise.catch(() => {});
  }

  const syncPromise = (async () => {
    try {
      await _executeRebuildProfileFilter(profileId, env, ctx);
    } finally {
      inFlightSyncs.delete(profileId);
    }
  })();

  inFlightSyncs.set(profileId, { type: "rebuild", promise: syncPromise });
  return syncPromise;
}

async function _executeRebuildProfileFilter(
  profileId: string,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const listModel = new ListModel(env.DB);
  const listFilterModel = new ListFilterModel(env.DB);
  const profileFilterModel = new ProfileFilterModel(env.DB);
  const profileModel = new ProfileModel(env.DB);
  const adguardRulesModel = env?.DB ? new AdguardRulesModel(env.DB) : null;

  const profile = await profileModel.getById(profileId);
  const priorListUpdatedAt = profile?.list_updated_at ?? 0;

  if (env?.DB) {
    await systemListsManager.ensureLoaded(env.DB, false, env);
  }

  const activeLists = (await listModel.getLists(profileId)).filter((l) => !!l.enabled);
  const presence = await Promise.all(
    activeLists.map(async (l) => {
      if (systemListsManager.isSystemUrl(l.url)) return true;
      const hasFilter = await listFilterModel.hasListFilter(l.id).catch(() => true);
      if (hasFilter) return true;
      if (adguardRulesModel) {
        return adguardRulesModel.hasListRules(l.id).catch(() => true);
      }
      return false;
    })
  );

  const missingIndex = presence.findIndex((present) => !present);
  if (missingIndex !== -1) {
    const missing = activeLists[missingIndex];
    try {
      await syncSingleList(
        profileId,
        missing,
        env,
        listModel,
        listFilterModel,
        Math.floor(Date.now() / 1000)
      );
    } catch (e) {
      console.error(`[Sync] fetch of list ${missing.id} during rebuild failed:`, e);
    }
  }

  await rebuildMismatchedLists(profileId, env, listModel, listFilterModel);

  await combineAndPromote(
    profileId,
    listModel,
    listFilterModel,
    profileFilterModel,
    profileModel,
    ctx,
    Math.floor(Date.now() / 1000),
    undefined,
    undefined,
    env
  );

  await profileModel.updateListUpdatedAt(profileId, priorListUpdatedAt);
}
