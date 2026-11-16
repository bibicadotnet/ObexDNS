import { D1Database } from "@cloudflare/workers-types";
import { FILTER_CHUNK_SIZE, FPRT_HEADER_SIZE } from "../utils/fingerprintSet";

export class ListFilterModel {
  constructor(private db: D1Database) {}

  async upsertListFilter(listId: number, filterBuffer: ArrayBuffer, now: number): Promise<boolean> {
    const uint8Array = new Uint8Array(filterBuffer);
    const statements = [];

    // Delete existing chunks for this list
    statements.push(
      this.db.prepare("DELETE FROM list_blooms WHERE list_id = ?").bind(listId)
    );

    // Insert new chunks (<= 1.5MB per chunk, <= 2MB D1 limit)
    let chunkIndex = 0;
    for (let offset = 0; offset < uint8Array.length; offset += FILTER_CHUNK_SIZE) {
      const chunkEnd = Math.min(offset + FILTER_CHUNK_SIZE, uint8Array.length);
      const chunkData = uint8Array.subarray(offset, chunkEnd);
      statements.push(
        this.db.prepare(
          "INSERT INTO list_blooms (list_id, chunk_index, bloom_filter_chunk, updated_at) VALUES (?, ?, ?, ?)"
        ).bind(listId, chunkIndex, chunkData, now)
      );
      chunkIndex++;
    }

    const results = await this.db.batch(statements);
    return results.every(r => r.success);
  }

  /**
   * Whether any filter chunk is stored for this list.
   */
  async hasListFilter(listId: number): Promise<boolean> {
    const row = await this.db.prepare(
      "SELECT 1 AS present FROM list_blooms WHERE list_id = ? LIMIT 1"
    ).bind(listId).first<{ present: number }>();
    return !!row;
  }

  /** First FPRT_HEADER_SIZE bytes of the stored filter; avoids loading all chunks to check version. */
  async getListFilterHeader(listId: number): Promise<Uint8Array | null> {
    const row = await this.db.prepare(
      `SELECT substr(bloom_filter_chunk, 1, ${FPRT_HEADER_SIZE}) AS head FROM list_blooms WHERE list_id = ? AND chunk_index = 0`
    ).bind(listId).first<{ head: ArrayBuffer | Uint8Array | null }>();
    if (!row || !row.head) return null;
    return row.head instanceof Uint8Array ? row.head : new Uint8Array(row.head);
  }

  async getListFilter(listId: number): Promise<ArrayBuffer | null> {
    const { results } = await this.db.prepare(
      "SELECT bloom_filter_chunk FROM list_blooms WHERE list_id = ? ORDER BY chunk_index ASC"
    )
      .bind(listId)
      .all<{ bloom_filter_chunk: ArrayBuffer }>();

    if (!results || results.length === 0) return null;

    if (results.length === 1) {
      const chunk = results[0].bloom_filter_chunk;
      if (chunk instanceof ArrayBuffer) return chunk;
      // D1 may return a Uint8Array (possibly a sub-view); normalize to a standalone
      // ArrayBuffer that respects byteOffset/length instead of the full backing buffer.
      return new Uint8Array(chunk).buffer;
    }

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

  async deleteListFilter(listId: number): Promise<boolean> {
    const result = await this.db.prepare(
      "DELETE FROM list_blooms WHERE list_id = ?"
    )
      .bind(listId)
      .run();
    return result.success;
  }
}
