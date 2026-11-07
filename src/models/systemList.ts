/**
 * @file systemList.ts
 * @description Data access model for system-wide shared filter lists, blooms, and AdGuard rules.
 */

import { D1Database } from "@cloudflare/workers-types";
import { SystemList } from "../types";
import { BLOOM_CHUNK_SIZE } from "../utils/bloom";
import { AdGuardPayload } from "../lib/adguard/types";

export class SystemListModel {
  constructor(private db: D1Database) {}

  async getSystemLists(): Promise<SystemList[]> {
    const { results } = await this.db.prepare("SELECT * FROM system_lists ORDER BY id ASC").all<SystemList>();
    return results || [];
  }

  async getSystemListById(id: number): Promise<SystemList | null> {
    return await this.db
      .prepare("SELECT * FROM system_lists WHERE id = ?")
      .bind(id)
      .first<SystemList | null>();
  }

  async getSystemListByUrl(url: string): Promise<SystemList | null> {
    return await this.db
      .prepare("SELECT * FROM system_lists WHERE url = ?")
      .bind(url.trim())
      .first<SystemList | null>();
  }

  async isSystemUrl(url: string): Promise<boolean> {
    const row = await this.getSystemListByUrl(url);
    return row !== null;
  }

  async addSystemList(url: string, name?: string): Promise<{ success: boolean; id?: number }> {
    const trimmed = url.trim();
    const result = await this.db
      .prepare("INSERT INTO system_lists (url, name) VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET name = excluded.name")
      .bind(trimmed, name || null)
      .run();
    const lastRowId = result.meta?.last_row_id;
    if (lastRowId && typeof lastRowId === "number" && lastRowId > 0) {
      return { success: result.success, id: lastRowId };
    }
    const inserted = await this.getSystemListByUrl(trimmed);
    return { success: result.success, id: inserted?.id };
  }

  async updateMetadata(
    id: number,
    fields: {
      etag?: string | null;
      last_modified?: string | null;
      last_synced_at?: number | null;
      sync_error?: string | null;
      rule_count?: number;
    }
  ): Promise<boolean> {
    const sets: string[] = [];
    const values: any[] = [];

    if (fields.etag !== undefined) {
      sets.push("etag = ?");
      values.push(fields.etag);
    }
    if (fields.last_modified !== undefined) {
      sets.push("last_modified = ?");
      values.push(fields.last_modified);
    }
    if (fields.last_synced_at !== undefined) {
      sets.push("last_synced_at = ?");
      values.push(fields.last_synced_at);
    }
    if (fields.sync_error !== undefined) {
      sets.push("sync_error = ?");
      values.push(fields.sync_error);
    }
    if (fields.rule_count !== undefined) {
      sets.push("rule_count = ?");
      values.push(fields.rule_count);
    }

    if (sets.length === 0) return true;

    values.push(id);
    const sql = `UPDATE system_lists SET ${sets.join(", ")} WHERE id = ?`;
    const result = await this.db.prepare(sql).bind(...values).run();
    return result.success;
  }

  // ─── System List Bloom Filter Storage ──────────────────────────────────────

  async clearSystemListBloom(systemListId: number): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM system_list_blooms WHERE system_list_id = ?")
      .bind(systemListId)
      .run();
    return result.success;
  }

  async upsertSystemListBloom(systemListId: number, bloomFilter: ArrayBuffer, now: number): Promise<boolean> {
    const uint8Array = new Uint8Array(bloomFilter);
    const statements = [];

    statements.push(
      this.db.prepare("DELETE FROM system_list_blooms WHERE system_list_id = ?").bind(systemListId)
    );

    let chunkIndex = 0;
    for (let offset = 0; offset < uint8Array.length; offset += BLOOM_CHUNK_SIZE) {
      const chunkData = uint8Array.slice(offset, offset + BLOOM_CHUNK_SIZE).buffer as ArrayBuffer;
      statements.push(
        this.db.prepare(
          "INSERT INTO system_list_blooms (system_list_id, chunk_index, bloom_filter_chunk, updated_at) VALUES (?, ?, ?, ?)"
        ).bind(systemListId, chunkIndex, chunkData, now)
      );
      chunkIndex++;
    }

    const results = await this.db.batch(statements);
    return results.every(r => r.success);
  }

  async getSystemListBloom(systemListId: number): Promise<ArrayBuffer | null> {
    const { results } = await this.db.prepare(
      "SELECT bloom_filter_chunk FROM system_list_blooms WHERE system_list_id = ? ORDER BY chunk_index ASC"
    ).bind(systemListId).all<{ bloom_filter_chunk: ArrayBuffer }>();

    if (!results || results.length === 0) return null;

    const totalLength = results.reduce((acc, row) => {
      const len = row.bloom_filter_chunk.byteLength ?? (row.bloom_filter_chunk as any).length;
      return acc + len;
    }, 0);
    const combined = new Uint8Array(totalLength);

    let offset = 0;
    for (const row of results) {
      const chunk = new Uint8Array(row.bloom_filter_chunk);
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return combined.buffer as ArrayBuffer;
  }

  // ─── System List AdGuard Extended Rules Storage ───────────────────────────

  async getSystemListAdguard(systemListId: number): Promise<AdGuardPayload | null> {
    const row = await this.db.prepare(
      "SELECT payload FROM system_list_adguard_rules WHERE system_list_id = ?"
    ).bind(systemListId).first<{ payload: string }>();

    if (!row || !row.payload) return null;
    try {
      return JSON.parse(row.payload) as AdGuardPayload;
    } catch {
      return null;
    }
  }

  async upsertSystemListAdguard(systemListId: number, payload: AdGuardPayload, now: number): Promise<boolean> {
    const jsonStr = JSON.stringify(payload);
    const result = await this.db.prepare(
      `INSERT INTO system_list_adguard_rules (system_list_id, payload, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(system_list_id) DO UPDATE SET
         payload = excluded.payload,
         updated_at = excluded.updated_at`
    ).bind(systemListId, jsonStr, now).run();

    return result.success;
  }

  async clearSystemListAdguard(systemListId: number): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM system_list_adguard_rules WHERE system_list_id = ?")
      .bind(systemListId)
      .run();
    return result.success;
  }
}

