/**
 * @file bloomParams.ts
 * @description One-time, startup-only handling of a changed Bloom configuration.
 *
 * A Bloom filter's bit count (m) and hash count (k) are derived from MAX_SYNC_DOMAINS and
 * BLOOM_FALSE_POSITIVE_RATE. Stored Blooms built with other values still answer lookups correctly
 * (each carries its own m/k in its header), but they cannot be OR-merged into a profile Bloom, and a
 * list that keeps getting HTTP 304 would never be rebuilt with the new size.
 *
 * Instead of checking this on every sync, the effective (m, k) is remembered in system_settings.
 * On startup it is compared once; only when it differs does this module reset the sync state so the
 * normal machinery rebuilds everything:
 *   - system lists:   etag / last_modified / last_synced_at cleared -> the startup sync (and any later
 *                     activation) downloads them again with the new size
 *   - profile lists:  etag / last_modified / last_synced_at cleared and profiles.list_updated_at cleared
 *                     -> cron rebuilds them one list per tick; a profile's merged Bloom is only replaced
 *                     once all of its lists are rebuilt, and the old Blooms keep filtering meanwhile
 * Steady state costs a single settings read at boot.
 */

import type { Env } from "../../types";
import { BloomFilter } from "../bloom";
import { SystemSettingsModel } from "../../models/systemSettings";

export const BLOOM_PARAMS_SETTING_KEY = "bloom_params";

/** Same defaults the sync code falls back to when the variables are absent. */
const DEFAULT_MAX_SYNC_DOMAINS = 1000000;
const DEFAULT_FALSE_POSITIVE_RATE = 0.0001;

export interface BloomParamsMigrationResult {
  /** True when stored Blooms were found/assumed to use other parameters and the reset ran. */
  changed: boolean;
  /** Short machine-readable outcome, handy for logs and tests. */
  outcome: "unchanged" | "initialized" | "reset" | "failed";
  fingerprint: string;
}

/** `m=<bits>;k=<hashes>` for the configuration currently in effect. */
export function currentBloomFingerprint(env: Env): string {
  const maxDomains = Number(env.MAX_SYNC_DOMAINS) || DEFAULT_MAX_SYNC_DOMAINS;
  const falsePositiveRate = Number(env.BLOOM_FALSE_POSITIVE_RATE) || DEFAULT_FALSE_POSITIVE_RATE;
  const { size, hashes } = BloomFilter.computeParams(maxDomains, falsePositiveRate);
  return `m=${size};k=${hashes}`;
}

/**
 * First run after this feature shipped: there is no remembered fingerprint, so look at what is actually
 * stored. One v2 header per Bloom table is enough. Unknown/legacy formats are ignored because the regular
 * "not current version" path already forces those to be re-downloaded.
 *
 * @returns "mismatch" when a stored Bloom was built with other parameters, "match" when at least one was
 *          found and all agree, "none" when there is nothing to compare.
 */
async function inspectStoredBlooms(env: Env, fingerprint: string): Promise<"mismatch" | "match" | "none"> {
  const tables = ["system_list_blooms", "list_blooms", "profile_blooms"];
  let found = false;
  for (const table of tables) {
    const row = await env.DB
      .prepare(`SELECT substr(bloom_filter_chunk, 1, 20) AS head FROM ${table} WHERE chunk_index = 0 LIMIT 1`)
      .bind()
      .first<{ head: ArrayBuffer | Uint8Array | null }>();
    if (!row || !row.head) continue;
    const head = row.head instanceof Uint8Array ? row.head : new Uint8Array(row.head);
    const params = BloomFilter.readHeaderParams(head);
    if (!params) continue;
    found = true;
    if (`m=${params.size};k=${params.hashes}` !== fingerprint) return "mismatch";
  }
  return found ? "match" : "none";
}

/**
 * Compares the configured Bloom parameters with the ones last applied and, if they changed, resets the
 * sync state so everything is rebuilt. Must run before the startup system-list sync.
 */
export async function migrateBloomParamsIfChanged(env: Env): Promise<BloomParamsMigrationResult> {
  const fingerprint = currentBloomFingerprint(env);
  const settings = new SystemSettingsModel(env.DB);

  try {
    const stored = await settings.get(BLOOM_PARAMS_SETTING_KEY);
    if (stored === fingerprint) {
      return { changed: false, outcome: "unchanged", fingerprint };
    }

    if (stored === null) {
      const state = await inspectStoredBlooms(env, fingerprint);
      if (state !== "mismatch") {
        await settings.set(BLOOM_PARAMS_SETTING_KEY, fingerprint);
        console.log(`[Startup] Bloom parameters recorded (${fingerprint}); nothing to rebuild.`);
        return { changed: false, outcome: "initialized", fingerprint };
      }
    }

    console.log(
      `[Startup] Bloom parameters changed (${stored ?? "stored Blooms"} -> ${fingerprint}). ` +
        "Resetting sync state so all lists are rebuilt (old Blooms keep filtering until replaced)."
    );

    const statements = [
      // System lists: re-downloaded by the startup sync, or on first activation by a profile
      "UPDATE system_lists SET etag = NULL, last_modified = NULL, last_synced_at = NULL",
      // Profile lists: full download (no ETag) on their next turn
      "UPDATE lists SET etag = NULL, last_modified = NULL, last_synced_at = NULL",
      // Make every profile that has lists stale so cron walks through them one list per tick
      "UPDATE profiles SET list_updated_at = NULL WHERE EXISTS (SELECT 1 FROM lists WHERE lists.profile_id = profiles.id)"
    ];
    for (const sql of statements) {
      const res = await env.DB.prepare(sql).run();
      if (!res.success) throw new Error(`reset statement failed: ${sql}`);
    }

    // Remember the new parameters only after the reset is durable; a crash before this point just repeats it
    await settings.set(BLOOM_PARAMS_SETTING_KEY, fingerprint);
    return { changed: true, outcome: "reset", fingerprint };
  } catch (err) {
    console.error("[Startup] Bloom parameter check failed (will retry on next start):", err);
    return { changed: false, outcome: "failed", fingerprint };
  }
}
