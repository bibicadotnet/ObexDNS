/**
 * @file workerDb.ts
 * @description D1-compatible database whose SQLite connections live in worker threads (see dbWorker.ts).
 *
 * Same interface as NodeD1Database, so no model changes: the main thread only posts a message and
 * awaits the reply, and never blocks on SQLite. Layout:
 *   - 1 writer thread: run / batch / exec / maintenance (serialised, so batch() is atomic)
 *   - N reader threads (default 1): SELECT statements, in parallel with the writer (WAL)
 *
 * Consistency: a read issued AFTER the awaited write has resolved always sees it (the reader opens a new
 * snapshot per statement). Fire-and-forget writes followed immediately by a read give no ordering guarantee.
 *
 * Disable with DB_WORKER=0. If the worker bundle is missing or fails to start, createWorkerDb() returns
 * null and the caller keeps the in-process NodeD1Database.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type {
  D1Database,
  D1DatabaseSession,
  D1ExecResult,
  D1PreparedStatement,
  D1Result,
} from '@cloudflare/workers-types';
import type { ReclaimSpaceOptions, ReclaimSpaceResult } from './db';

const START_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 5_000;

interface RunInfo {
  changes: number;
  lastInsertRowid: number;
}

// ── One worker thread ───────────────────────────────────────────────────────────────────────────
class DbWorkerChannel {
  private worker: Worker | null = null;
  private starting: Promise<void> | null = null;
  private closing = false;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly file: string,
    private readonly dbPath: string,
    readonly role: 'writer' | 'reader'
  ) {}

  start(): Promise<void> {
    if (this.worker) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      let ready = false;
      const w = new Worker(this.file, { workerData: { dbPath: this.dbPath, role: this.role } });
      const timer = setTimeout(() => {
        reject(new Error(`DB ${this.role} worker did not start within ${START_TIMEOUT_MS / 1000}s`));
        void w.terminate();
      }, START_TIMEOUT_MS);

      w.on('message', (m: any) => {
        if (m?.type === 'ready') {
          ready = true;
          clearTimeout(timer);
          this.worker = w;
          resolve();
          return;
        }
        const p = this.pending.get(m?.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) {
          p.resolve(m.result);
        } else {
          const err = new Error(m.error?.message ?? 'DB worker error');
          Object.assign(err, { code: m.error?.code, errcode: m.error?.errcode });
          if (m.error?.name) err.name = m.error.name;
          p.reject(err);
        }
      });
      w.on('error', (err) => {
        if (!ready) {
          clearTimeout(timer);
          reject(err);
        } else {
          console.error(`[SQLite D1] ${this.role} worker error:`, err);
        }
      });
      w.on('exit', (code) => {
        clearTimeout(timer);
        if (!ready) reject(new Error(`DB ${this.role} worker exited during startup (code ${code})`));
        if (this.worker === w) this.worker = null;
        const failure = new Error(`DB ${this.role} worker exited (code ${code})`);
        for (const p of this.pending.values()) p.reject(failure);
        this.pending.clear();
        if (!this.closing) console.error(`[SQLite D1] ${this.role} worker exited unexpectedly (code ${code}); it restarts on the next query.`);
      });
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async request<T>(msg: Record<string, unknown>, transfer: ArrayBuffer[] = []): Promise<T> {
    if (this.closing && msg.op !== 'close') throw new Error('Database is closed');
    if (!this.worker) await this.start(); // lazy restart after a crash
    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...msg, id }, transfer);
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    const w = this.worker;
    if (!w) return;
    const exited = new Promise<void>((r) => w.once('exit', () => r()));
    const timeout = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    try {
      await Promise.race([this.request({ op: 'close' }).catch(() => {}), timeout(CLOSE_TIMEOUT_MS)]);
    } catch {
      /* ignore */
    }
    await Promise.race([exited, timeout(2000)]);
    await w.terminate().catch(() => {});
  }
}

// ── Parameter / result helpers ──────────────────────────────────────────────────────────────────
/** Same rules as toSqliteParam in db.ts, but binary values stay cheap views until they are sent. */
function normalizeParam(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (val instanceof ArrayBuffer) return new Uint8Array(val);
  if (ArrayBuffer.isView(val)) return new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
  return val;
}

/**
 * Copies each binary param into its own buffer and transfers that copy. Cloning a view would copy the
 * whole backing buffer (e.g. all 15 MB of a filter for each 1.5 MB chunk), and transferring the original
 * would detach memory the caller still owns. The copy keeps statements re-runnable.
 */
function toWire(params: unknown[], transfer: ArrayBuffer[]): unknown[] {
  return params.map((v) => {
    if (v instanceof Uint8Array) {
      const copy = new Uint8Array(v);
      transfer.push(copy.buffer as ArrayBuffer);
      return copy;
    }
    return v;
  });
}

/** SELECT-only statements may run on a reader thread. Anything that could write goes to the writer. */
const isReadSql = (sql: string): boolean =>
  /^\s*(select|with)\b/i.test(sql) && !/\b(insert|update|delete|replace)\b/i.test(sql);

const runMeta = (info: RunInfo): D1Result<any> => ({
  results: [],
  success: true,
  meta: {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: info.changes,
    last_row_id: info.lastInsertRowid,
    changed_db: info.changes > 0,
    changes: info.changes,
  },
});

// ── D1 surface ──────────────────────────────────────────────────────────────────────────────────
export class WorkerD1PreparedStatement {
  params: unknown[] = [];

  constructor(
    private readonly db: WorkerD1Database,
    readonly sql: string
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.params = values.map(normalizeParam);
    return this as unknown as D1PreparedStatement;
  }

