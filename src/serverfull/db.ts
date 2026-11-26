/**
 * @file db.ts
 * @description SQLite D1Database adapter and automatic schema migration runner for Serverfull mode.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { D1Database, D1PreparedStatement, D1Result, D1ExecResult, D1DatabaseSession } from '@cloudflare/workers-types';
import { getPackageRoot } from './config';
import { yieldToEventLoop } from '../utils/yieldToEventLoop';

/** The -wal file is truncated back to this size whenever a checkpoint completes (bytes). */
export const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Options for NodeD1Database.reclaimSpace().
 */
export interface ReclaimSpaceOptions {
  /** Pages released per incremental_vacuum step (default 256, about 1 MB: a few ms even on a slow disk). */
  chunkPages?: number;
  /** Do nothing unless at least this many free pages exist (default 2048, about 8 MB). */
  minFreePages?: number;
  /** Stop once the freelist is at or below this many pages (default 256). */
  stopBelowPages?: number;
  /** Wall-clock budget in milliseconds (default 30000). Leftover pages are taken by the next call. */
  maxMs?: number;
}

export interface ReclaimSpaceResult {
  reclaimedPages: number;
  remainingFreePages: number;
  /** Why nothing was done, when applicable. */
  skipped?: 'not-incremental' | 'below-threshold' | 'busy';
}

/** Value accepted by the AUTO_VACUUM environment variable. */
export type AutoVacuumMode = 'INCREMENTAL' | 'NONE';

/**
 * Parses the AUTO_VACUUM environment variable.
 * Unset or any unrecognised value means INCREMENTAL (the default).
 * `NONE`, `OFF`, `FALSE`, `NO` or `0` keep the legacy behaviour (no auto_vacuum, no startup VACUUM).
 */
export function resolveAutoVacuumMode(raw: string | undefined): AutoVacuumMode {
  const v = (raw ?? '').trim().toUpperCase();
  if (v === 'NONE' || v === 'OFF' || v === 'FALSE' || v === 'NO' || v === '0') return 'NONE';
  return 'INCREMENTAL';
}

