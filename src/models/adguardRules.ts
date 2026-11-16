/**
 * @file adguardRules.ts
 * @description Data access model for list-level AdGuard extended rules (exceptions, rewrites, and patterns).
 *
 * Profile-level AdGuard tables (profile_adguard_rules / _staging) were retired together with
 * the combined profile Bloom filter; filtering now operates per-list. Only list-level storage remains.
 */

import { D1Database } from "@cloudflare/workers-types";
import { AdGuardPayload } from "../lib/adguard/types";

export class AdguardRulesModel {
  constructor(private db: D1Database) {}

  // ─── List-Level Operations ────────────────────────────────────────────────

  /**
   * Upserts the AdGuard extended rules payload for a specific subscription list.
   */
  async upsertListRules(listId: number, payload: AdGuardPayload, now: number): Promise<boolean> {
    const jsonStr = JSON.stringify(payload);
    const result = await this.db.prepare(
      `INSERT INTO list_adguard_rules (list_id, payload, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(list_id) DO UPDATE SET
         payload = excluded.payload,
         updated_at = excluded.updated_at`
    ).bind(listId, jsonStr, now).run();

    return result.success;
  }

  /**
   * Retrieves the AdGuard extended rules payload for a specific list.
   */
  async getListRules(listId: number): Promise<AdGuardPayload | null> {
    const row = await this.db.prepare(
      "SELECT payload FROM list_adguard_rules WHERE list_id = ?"
    ).bind(listId).first<{ payload: string }>();

    if (!row || !row.payload) return null;
    try {
      return JSON.parse(row.payload) as AdGuardPayload;
    } catch {
      return null;
    }
  }

  /** True when the stored payload contains any rule; avoids JSON.parse of the whole payload. */
  async hasListRules(listId: number): Promise<boolean> {
    const emptyLen = JSON.stringify({ exceptions: [], rewrites: {}, patterns: [] }).length;
    const row = await this.db.prepare(
      "SELECT 1 AS present FROM list_adguard_rules WHERE list_id = ? AND length(payload) > ? LIMIT 1"
    ).bind(listId, emptyLen).first<{ present: number }>();
    return !!row;
  }

  /**
   * Deletes the AdGuard extended rules for a specific list.
   */
  async deleteListRules(listId: number): Promise<boolean> {
    const result = await this.db.prepare(
      "DELETE FROM list_adguard_rules WHERE list_id = ?"
    ).bind(listId).run();
    return result.success;
  }
}
