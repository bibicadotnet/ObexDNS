/**
 * @file filterMigration.ts
 * @description One-time, startup-only migration from legacy Bloom filters (BLMZ) to FingerprintSet (FPRT).
 *
 * When upgrading from older versions, stored filters in system_list_blooms and list_blooms
 * may contain legacy Bloom filter chunks. (The profile-level profile_blooms table was dropped
 * in migration 0067 and is no longer referenced here.)
 *
 * This migration runs once:
 * 1. Checks system_settings for 'filter_format' = 'FPRT_v1'. If present, does nothing.
 * 2. If missing, checks if any stored chunk has legacy magic.
 * 3. If legacy data is detected, resets etag, last_modified, and last_synced_at on
 *    system_lists and lists, and sets profiles.list_updated_at = NULL so all lists
 *    are cleanly re-downloaded and rebuilt as FingerprintSet (FPRT).
 * 4. Durably records 'filter_format' = 'FPRT_v1' in system_settings.
 */

import type { Env } from "../../types";
import { SystemSettingsModel } from "../../models/systemSettings";

export const FILTER_FORMAT_SETTING_KEY = "filter_format";
export const CURRENT_FILTER_FORMAT = "FPRT_v1";

const FPRT_MAGIC = 0x54525046; // 'FPRT' in little-endian

export interface FilterMigrationResult {
  migrated: boolean;
  outcome: "unchanged" | "migrated" | "none_needed" | "failed";
}

let inMemoryChecked = false;

export async function migrateFilterFormatIfLegacy(env: Env): Promise<FilterMigrationResult> {
  if (inMemoryChecked) {
    return { migrated: false, outcome: "unchanged" };
  }
  if (!env.DB) {
    return { migrated: false, outcome: "none_needed" };
  }

  const settings = new SystemSettingsModel(env.DB);

  try {
    const stored = await settings.get(FILTER_FORMAT_SETTING_KEY);
    if (stored === CURRENT_FILTER_FORMAT) {
      inMemoryChecked = true;
      return { migrated: false, outcome: "unchanged" };
    }

    // Inspect stored tables to see if legacy format exists using direct SQL filter
    let hasLegacy = false;
    const tables = ["system_list_blooms", "list_blooms"];

    for (const table of tables) {
      try {
        const row = await env.DB
          .prepare(`SELECT 1 AS legacy FROM ${table} WHERE chunk_index = 0 AND substr(bloom_filter_chunk, 1, 4) != X'46505254' LIMIT 1`)
          .bind()
          .first<{ legacy: number }>();

        if (row && row.legacy) {
          hasLegacy = true;
          break;
        }
      } catch (e) {
        // Table may be empty or error
      }
    }

    if (!hasLegacy && stored === null) {
      // Clean install or already using FPRT
      await settings.set(FILTER_FORMAT_SETTING_KEY, CURRENT_FILTER_FORMAT);
      inMemoryChecked = true;
      return { migrated: false, outcome: "none_needed" };
    }

    if (hasLegacy) {
      console.log(
        "[Startup] Legacy Bloom filter format detected in database. " +
        "Resetting sync state to rebuild all lists into FingerprintSet (FPRT)..."
      );

      const statements = [
        // Purge legacy BLMZ chunks from filter tables so they don't cause deserialization errors
        "DELETE FROM system_list_blooms WHERE system_list_id IN (SELECT system_list_id FROM system_list_blooms WHERE chunk_index = 0 AND substr(bloom_filter_chunk, 1, 4) != X'46505254')",
        "DELETE FROM list_blooms WHERE list_id IN (SELECT list_id FROM list_blooms WHERE chunk_index = 0 AND substr(bloom_filter_chunk, 1, 4) != X'46505254')",
        // Reset system lists so they are re-downloaded and rebuilt
        "UPDATE system_lists SET etag = NULL, last_modified = NULL, last_synced_at = NULL",
        // Reset profile custom lists
        "UPDATE lists SET etag = NULL, last_modified = NULL, last_synced_at = NULL",
        // Mark profiles as needing sync
        "UPDATE profiles SET list_updated_at = NULL WHERE EXISTS (SELECT 1 FROM lists WHERE lists.profile_id = profiles.id)"
      ];

      for (const sql of statements) {
        const res = await env.DB.prepare(sql).bind().run();
        if (!res.success) {
          console.warn(`[Startup] Warning: migration statement failed: ${sql}`);
        }
      }

      // Also clean up obsolete bloom_params setting if present
      try {
        await env.DB.prepare("DELETE FROM system_settings WHERE key = 'bloom_params'").bind().run();
      } catch {}

      await settings.set(FILTER_FORMAT_SETTING_KEY, CURRENT_FILTER_FORMAT);
      inMemoryChecked = true;
      console.log("[Startup] Filter migration to FPRT successfully initiated.");
      return { migrated: true, outcome: "migrated" };
    }

    await settings.set(FILTER_FORMAT_SETTING_KEY, CURRENT_FILTER_FORMAT);
    inMemoryChecked = true;
    return { migrated: false, outcome: "none_needed" };
  } catch (err) {
    console.error("[Startup] Filter format migration check failed (will retry):", err);
    return { migrated: false, outcome: "failed" };
  }
}

export function resetFilterMigrationCheckForTesting(): void {
  inMemoryChecked = false;
}