  private send<T>(op: 'first' | 'all' | 'raw' | 'run'): Promise<T> {
    const transfer: ArrayBuffer[] = [];
    const msg = { op, sql: this.sql, params: toWire(this.params, transfer) };
    const channel = op !== 'run' && isReadSql(this.sql) ? this.db.pickReader() : this.db.writer;
    return this.logged(channel.request<T>(msg, transfer), op);
  }

  private logged<T>(p: Promise<T>, op: string): Promise<T> {
    return p.catch((err: any) => {
      console.warn(`[SQLite D1] Query error in ${op}(): ${err?.message}\nSQL: ${this.sql}`);
      throw err;
    });
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const row = await this.send<Record<string, unknown> | null>('first');
    if (!row) return null;
    return (colName ? (row[colName] ?? null) : row) as T;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const rows = await this.send<T[]>('all');
    return {
      results: rows,
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: rows.length,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0,
      },
    } as D1Result<T>;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return runMeta(await this.send<RunInfo>('run')) as D1Result<T>;
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<any> {
    const { columns, rows } = await this.send<{ columns: string[]; rows: unknown[][] }>('raw');
    return options?.columnNames && rows.length > 0 ? [columns, ...rows] : rows;
  }
}

export class WorkerD1Database implements D1Database {
  private rr = 0;

  constructor(
    readonly writer: DbWorkerChannel,
    private readonly readers: DbWorkerChannel[],
    readonly dbPath: string
  ) {}

  /** Round-robin over reader threads; with none configured, reads share the writer thread. */
  pickReader(): DbWorkerChannel {
    if (this.readers.length === 0) return this.writer;
    return this.readers[this.rr++ % this.readers.length];
  }

  prepare(query: string): D1PreparedStatement {
    return new WorkerD1PreparedStatement(this, query) as unknown as D1PreparedStatement;
  }

  /** One transaction on the writer thread (BEGIN IMMEDIATE ... COMMIT, ROLLBACK on error). */
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    if (!statements || statements.length === 0) return [];
    const transfer: ArrayBuffer[] = [];
    const stmts = statements.map((s) => {
      if (!(s instanceof WorkerD1PreparedStatement)) {
        throw new Error('WorkerD1Database.batch() only accepts statements created by its own prepare()');
      }
      return { sql: s.sql, params: toWire(s.params, transfer) };
    });
    const out = await this.writer.request<RunInfo[]>({ op: 'batch', stmts }, transfer);
    return out.map((info) => runMeta(info) as D1Result<T>);
  }

  async exec(query: string): Promise<D1ExecResult> {
    await this.writer.request({ op: 'exec', sql: query });
    return { count: 0, duration: 0 };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('dump() is not supported in WorkerD1Database');
  }

  withSession(_constraintOrBookmark?: string): D1DatabaseSession {
    return Object.assign(this, { getBookmark: () => null }) as unknown as D1DatabaseSession;
  }

  /** Gives free pages back to the filesystem in short chunks, entirely on the writer thread. */
  reclaimSpace(options: ReclaimSpaceOptions = {}): Promise<ReclaimSpaceResult> {
    return this.writer.request<ReclaimSpaceResult>({ op: 'reclaim', options });
  }

  /** Offline tooling only. Runs in the background on the writer thread. */
  vacuum(): void {
    this.writer.request({ op: 'vacuum' }).catch((err) => console.warn('[SQLite D1] VACUUM warning:', err));
  }

  /** Flushes queued requests, closes every connection and stops the threads. */
  async close(): Promise<void> {
    await this.writer.close(); // the writer first: its queue (pending logs) drains before the ack
    await Promise.all(this.readers.map((r) => r.close()));
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────────────────────────
const isOff = (v: unknown): boolean => /^(0|off|false|no|none)$/i.test(String(v ?? '').trim());

export interface CreateWorkerDbOptions {
  /** Override the worker bundle path (tests). Defaults to db-worker.mjs next to the running bundle. */
  workerFile?: string;
  /** Reader threads (default env DB_WORKER_READERS or 1; 0 = reads share the writer thread). */
  readers?: number;
}

/**
 * Starts the writer and reader threads. Returns null (caller keeps in-process SQLite) when
 * DB_WORKER is off, the worker bundle is not next to the running file (e.g. dev via tsx), or startup fails.
 */
export async function createWorkerDb(
  dbPath: string,
  options: CreateWorkerDbOptions = {}
): Promise<WorkerD1Database | null> {
  if (isOff(process.env.DB_WORKER)) {
    console.log('[SQLite D1] DB_WORKER is off: SQLite runs on the main thread.');
    return null;
  }

  let file = options.workerFile;
  if (!file) {
    try {
      file = fileURLToPath(new URL('./db-worker.mjs', import.meta.url).href);
    } catch {
      /* not resolvable in this runtime */
    }
  }
  if (!file || !fs.existsSync(file)) {
    console.log('[SQLite D1] DB worker bundle not found next to the running file: SQLite runs on the main thread.');
    return null;
  }

  const readerCount = Math.min(
    4,
    Math.max(0, Math.floor(options.readers ?? (Number(process.env.DB_WORKER_READERS ?? 1) || 0)))
  );
  const writer = new DbWorkerChannel(file, dbPath, 'writer');
  const readers = Array.from({ length: readerCount }, () => new DbWorkerChannel(file!, dbPath, 'reader'));

  try {
    await Promise.all([writer.start(), ...readers.map((r) => r.start())]);
  } catch (err) {
    console.warn('[SQLite D1] DB worker threads failed to start; falling back to main-thread SQLite:', err);
    await Promise.all([writer.close(), ...readers.map((r) => r.close())]).catch(() => {});
    return null;
  }

  console.log(`[SQLite D1] SQLite runs in worker threads (1 writer + ${readerCount} reader): DNS thread never waits on the database.`);
  return new WorkerD1Database(writer, readers, dbPath);
}
