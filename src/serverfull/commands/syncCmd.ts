/**
 * @file syncCmd.ts
 * @description Subcommand handler for `dns-worker sync [--force]`.
 * Manually synchronizes all filter lists across all profiles on demand.
 */

import { initNodeGlobals } from '../cache';
import { getServerfullConfig, ServerfullCliArgs } from '../config';
import { initServerfullDb } from '../db';
import { createTursoClient } from '../../lib/turso';
import { syncAllListsForProfile, syncAllSystemLists } from '../../utils/sync';
import { ExecutionContext } from '../../types';
import { formatBanner } from '../format';

export interface SyncCmdOptions {
  force?: boolean;
  cliArgs?: ServerfullCliArgs;
}

export async function handleSyncCommand(options: SyncCmdOptions = {}): Promise<void> {
  const isForce = Boolean(options.force);
  console.log(formatBanner({
    title: `DNS Worker - Manual List Synchronization (${isForce ? 'FORCE RE-FETCH' : 'SMART SYNC'})`,
    borderChar: '='
  }));

  initNodeGlobals();
  const { config, env } = getServerfullConfig(options.cliArgs);

  if (config.databaseService === 'Turso') {
    env.DB = createTursoClient(config.tursoDatabaseUrl, config.tursoAuthToken);
  } else {
    env.DB = initServerfullDb(config.dbPath);
  }

  console.log('[Sync CLI] Synchronizing System Shared Lists...');
  try {
    await syncAllSystemLists(env, isForce);
    console.log('[Sync CLI] System Shared Lists synchronized successfully.');
  } catch (err: any) {
    console.error('[Sync CLI] Failed to sync System Shared Lists:', err.message || err);
  }

  const result = await env.DB.prepare('SELECT id, name FROM profiles').all();
  const profiles = (result.results || []) as { id: string; name: string }[];

  if (profiles.length === 0) {
    console.log('[Sync CLI] No profiles found in database.');
    return;
  }

  console.log(`[Sync CLI] Found ${profiles.length} profile(s). Starting synchronization...`);

  const ctx: ExecutionContext = {
    waitUntil(promise: Promise<any>) {
      promise.catch((err) => console.error('[Sync CLI Background Error]:', err));
    },
    passThroughOnException() {}
  } as any;

  for (let i = 0; i < profiles.length; i++) {
    const prof = profiles[i];
    console.log(`\n[${i + 1}/${profiles.length}] Syncing profile "${prof.name}" (${prof.id})...`);
    try {
      await syncAllListsForProfile(prof.id, env, ctx, isForce);
      console.log(`[${i + 1}/${profiles.length}] Successfully synchronized profile "${prof.name}".`);
    } catch (err: any) {
      console.error(`[${i + 1}/${profiles.length}] Failed to sync profile "${prof.name}":`, err.message || err);
    }
  }

  console.log('\n[Sync CLI] All profile synchronizations completed successfully!');
}

