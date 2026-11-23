/**
 * @file dbWorker.ts
 * @description Worker-thread entry point that owns ONE SQLite connection.
 *
 * node:sqlite is synchronous: every query blocks the thread it runs on. In Serverfull mode that thread
 * also serves UDP / DoT / DoH, so a big DELETE, a WAL checkpoint, an incremental_vacuum or a heavy
 * analytics query used to stall DNS resolution. This file runs those calls on a separate thread;
 * the main thread (see workerDb.ts) only sends a message and awaits the reply.
 *
 * Two roles share the same database file (WAL mode allows readers to run beside the single writer):
 *  - writer: INSERT / UPDATE / DELETE, transactions (batch), maintenance (reclaim / vacuum / checkpoint)
 *  - reader: SELECT statements, so dashboard / config / filter-blob reads never queue behind a write
 *
 * Wire protocol: main -> worker `{ id, op, ... }`, worker -> main `{ id, ok, result | error }`.
 * BLOB values travel as ArrayBuffer / Uint8Array in the transfer list (zero copy).
 */

import { parentPort, workerData } from 'node:worker_threads';
import { Buffer } from 'node:buffer';
import { DatabaseSync, StatementSync } from 'node:sqlite';

type Role = 'writer' | 'reader';
type Row = Record<string, unknown>;

const { dbPath, role } = workerData as { dbPath: string; role: Role };
const port = parentPort!;

/** The -wal file is truncated back to this size whenever a checkpoint completes (same as db.ts). */
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

const envNum = (key: string, fallback: number): number => Number(process.env[key]) || fallback;

// ── Connection setup ────────────────────────────────────────────────────────────────────────────
// Migrations and the one-time auto_vacuum conversion already ran on the main thread (initServerfullDb)
// before any socket was opened, so these connections only apply per-connection pragmas.
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA temp_store = MEMORY;');
db.exec(`PRAGMA mmap_size = ${envNum('SQLITE_MMAP_SIZE_BYTES', 67108864)};`);
if (role === 'writer') {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`PRAGMA cache_size = -${envNum('SQLITE_CACHE_SIZE_KB', 32000)};`);
} else {
  db.exec(`PRAGMA cache_size = -${envNum('SQLITE_READER_CACHE_SIZE_KB', 16000)};`);
  db.exec('PRAGMA query_only = ON;'); // a misrouted write fails loudly instead of racing the writer
}

// ── Prepared statement LRU (avoids re-parsing the same SQL on every query) ─────────────────────
const STMT_CACHE_MAX = 256;
const stmtCache = new Map<string, StatementSync>();

function prep(sql: string): StatementSync {
  const hit = stmtCache.get(sql);
  if (hit) {
    stmtCache.delete(sql);
    stmtCache.set(sql, hit);
    return hit;
  }
  const stmt = db.prepare(sql);
  stmtCache.set(sql, stmt);
  if (stmtCache.size > STMT_CACHE_MAX) {
    const oldest = stmtCache.keys().next().value;
    if (oldest !== undefined) stmtCache.delete(oldest);
  }
  return stmt;
}

// ── Value conversion ────────────────────────────────────────────────────────────────────────────
const toParams = (params: unknown[] | undefined): any[] =>
  (params ?? []).map((v) => (v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v));

/** BLOB -> standalone ArrayBuffer (what Cloudflare D1 returns), queued for zero-copy transfer. */
function outVal(v: unknown, transfer: Set<ArrayBuffer>): unknown {
  if (v instanceof Uint8Array) {
    const ab =
      v.byteOffset === 0 && v.buffer instanceof ArrayBuffer && v.byteLength === v.buffer.byteLength
        ? v.buffer
        : (new Uint8Array(v).buffer as ArrayBuffer); // new Uint8Array(typedArray) copies the viewed bytes only
    transfer.add(ab);
    return ab;
  }
  return v;
}

function outRow(row: Row, transfer: Set<ArrayBuffer>): Row {
  const o: Row = {};
  for (const k in row) o[k] = outVal(row[k], transfer);
  return o;
}

const runInfo = (r: { changes: number | bigint; lastInsertRowid: number | bigint }) => ({
  changes: Number(r.changes),
  lastInsertRowid: Number(r.lastInsertRowid),
});

// ── Maintenance (ported from NodeD1Database.reclaimSpace, now off the DNS thread) ──────────────
let reclaiming = false;