function fileSizeOrZero(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Free bytes on the filesystem holding `dir`, or null when it cannot be determined. */
function freeDiskBytes(dir: string): number | null {
  try {
    const st = (fs as unknown as { statfsSync?: (p: string) => { bavail: number | bigint; bsize: number | bigint } }).statfsSync?.(dir);
    if (!st) return null;
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

function readPragmaInt(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  return row ? Number(Object.values(row)[0]) : 0;
}

/** Extra free disk space required on top of the measured need, in bytes. */
const VACUUM_DISK_MARGIN_BYTES = 64 * 1024 * 1024;

/** Live data size above which the startup conversion is announced as potentially slow. */
const VACUUM_SLOW_WARNING_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * One-time conversion of an existing database (auto_vacuum = NONE) to auto_vacuum = INCREMENTAL.
 *
 * SQLite only applies a new auto_vacuum mode to an existing file after a full VACUUM, so this runs
 * one. It is called at startup, before any listening socket is opened: DNS is unavailable while it
 * runs (about 1 second per 150 MB on an SSD, much longer on a hard disk), which is why it is
 * logged and can be disabled with AUTO_VACUUM=NONE.
 *
 * Disk space (measured): VACUUM peaks at 3x the live data in total, i.e. it needs 2x the live data
 * as FREE space (a full copy in a temporary file plus a full copy in the -wal file). SQLite puts
 * that temporary file in /var/tmp by default, which in a container is often a different, smaller
 * filesystem than the data volume, so `temp_store_directory` is pointed at the database directory
 * for the duration. The free-space check then covers a single filesystem. `process.env.SQLITE_TMPDIR`
 * cannot be used for this: SQLite ignores changes made to it after the process started.
 *
 * Other safety: `temp_store` is switched to FILE for the duration, because with MEMORY the VACUUM
 * working set is held in RAM (about the size of the database). A failure, or the process being
 * killed midway, leaves the original database untouched (it just stays unconverted).
 */
export function migrateToIncrementalAutoVacuum(
  rawDb: DatabaseSync,
  dbPath: string
): 'migrated' | 'already' | 'skipped' {
  if (readPragmaInt(rawDb, 'auto_vacuum') !== 0) return 'already';

  // Live data (what VACUUM actually copies), not the file size: a file full of free pages is cheap.
  const pageSize = readPragmaInt(rawDb, 'page_size');
  const liveBytes = Math.max(0, readPragmaInt(rawDb, 'page_count') - readPragmaInt(rawDb, 'freelist_count')) * pageSize;
  const dataDir = path.dirname(path.resolve(dbPath));
  const freeBytes = freeDiskBytes(dataDir);
  const requiredBytes = Math.ceil(liveBytes * 2.2) + VACUUM_DISK_MARGIN_BYTES;
  const mb = (n: number): string => `${(n / 1048576).toFixed(0)} MB`;

  if (freeBytes === null) {
    console.warn('[SQLite D1] Skipping one-time auto_vacuum conversion: free disk space cannot be determined.');
    return 'skipped';
  }
  if (freeBytes < requiredBytes) {
    console.warn(
      `[SQLite D1] Skipping one-time auto_vacuum conversion: needs about ${mb(requiredBytes)} free on the data volume (2x the ${mb(liveBytes)} of live data plus margin), only ${mb(freeBytes)} available.`
    );
    return 'skipped';
  }

  console.log(
    `[SQLite D1] Converting database (${mb(liveBytes)} of live data) to auto_vacuum=INCREMENTAL with a one-time VACUUM. DNS is unavailable until this finishes.`
  );
  if (liveBytes > VACUUM_SLOW_WARNING_BYTES) {
    console.warn(
      '[SQLite D1] This database is large and the conversion may take several minutes. If your container orchestrator restarts the service while it is starting, set AUTO_VACUUM=NONE and convert offline instead (see the maintenance docs).'
    );
  }

  const startedAt = Date.now();
  try {
    rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    rawDb.exec('PRAGMA temp_store = FILE;');
    // Keep the temporary copy on the volume whose free space was just checked.
    rawDb.exec(`PRAGMA temp_store_directory = '${dataDir.replace(/'/g, "''")}';`);
    rawDb.exec('PRAGMA auto_vacuum = INCREMENTAL;');
    rawDb.exec('VACUUM;');
  } catch (err: unknown) {
    console.warn('[SQLite D1] One-time auto_vacuum conversion failed; database left unchanged:', err);
    return 'skipped';
  } finally {
    for (const restore of ["PRAGMA temp_store_directory = '';", 'PRAGMA temp_store = MEMORY;']) {
      try {
        rawDb.exec(restore);
      } catch {
        /* ignore */
      }
    }
  }
  try {
    rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    /* non-fatal: journal_size_limit trims the WAL later */
  }
  console.log(`[SQLite D1] auto_vacuum conversion finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (database now ${mb(fileSizeOrZero(dbPath))}).`);
  return 'migrated';
}

/**
 * Normalizes input parameter values to primitive types safely bindable by SQLite and node:sqlite.
 *
 * SQLite natively supports: NULL, INTEGER, REAL, TEXT, and BLOB.
 * node:sqlite accepts:
 *   - null
 *   - number / bigint
 *   - string
 *   - Buffer / Uint8Array (BLOB)
 *
 * In older Node.js versions (< v26.8.0) and Bun, node:sqlite rejects raw ArrayBuffer instances
 * with "TypeError: Provided value cannot be bound to SQLite parameter (ERR_INVALID_ARG_TYPE)".
 * It also rejects boolean and undefined values.
 *
 * This normalizer converts:
 *   - undefined -> null
 *   - boolean -> 1 or 0
 *   - ArrayBuffer -> Buffer.from(val)
 *   - ArrayBufferView (Uint8Array, DataView, etc.) -> Buffer.from(val.buffer, val.byteOffset, val.byteLength)
 */
export function toSqliteParam(val: unknown): any {
  if (val === null || val === undefined) {
    return null;
  }
  if (typeof val === 'boolean') {
    return val ? 1 : 0;
  }
  if (val instanceof ArrayBuffer) {
    return Buffer.from(val);
  }
  if (ArrayBuffer.isView(val)) {
    return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
  }
  return val;
}

/**
 * Normalizes values returned by SQLite into standard Cloudflare D1 types.
 *
 * node:sqlite returns BLOB columns as Uint8Array instances. Cloudflare Workers D1
 * returns BLOB columns as ArrayBuffer instances. Converting Uint8Array to ArrayBuffer
 * guarantees 100% API parity with Workers D1.
 */
export function fromSqliteValue(val: unknown): any {
  if (val instanceof Uint8Array) {
    return val.buffer.slice(val.byteOffset, val.byteOffset + val.byteLength);
  }
  return val;
}

export function fromSqliteRow<T = unknown>(row: Record<string, any>): T {
  const normalized: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    normalized[k] = fromSqliteValue(v);
  }
  return normalized as T;
}

export class NodeD1PreparedStatement implements D1PreparedStatement {
  private params: any[] = [];

  constructor(
    public readonly db: DatabaseSync,
    public readonly sql: string
  ) {}

  bind(...values: any[]): D1PreparedStatement {
    this.params = values.map(toSqliteParam);
    return this as unknown as D1PreparedStatement;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    try {
      const stmt = this.db.prepare(this.sql);
      const row = stmt.get(...this.params) as Record<string, any> | undefined;
      if (!row) return null;
      if (colName) {
        return fromSqliteValue(row[colName] ?? null) as T;
      }
      return fromSqliteRow<T>(row);
    } catch (err: any) {
      console.warn(`[SQLite D1] Query error in first(): ${err.message}\nSQL: ${this.sql}`);
      throw err;
    }
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    try {
      const stmt = this.db.prepare(this.sql);
      const rows = stmt.all(...this.params) as Record<string, any>[];
      const normalizedRows = rows.map(r => fromSqliteRow<T>(r));
      return {
        results: normalizedRows,
        success: true,
        meta: {
          duration: 0,
          size_after: 0,
          rows_read: rows.length,
          rows_written: 0,
          last_row_id: 0,
          changed_db: false,
          changes: 0
        }
      };
    } catch (err: any) {
      console.warn(`[SQLite D1] Query error in all(): ${err.message}\nSQL: ${this.sql}`);
      throw err;
    }
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    try {
      const stmt = this.db.prepare(this.sql);
      const result = stmt.run(...this.params);
      const changes = Number(result.changes);
      const lastInsertRowid = Number(result.lastInsertRowid);
      return {
        results: [],
        success: true,
        meta: {
          duration: 0,
          size_after: 0,
          rows_read: 0,
          rows_written: changes,
          last_row_id: lastInsertRowid,
          changed_db: changes > 0,
          changes: changes
        }
      };
    } catch (err: any) {
      console.warn(`[SQLite D1] Query error in run(): ${err.message}\nSQL: ${this.sql}`);
      throw err;
    }
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<any> {
    try {
      const stmt = this.db.prepare(this.sql);
      const rows = stmt.all(...this.params) as Record<string, any>[];
      const rawRows = rows.map(r => Object.values(r).map(fromSqliteValue));
      if (options?.columnNames && rows.length > 0) {
        return [Object.keys(rows[0]), ...rawRows];
      }
      return rawRows;
    } catch (err: any) {
      console.warn(`[SQLite D1] Query error in raw(): ${err.message}\nSQL: ${this.sql}`);
      throw err;
    }
  }
}

export class NodeD1Database implements D1Database {
  private transactionLock: Promise<void> = Promise.resolve();

  constructor(
    public readonly rawDb: DatabaseSync,
    public readonly dbPath?: string
  ) {}


  /** True while a reclaimSpace() run is in progress, so two runs never overlap. */
  private reclaiming = false;

  /** Worker thread that runs WAL checkpoints off the event loop, or null when not running. */
  private checkpointWorker: Worker | null = null;

  /** Default SQLite value, restored if the checkpoint worker is lost so the WAL can never grow unchecked. */
  private static readonly DEFAULT_AUTOCHECKPOINT_PAGES = 1000;

  /**
   * Moves WAL checkpointing off the main thread (call once, from the long-running server process only).
   *
   * The main connection gets wal_autocheckpoint = 0, so COMMIT no longer copies the WAL into the database file
   * and fsyncs it on the event loop; a worker thread with its own connection does that with
   * wal_checkpoint(PASSIVE) (see walWorker.mjs). If the worker file is missing or the worker dies, the default
   * auto-checkpoint is restored and the server keeps running exactly as before.
   *
   * @returns true when the worker is running.
   */
  startBackgroundCheckpoint(pollMs = 2000): boolean {
    if (this.checkpointWorker) return true;
    if (!this.dbPath) return false;

    let workerUrl: URL;
    try {
      workerUrl = new URL('./walWorker.mjs', import.meta.url);
      if (!fs.existsSync(fileURLToPath(workerUrl))) {
        console.warn('[SQLite D1] walWorker.mjs not found next to the server bundle; WAL checkpoints stay on the main thread.');
        return false;
      }
    } catch (err: unknown) {
      console.warn('[SQLite D1] Cannot locate the WAL checkpoint worker; checkpoints stay on the main thread:', err);
      return false;
    }

    try {
      this.rawDb.exec('PRAGMA wal_autocheckpoint = 0;');
      const worker = new Worker(workerUrl, { workerData: { dbPath: this.dbPath, pollMs } });
      this.checkpointWorker = worker;

      const lost = (why: string, err?: unknown): void => {
        if (this.checkpointWorker !== worker) return; // already stopped on purpose
        this.checkpointWorker = null;
        try {
          this.rawDb.exec(`PRAGMA wal_autocheckpoint = ${NodeD1Database.DEFAULT_AUTOCHECKPOINT_PAGES};`);
        } catch {
          /* connection already closed */
        }
        console.warn(`[SQLite D1] WAL checkpoint worker ${why}; auto-checkpoint on the main thread restored.`, err ?? '');
      };
      worker.on('error', (err: unknown) => lost('crashed', err));
      worker.on('exit', () => lost('exited'));
      worker.on('message', (msg: { type?: string; message?: string }) => {
        if (msg?.type === 'error') console.warn('[SQLite D1] WAL checkpoint failed:', msg.message);
      });
      worker.unref();
      return true;
    } catch (err: unknown) {
      this.checkpointWorker = null;
      try {
        this.rawDb.exec(`PRAGMA wal_autocheckpoint = ${NodeD1Database.DEFAULT_AUTOCHECKPOINT_PAGES};`);
      } catch {
        /* ignore */
      }
      console.warn('[SQLite D1] Could not start the WAL checkpoint worker; checkpoints stay on the main thread:', err);
      return false;
    }
  }

  /** Stops the checkpoint worker and waits (up to timeoutMs) for it to release its connection. Call before close(). */
  async stopBackgroundCheckpoint(timeoutMs = 2000): Promise<void> {
    const worker = this.checkpointWorker;
    if (!worker) return;
    this.checkpointWorker = null; // marks the stop as intentional for the exit handler
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void worker.terminate().finally(resolve);
      }, timeoutMs);
      worker.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        worker.postMessage({ type: 'stop' });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /**
   * Runs `fn` while holding the connection-wide lock shared with batch(), so it can never start
   * in the middle of another caller's open transaction (which would make e.g. wal_checkpoint fail
   * with "database table is locked").
   */
  private async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const previousLock = this.transactionLock;
    let releaseLock!: () => void;
    this.transactionLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previousLock;
    try {
      return await fn();
    } finally {
      releaseLock();
    }
  }

  private pragmaInt(name: string): number {
    return readPragmaInt(this.rawDb, name);
  }

  /**
   * Gives free pages left behind by deleted rows back to the filesystem, in short chunks.
   *
   * Requires auto_vacuum = INCREMENTAL (set automatically by initServerfullDb). Each chunk takes the
   * connection lock on its own and yields to the event loop afterwards, so DNS queries and log writes
   * are delayed by one chunk (a few milliseconds) at most, never by the whole job.
   * Unlike vacuum(), it does not rewrite the database.
   */
  async reclaimSpace(options: ReclaimSpaceOptions = {}): Promise<ReclaimSpaceResult> {
    const chunkPages = Math.max(1, Math.floor(options.chunkPages ?? 256));
    const minFreePages = Math.max(1, Math.floor(options.minFreePages ?? 2048));
    const stopBelowPages = Math.max(0, Math.floor(options.stopBelowPages ?? 256));
    const maxMs = options.maxMs ?? 30_000;

    if (this.reclaiming) {
      return { reclaimedPages: 0, remainingFreePages: this.pragmaInt('freelist_count'), skipped: 'busy' };
    }
    if (this.pragmaInt('auto_vacuum') !== 2) {
      return { reclaimedPages: 0, remainingFreePages: this.pragmaInt('freelist_count'), skipped: 'not-incremental' };
    }
    const initialFree = this.pragmaInt('freelist_count');
    if (initialFree < minFreePages) {
      return { reclaimedPages: 0, remainingFreePages: initialFree, skipped: 'below-threshold' };
    }

    this.reclaiming = true;
    const startedAt = Date.now();
    let remaining = initialFree;
    try {
      while (remaining > stopBelowPages && Date.now() - startedAt < maxMs) {
        remaining = await this.runExclusive(() => {
          this.rawDb.exec(`PRAGMA incremental_vacuum(${chunkPages});`);
          return this.pragmaInt('freelist_count');
        });
        await yieldToEventLoop();
      }
      // With the checkpoint worker running, it picks up the WAL these chunks produced; a checkpoint here
      // would run (and fsync) on the event loop. Without it: PASSIVE never waits for other connections,
      // and journal_size_limit then trims the -wal file.
      if (!this.checkpointWorker) {
        await this.runExclusive(() => {
          this.rawDb.exec('PRAGMA wal_checkpoint(PASSIVE);');
        });
      }
    } catch (err: unknown) {
      console.warn('[SQLite D1] reclaimSpace warning:', err);
      remaining = this.pragmaInt('freelist_count');
    } finally {
      this.reclaiming = false;
    }
    return { reclaimedPages: Math.max(0, initialFree - remaining), remainingFreePages: remaining };
  }

  /**
   * Performs an immediate SQLite VACUUM and truncates the WAL write-ahead log to reclaim disk space.
   *
   * Blocks the event loop for the whole VACUUM (seconds on large databases). Prefer reclaimSpace()
   * for runtime use; this is kept for offline tooling.
   */
  vacuum(): void {
    try {
      this.rawDb.exec('VACUUM;');
      this.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (err: unknown) {
      console.warn('[SQLite D1] VACUUM / checkpoint warning:', err);
    }
  }

  prepare(query: string): D1PreparedStatement {
    return new NodeD1PreparedStatement(this.rawDb, query) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    if (!statements || statements.length === 0) {
      return [];
    }

    // Queue / serialize batch transactions so concurrent async operations
    // never execute overlapping BEGIN IMMEDIATE statements on the same SQLite connection.
    return this.runExclusive(async () => {
      this.rawDb.exec('BEGIN IMMEDIATE');
      try {
        const results: D1Result<T>[] = [];
        for (const stmt of statements) {
          const res = await stmt.run<T>();
          results.push(res);
        }
        this.rawDb.exec('COMMIT');
        return results;
      } catch (err) {
        try {
          this.rawDb.exec('ROLLBACK');
        } catch {}
        throw err;
      }
    });
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.rawDb.exec(query);
    return { count: 0, duration: 0 };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('dump() is not supported in NodeD1Database');
  }

  close(): void {
    try {
      this.rawDb.close();
    } catch {}
  }

  withSession(_constraintOrBookmark?: string): D1DatabaseSession {
    const session = Object.assign(this, {
      getBookmark: () => null
    });
    return session as unknown as D1DatabaseSession;
  }
}

/**
 * Runs all pending migrations from migrations/ directory.
 */
export function runMigrations(db: DatabaseSync, migrationsDir: string): void {
  // Ensure migrations tracking tables exist (supports both d1_migrations and _cf_d1_migrations)
  db.exec(`
    CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _cf_d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO d1_migrations (name, applied_at)
      SELECT name, applied_at FROM _cf_d1_migrations;
    INSERT OR IGNORE INTO _cf_d1_migrations (name, applied_at)
      SELECT name, applied_at FROM d1_migrations;
  `);

  if (!fs.existsSync(migrationsDir)) {
    console.warn(`[Migrations] Directory not found: ${migrationsDir}`);
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();

  const stmtGet = db.prepare('SELECT name FROM d1_migrations WHERE name = ?');
  const stmtInsertD1 = db.prepare('INSERT OR REPLACE INTO d1_migrations (name, applied_at) VALUES (?, ?)');
  const stmtInsertCf = db.prepare('INSERT OR REPLACE INTO _cf_d1_migrations (name, applied_at) VALUES (?, ?)');

  let appliedCount = 0;
  for (const file of files) {
    const existing = stmtGet.get(file);
    if (existing) continue;

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    console.log(`[Migrations] Applying ${file}...`);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      const appliedAt = Math.floor(Date.now() / 1000);
      stmtInsertD1.run(file, appliedAt);
      stmtInsertCf.run(file, appliedAt);
      db.exec('COMMIT');
      appliedCount++;
    } catch (err: any) {
      db.exec('ROLLBACK');
      console.error(`[Migrations] Failed to apply ${file}:`, err.message || err);
      throw err;
    }
  }

  if (appliedCount > 0) {
    console.log(`[Migrations] Successfully applied ${appliedCount} migration(s).`);
  } else {
    console.log('[Migrations] Database schema is up-to-date.');
  }
}

/**
 * Initializes SQLite database for Serverfull mode with WAL mode and runs pending migrations.
 */
export function initServerfullDb(
  dbPath: string,
  rootDir: string = getPackageRoot(),
  options: { autoVacuum?: AutoVacuumMode } = {}
): NodeD1Database {
  const autoVacuum = options.autoVacuum ?? resolveAutoVacuumMode(process.env.AUTO_VACUUM);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Seamlessly migrate legacy database from ./data/dns_worker.sqlite if target database does not exist yet
  if (!fs.existsSync(dbPath)) {
    const legacyPath = path.join(process.cwd(), 'data', 'dns_worker.sqlite');
    if (fs.existsSync(legacyPath) && path.resolve(legacyPath) !== path.resolve(dbPath)) {
      try {
        fs.copyFileSync(legacyPath, dbPath);
        console.log(`[SQLite D1] Seamlessly migrated existing database from ${legacyPath} to ${dbPath}`);
      } catch {
        /* If copy fails, fresh database will be initialized */
      }
    }
  }

  // A database that does not exist yet (or is empty) can pick its auto_vacuum mode for free.
  const isFreshDb = !fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0;

  console.log(`[SQLite D1] Connecting to database at: ${dbPath}`);
  const rawDb = new DatabaseSync(dbPath);

  // auto_vacuum MUST be set before journal_mode = WAL on a new file; afterwards it is silently ignored.
  if (autoVacuum === 'INCREMENTAL' && isFreshDb) {
    rawDb.exec('PRAGMA auto_vacuum = INCREMENTAL;');
  }

  // Configure SQLite for high concurrency, zero-copy memory reads & integrity
  const sqliteCacheKb = Number(process.env.SQLITE_CACHE_SIZE_KB) || 32000; // 32 MB default page cache
  const sqliteMmapBytes = Number(process.env.SQLITE_MMAP_SIZE_BYTES) || 67108864; // 64 MB default mmap
  rawDb.exec('PRAGMA journal_mode = WAL;');
  rawDb.exec(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`); // trim the -wal file after checkpoints
  rawDb.exec('PRAGMA synchronous = NORMAL;');
  rawDb.exec('PRAGMA busy_timeout = 5000;');
  rawDb.exec('PRAGMA foreign_keys = ON;');
  rawDb.exec('PRAGMA temp_store = MEMORY;');
  rawDb.exec(`PRAGMA cache_size = -${sqliteCacheKb};`);
  rawDb.exec(`PRAGMA mmap_size = ${sqliteMmapBytes};`);

  // Run migrations
  const migrationsDir = path.join(rootDir, 'migrations');
  runMigrations(rawDb, migrationsDir);

  // Existing databases need a one-time VACUUM before INCREMENTAL auto_vacuum takes effect.
  if (autoVacuum === 'INCREMENTAL' && !isFreshDb) {
    migrateToIncrementalAutoVacuum(rawDb, dbPath);
  }

  return new NodeD1Database(rawDb, dbPath);
}
