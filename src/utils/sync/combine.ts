/**
 * @file combine.ts
 * @description Deprecated: Profile filters now operate independently per-list without combination.
 * This stub is kept for backwards compatibility.
 */

import { Env, ExecutionContext } from "../../types";
import { pipelineCache } from "../../pipeline/cache";

export async function combineAndPromote(
  profileId: string,
  _listModel?: any,
  _listFilterModel?: any,
  _profileFilterModel?: any,
  _profileModel?: any,
  _ctx?: ExecutionContext,
  _now?: number,
  _maxDomains?: number,
  _falsePositiveRate?: number,
  env?: Env
): Promise<void> {
  await pipelineCache.clear(profileId, false, env);
}
