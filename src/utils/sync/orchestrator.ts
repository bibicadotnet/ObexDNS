import { Env, ExecutionContext } from "../../types";
import { ProfileModel } from "../../models/profile";
import { ListModel } from "../../models/list";
import { ListFilterModel } from "../../models/listFilter";
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
      await profileModel.updateListUpdatedAt(profileId, now);
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(pipelineCache.clear(profileId, false, env));
      } else {
        await pipelineCache.clear(profileId, false, env);
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
      await pipelineCache.clear(profileId, false, env);
      return;
    }

    const list = pendingLists[0];
    await syncSingleList(profileId, list, env, listModel, listFilterModel, now);

    const updatedLists = await listModel.getLists(profileId);
    const activeUpdatedLists = updatedLists.filter((l) => !!l.enabled);
    const allDone = activeUpdatedLists.every((l) => (l.last_synced_at ?? 0) > lastFullSync);

    if (allDone) {
      await profileModel.updateListUpdatedAt(profileId, now);
      await pipelineCache.clear(profileId, false, env);
      console.log(
        `[Sync] Profile ${profileId}: all ${activeUpdatedLists.length} list(s) processed.`
      );
    } else {
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
      await profileModel.updateListUpdatedAt(profileId, now);
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(pipelineCache.clear(profileId, false, env));
      } else {
        await pipelineCache.clear(profileId, false, env);
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

    await profileModel.updateListUpdatedAt(profileId, now);
    if (anyListModified) {
      await pipelineCache.clear(profileId, false, env);
    }
    console.log(`[Sync] Profile ${profileId}: sync cycle complete.`);
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
  const profileModel = new ProfileModel(env.DB);
  const now = Math.floor(Date.now() / 1000);

  try {
    const list = await listModel.getListById(listId, profileId);
    if (!list) {
      console.error(`[Sync] List ${listId} not found in profile ${profileId}`);
      return;
    }

    const { notModified } = await syncSingleList(profileId, list, env, listModel, listFilterModel, now, force);

    if (list.enabled && !notModified) {
      await profileModel.updateListUpdatedAt(profileId, now);
      await pipelineCache.clear(profileId, false, env);
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
  await pipelineCache.clear(profileId, false, env);
}
