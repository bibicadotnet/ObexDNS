import { D1Database } from "@cloudflare/workers-types";
import { FILTER_CHUNK_SIZE, FPRT_HEADER_SIZE } from "../utils/fingerprintSet";

export class ProfileFilterModel {
  constructor(private db: D1Database) {}

  async clearProfileFilters(profileId: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM profile_blooms WHERE profile_id = ?").bind(profileId).run();
    return result.success;
  }

  async upsertProfileFilter(profileId: string, filterBuffer: ArrayBuffer, now: number): Promise<boolean> {
    const uint8Array = new Uint8Array(filterBuffer);
    const statements = [];

    // Delete existing chunks to replace them entirely
    statements.push(
      this.db.prepare("DELETE FROM profile_blooms WHERE profile_id = ?").bind(profileId)
    );

    // Insert new chunks (<= 1.5MB per chunk, <= 2MB D1 limit)
    let chunkIndex = 0;
    for (let offset = 0; offset < uint8Array.length; offset += FILTER_CHUNK_SIZE) {
      const chunkData = uint8Array.slice(offset, offset + FILTER_CHUNK_SIZE).buffer as ArrayBuffer;
      statements.push(
        this.db.prepare(
          "INSERT INTO profile_blooms (profile_id, chunk_index, bloom_filter_chunk, updated_at) VALUES (?, ?, ?, ?)"
        ).bind(profileId, chunkIndex, chunkData, now)
      );
      chunkIndex++;
    }

    const results = await this.db.batch(statements);
    return results.every(r => r.success);
  }

  /** First FPRT_HEADER_SIZE bytes of the active filter. */
  async getProfileFilterHeader(profileId: string): Promise<Uint8Array | null> {
    const row = await this.db.prepare(
      `SELECT substr(bloom_filter_chunk, 1, ${FPRT_HEADER_SIZE}) AS head FROM profile_blooms WHERE profile_id = ? AND chunk_index = 0`
    ).bind(profileId).first<{ head: ArrayBuffer | Uint8Array | null }>();
    if (!row || !row.head) return null;
    return row.head instanceof Uint8Array ? row.head : new Uint8Array(row.head);
  }

  async getProfileFilter(profileId: string): Promise<ArrayBuffer | null> {
    const { results } = await this.db.prepare(
      "SELECT bloom_filter_chunk FROM profile_blooms WHERE profile_id = ? ORDER BY chunk_index ASC"
    ).bind(profileId).all<{ bloom_filter_chunk: ArrayBuffer }>();

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

  async clearStagingFilter(profileId: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM profile_blooms_staging WHERE profile_id = ?").bind(profileId).run();
    return result.success;
  }

  async upsertStagingFilter(profileId: string, filterBuffer: ArrayBuffer, now: number): Promise<boolean> {
    const uint8Array = new Uint8Array(filterBuffer);
    const statements = [];

    statements.push(
      this.db.prepare("DELETE FROM profile_blooms_staging WHERE profile_id = ?").bind(profileId)
    );

    let chunkIndex = 0;
    for (let offset = 0; offset < uint8Array.length; offset += FILTER_CHUNK_SIZE) {
      const chunkData = uint8Array.slice(offset, offset + FILTER_CHUNK_SIZE).buffer as ArrayBuffer;
      statements.push(
        this.db.prepare(
          "INSERT INTO profile_blooms_staging (profile_id, chunk_index, bloom_filter_chunk, updated_at) VALUES (?, ?, ?, ?)"
        ).bind(profileId, chunkIndex, chunkData, now)
      );
      chunkIndex++;
    }

    const results = await this.db.batch(statements);
    return results.every(r => r.success);
  }

  async getStagingFilter(profileId: string): Promise<ArrayBuffer | null> {
    const { results } = await this.db.prepare(
      "SELECT bloom_filter_chunk FROM profile_blooms_staging WHERE profile_id = ? ORDER BY chunk_index ASC"
    ).bind(profileId).all<{ bloom_filter_chunk: ArrayBuffer }>();

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

  async promoteStagingToActive(profileId: string, now: number): Promise<boolean> {
    const statements = [
      this.db.prepare("DELETE FROM profile_blooms WHERE profile_id = ?").bind(profileId),
      this.db.prepare(`
        INSERT INTO profile_blooms (profile_id, chunk_index, bloom_filter_chunk, updated_at)
        SELECT profile_id, chunk_index, bloom_filter_chunk, ?
        FROM profile_blooms_staging
        WHERE profile_id = ?
      `).bind(now, profileId),
      this.db.prepare("DELETE FROM profile_blooms_staging WHERE profile_id = ?").bind(profileId)
    ];

    const results = await this.db.batch(statements);
    return results.every(r => r.success);
  }
}