const pragmaInt = (name: string): number => {
  const row = db.prepare(`PRAGMA ${name}`).get() as Row | undefined;
  return row ? Number(Object.values(row)[0]) : 0;
};

interface ReclaimOptions {
  chunkPages?: number;
  minFreePages?: number;
  stopBelowPages?: number;
  maxMs?: number;
}

async function reclaim(o: ReclaimOptions = {}) {
  const chunkPages = Math.max(1, Math.floor(o.chunkPages ?? 1000));
  const minFreePages = Math.max(1, Math.floor(o.minFreePages ?? 2048));
  const stopBelowPages = Math.max(0, Math.floor(o.stopBelowPages ?? 256));
  const maxMs = o.maxMs ?? 30_000;

  if (reclaiming) return { reclaimedPages: 0, remainingFreePages: pragmaInt('freelist_count'), skipped: 'busy' };
  if (pragmaInt('auto_vacuum') !== 2) {
    return { reclaimedPages: 0, remainingFreePages: pragmaInt('freelist_count'), skipped: 'not-incremental' };
  }
  const initialFree = pragmaInt('freelist_count');
  if (initialFree < minFreePages) {
    return { reclaimedPages: 0, remainingFreePages: initialFree, skipped: 'below-threshold' };
  }

  reclaiming = true;
  const startedAt = Date.now();
  let remaining = initialFree;
  try {
    while (remaining > stopBelowPages && Date.now() - startedAt < maxMs) {
      db.exec(`PRAGMA incremental_vacuum(${chunkPages});`);
      remaining = pragmaInt('freelist_count');
      // Yield so queued writes (log flush, API calls) interleave between chunks instead of waiting for the whole job.
      await new Promise<void>((r) => setImmediate(r));
    }
    db.exec('PRAGMA wal_checkpoint(PASSIVE);');
  } catch (err) {
    console.warn('[SQLite D1 worker] reclaimSpace warning:', err);
    remaining = pragmaInt('freelist_count');
  } finally {
    reclaiming = false;
  }
  return { reclaimedPages: Math.max(0, initialFree - remaining), remainingFreePages: remaining };
}

// ── Request dispatch ────────────────────────────────────────────────────────────────────────────
interface Req {
  id: number;
  op: string;
  sql?: string;
  params?: unknown[];
  stmts?: { sql: string; params?: unknown[] }[];
  options?: ReclaimOptions;
}

async function dispatch(m: Req, transfer: Set<ArrayBuffer>): Promise<unknown> {
  switch (m.op) {
    case 'first': {
      const row = prep(m.sql!).get(...toParams(m.params)) as Row | undefined;
      return row ? outRow(row, transfer) : null;
    }
    case 'all': {
      const rows = prep(m.sql!).all(...toParams(m.params)) as Row[];
      return rows.map((r) => outRow(r, transfer));
    }
    case 'raw': {
      const rows = prep(m.sql!).all(...toParams(m.params)) as Row[];
      return {
        columns: rows.length > 0 ? Object.keys(rows[0]) : [],
        rows: rows.map((r) => Object.values(r).map((v) => outVal(v, transfer))),
      };
    }
    case 'run':
      return runInfo(prep(m.sql!).run(...toParams(m.params)));
    case 'batch': {
      // Fully synchronous: nothing else can run on this worker between BEGIN and COMMIT.
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = m.stmts!.map((s) => runInfo(prep(s.sql).run(...toParams(s.params))));
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    }
    case 'exec':
      db.exec(m.sql!);
      return null;
    case 'reclaim':
      return reclaim(m.options);
    case 'vacuum':
      db.exec('VACUUM;');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      return null;
    case 'close':
      stmtCache.clear();
      try {
        db.close();
      } catch {
        /* ignore */
      }
      setImmediate(() => port.close()); // lets the worker exit once the ack below has been sent
      return null;
    default:
      throw new Error(`Unknown DB worker op: ${m.op}`);
  }
}

port.on('message', async (m: Req) => {
  const transfer = new Set<ArrayBuffer>();
  try {
    const result = await dispatch(m, transfer);
    port.postMessage({ id: m.id, ok: true, result }, [...transfer]);
  } catch (err: any) {
    port.postMessage({
      id: m.id,
      ok: false,
      error: {
        message: String(err?.message ?? err),
        name: err?.name,
        code: err?.code,
        errcode: err?.errcode,
      },
    });
  }
});

port.postMessage({ type: 'ready', role });
