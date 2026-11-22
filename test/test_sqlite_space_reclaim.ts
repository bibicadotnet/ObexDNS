/**
 * @file test_sqlite_space_reclaim.ts
 * @description Integration tests (real SQLite) for Serverfull disk-space handling:
 *   1. New databases are created with auto_vacuum=INCREMENTAL (PRAGMA order matters) and a WAL size limit.
 *   2. Existing databases are converted once at startup, keeping all data; AUTO_VACUUM=NONE opts out.
 *   3. The conversion is skipped (database untouched) when free disk space is insufficient.
 *   4. reclaimSpace() shrinks the file after mass deletes, in short chunks that yield to the event loop.
 *   5. reclaimSpace() cooperates with batch() (no "table is locked") and never runs twice at once.
 *   6. scheduleSpaceReclaim() is a no-op for databases without reclaimSpace (D1 / Turso).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { initServerfullDb, migrateToIncrementalAutoVacuum, resolveAutoVacuumMode, WAL_SIZE_LIMIT_BYTES } from '../src/serverfull/db';
import { scheduleSpaceReclaim } from '../src/utils/dbMaintenance';

const ROOT = path.resolve(__dirname, '..');
const NOW = Math.floor(Date.now() / 1000);

const pragma = (db: any, name: string): number =>
  Number(Object.values(db.rawDb.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0]);

function fillLogs(db: any, rows: number, idStart = 1): void {
  const ins = db.rawDb.prepare(
    "INSERT INTO logs (profile_id, timestamp, id, client_ip, domain, record_type, action, answer) VALUES ('p', ?, ?, '203.0.113.7', ?, 'A', 'PASS', '93.184.216.34')"
  );
  db.rawDb.exec('BEGIN');
  for (let i = 0; i < rows; i++) ins.run(NOW - rows + i, idStart + i, `host${i % 500}.example-domain.com`);
  db.rawDb.exec('COMMIT');
}

const logCount = (db: any): number => (db.rawDb.prepare('SELECT count(*) c FROM logs').get() as { c: number }).c;
const fileMB = (p: string): number => fs.statSync(p).size / 1048576;

async function main(): Promise<void> {
  console.log('>>> [TEST] SQLite auto_vacuum conversion and reclaimSpace...');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnsw-reclaim-'));
  const quiet = { log: console.log, warn: console.warn };
  const mute = () => {
    console.log = () => {};
    console.warn = () => {};
  };
  const unmute = () => {
    console.log = quiet.log;
    console.warn = quiet.warn;
  };

  try {
    // ── 0. env parsing ───────────────────────────────────────────────────────
    assert.strictEqual(resolveAutoVacuumMode(undefined), 'INCREMENTAL');
    assert.strictEqual(resolveAutoVacuumMode(''), 'INCREMENTAL');
    assert.strictEqual(resolveAutoVacuumMode('incremental'), 'INCREMENTAL');
    for (const off of ['none', 'NONE', 'off', 'false', '0', 'no']) {
      assert.strictEqual(resolveAutoVacuumMode(off), 'NONE', `AUTO_VACUUM=${off} disables auto_vacuum`);
    }

    // ── 1. new database ──────────────────────────────────────────────────────
    console.log('1. New database gets auto_vacuum=INCREMENTAL and a WAL size limit...');
    {
      mute();
      const db: any = initServerfullDb(path.join(dir, 'fresh.sqlite'), ROOT);
      unmute();
      assert.strictEqual(pragma(db, 'auto_vacuum'), 2, 'auto_vacuum is INCREMENTAL (set before journal_mode=WAL)');
      assert.strictEqual(pragma(db, 'journal_size_limit'), WAL_SIZE_LIMIT_BYTES);
      assert.strictEqual(String(Object.values(db.rawDb.prepare('PRAGMA journal_mode').get())[0]), 'wal');
      db.close();
      console.log('  Passed.');
    }

    // ── 2. legacy database conversion ────────────────────────────────────────
    console.log('2. Existing database is converted once at startup and keeps its data...');
    const legacyPath = path.join(dir, 'legacy.sqlite');
    {
      mute();
      const old: any = initServerfullDb(legacyPath, ROOT, { autoVacuum: 'NONE' });
      unmute();
      assert.strictEqual(pragma(old, 'auto_vacuum'), 0, 'AUTO_VACUUM=NONE keeps the legacy mode');
      fillLogs(old, 20000);
      old.rawDb.prepare("INSERT INTO system_settings (key, value, updated_at) VALUES ('marker', 'kept', ?)").run(NOW);
      old.close();

      mute();
      const migrated: any = initServerfullDb(legacyPath, ROOT);
      unmute();
      assert.strictEqual(pragma(migrated, 'auto_vacuum'), 2, 'converted to INCREMENTAL');
      assert.strictEqual(logCount(migrated), 20000, 'no rows lost');
      assert.strictEqual((migrated.rawDb.prepare("SELECT value FROM system_settings WHERE key='marker'").get() as any).value, 'kept');
      assert.strictEqual(String((migrated.rawDb.prepare('PRAGMA integrity_check').get() as any).integrity_check), 'ok');
      assert.strictEqual(pragma(migrated, 'temp_store'), 2, 'temp_store restored to MEMORY');
      migrated.close();

      // Running again is a no-op (already converted)
      mute();
      const again: any = initServerfullDb(legacyPath, ROOT);
      unmute();
      assert.strictEqual(pragma(again, 'auto_vacuum'), 2);
      assert.strictEqual(logCount(again), 20000);
      again.close();
      console.log('  Passed.');
    }

    // ── 3. insufficient disk space ───────────────────────────────────────────
    console.log('3. Conversion is skipped, database untouched, when free disk space is too low...');
    {
      const p = path.join(dir, 'lowdisk.sqlite');
      mute();
      const old: any = initServerfullDb(p, ROOT, { autoVacuum: 'NONE' });
      fillLogs(old, 5000);
      old.close();
      const realStatfs = (fs as any).statfsSync;
      let warned = '';
      (fs as any).statfsSync = () => ({ bavail: 1, bsize: 4096 }); // 4 KB free
      console.warn = (...a: unknown[]) => {
        warned += a.join(' ');
      };
      let db: any;
      try {
        db = initServerfullDb(p, ROOT);
      } finally {
        (fs as any).statfsSync = realStatfs;
        unmute();
      }
      assert.strictEqual(pragma(db, 'auto_vacuum'), 0, 'not converted');
      assert.strictEqual(logCount(db), 5000, 'data intact');
      assert(/free on the data volume/i.test(warned), 'a warning explains why it was skipped');
      db.close();

      // Unknown free space is also treated as "do not risk it"
      const p2 = path.join(dir, 'unknown.sqlite');
      mute();
      const old2: any = initServerfullDb(p2, ROOT, { autoVacuum: 'NONE' });
      old2.close();
      (fs as any).statfsSync = undefined;
      let db2: any;
      try {
        db2 = initServerfullDb(p2, ROOT);
      } finally {
        (fs as any).statfsSync = realStatfs;
        unmute();
      }
      assert.strictEqual(pragma(db2, 'auto_vacuum'), 0, 'skipped when free space cannot be determined');
      db2.close();
      console.log('  Passed.');
    }

    // ── 3b. disk requirement and temp file placement ─────────────────────────
    console.log('3b. Disk check uses live data size (needs ~2.2x free) and keeps the VACUUM temp file on the data volume...');
    {
      const p = path.join(dir, 'threshold.sqlite');
      mute();
      const old: any = initServerfullDb(p, ROOT, { autoVacuum: 'NONE' });
      fillLogs(old, 30000);
      old.close();
      unmute();

      const live = (() => {
        const d = new DatabaseSync(p);
        const n = (q: string) => Number(Object.values(d.prepare(q).get() as Record<string, unknown>)[0]);
        const bytes = (n('PRAGMA page_count') - n('PRAGMA freelist_count')) * n('PRAGMA page_size');
        d.close();
        return bytes;
      })();
      const realStatfs = (fs as any).statfsSync;
      const withFree = (bytes: number, fn: () => unknown) => {
        (fs as any).statfsSync = () => ({ bavail: Math.floor(bytes / 4096), bsize: 4096 });
        try {
          return fn();
        } finally {
          (fs as any).statfsSync = realStatfs;
        }
      };
      const open = (): DatabaseSync => {
        const d = new DatabaseSync(p);
        d.exec('PRAGMA journal_mode = WAL;');
        return d;
      };
      const recorder = (real: DatabaseSync, log: string[]): any => ({
        exec: (sql: string) => {
          log.push(sql.trim());
          return real.exec(sql);
        },
        prepare: (sql: string) => real.prepare(sql)
      });

      // Exactly 2x free is NOT enough (peak need is 2x, plus safety margin)
      let d = open();
      mute();
      const tooTight = withFree(live * 2, () => migrateToIncrementalAutoVacuum(d, p));
      unmute();
      assert.strictEqual(tooTight, 'skipped', '2.0x free is below the required 2.2x + margin');
      assert.strictEqual(pragma({ rawDb: d }, 'auto_vacuum'), 0);
      d.close();

      // Plenty free: converts, and the temp copy is redirected to the data directory then reset
      d = open();
      const log: string[] = [];
      mute();
      const outcome = withFree(live * 3 + 200 * 1048576, () => migrateToIncrementalAutoVacuum(recorder(d, log), p));
      unmute();
      assert.strictEqual(outcome, 'migrated');
      const dirIdx = log.findIndex((q) => q.startsWith('PRAGMA temp_store_directory') && q.includes(path.dirname(p)));
      const vacuumIdx = log.indexOf('VACUUM;');
      const resetIdx = log.findIndex((q, i) => i > vacuumIdx && q === "PRAGMA temp_store_directory = '';");
      assert(dirIdx >= 0 && dirIdx < vacuumIdx, 'temp_store_directory points at the data directory before VACUUM');
      assert(resetIdx > vacuumIdx, 'temp_store_directory is reset after VACUUM');
      assert.strictEqual(pragma({ rawDb: d }, 'auto_vacuum'), 2);
      const tmpRow = d.prepare('PRAGMA temp_store_directory').get() as Record<string, unknown> | undefined;
      assert.strictEqual(tmpRow === undefined ? '' : String(Object.values(tmpRow)[0] ?? ''), '', 'no lingering temp directory override');
      d.close();
      console.log('  Passed.');
    }

    // ── 4. reclaimSpace shrinks the file ─────────────────────────────────────
    console.log('4. reclaimSpace() shrinks the file after mass deletes and yields between chunks...');
    {
      const p = path.join(dir, 'shrink.sqlite');
      mute();
      const db: any = initServerfullDb(p, ROOT);
      unmute();
      fillLogs(db, 120000);
      db.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const fullMB = fileMB(p);
      db.rawDb.exec('DELETE FROM logs WHERE id <= 114000'); // keep 5%
      db.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      assert(fileMB(p) > fullMB * 0.95, 'deleting rows alone does not shrink the file (precondition)');
      assert(pragma(db, 'freelist_count') > 2048);

      // Count how many times the event loop got to run other work while reclaiming
      let ticks = 0;
      const timer = setInterval(() => ticks++, 1);
      const result = await db.reclaimSpace({ chunkPages: 200 });
      clearInterval(timer);
      assert(result.reclaimedPages > 2048, 'reported reclaimed pages');
      assert(result.remainingFreePages <= 256, `free pages left at or below the stop threshold (got ${result.remainingFreePages})`);
      assert(ticks >= 3, `event loop ran between chunks (ticks=${ticks})`);
      db.rawDb.prepare("INSERT INTO system_settings (key, value, updated_at) VALUES ('x', 'y', ?)").run(NOW); // let journal_size_limit apply
      db.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      assert(fileMB(p) < fullMB * 0.25, `file shrank (${fullMB.toFixed(1)}MB -> ${fileMB(p).toFixed(1)}MB)`);
      assert.strictEqual(logCount(db), 6000, 'live rows untouched');
      assert.strictEqual(String((db.rawDb.prepare('PRAGMA integrity_check').get() as any).integrity_check), 'ok');

      // Nothing to do below the threshold
      const small = await db.reclaimSpace();
      assert.strictEqual(small.skipped, 'below-threshold');
      db.close();

      // Legacy mode (AUTO_VACUUM=NONE) cannot reclaim incrementally
      mute();
      const legacy: any = initServerfullDb(path.join(dir, 'noinc.sqlite'), ROOT, { autoVacuum: 'NONE' });
      unmute();
      assert.strictEqual((await legacy.reclaimSpace({ minFreePages: 1 })).skipped, 'not-incremental');
      legacy.close();
      console.log('  Passed.');
    }

    // ── 5. locking ───────────────────────────────────────────────────────────
    console.log('5. reclaimSpace() cooperates with batch() and never overlaps itself...');
    {
      const p = path.join(dir, 'lock.sqlite');
      mute();
      const db: any = initServerfullDb(p, ROOT);
      unmute();
      fillLogs(db, 60000);
      db.rawDb.exec('DELETE FROM logs WHERE id <= 58000');

      const writes: Promise<unknown>[] = [];
      const reclaim = db.reclaimSpace({ chunkPages: 50, minFreePages: 1, stopBelowPages: 0 });
      for (let i = 0; i < 20; i++) {
        writes.push(
          db.batch([
            db.prepare("INSERT INTO logs (profile_id, timestamp, id, client_ip, domain, record_type, action) VALUES ('w', ?, ?, '1.1.1.1', 'w.example.com', 'A', 'PASS')").bind(NOW + i, 900000 + i),
            db.prepare("INSERT INTO logs (profile_id, timestamp, id, client_ip, domain, record_type, action) VALUES ('w', ?, ?, '1.1.1.1', 'w.example.com', 'A', 'PASS')").bind(NOW + i, 910000 + i)
          ])
        );
        await new Promise((r) => setImmediate(r));
      }
      const overlapping = await db.reclaimSpace(); // second call while the first is still running
      assert.strictEqual(overlapping.skipped, 'busy', 'a second concurrent reclaim is refused');
      const [res] = await Promise.all([reclaim, Promise.all(writes)]);
      assert.strictEqual(res.remainingFreePages, 0, 'everything reclaimed');
      assert.strictEqual((db.rawDb.prepare("SELECT count(*) c FROM logs WHERE profile_id='w'").get() as any).c, 40, 'all concurrent writes landed');
      assert.strictEqual(String((db.rawDb.prepare('PRAGMA integrity_check').get() as any).integrity_check), 'ok');
      db.close();
      console.log('  Passed.');
    }

    // ── 5b. open transaction ─────────────────────────────────────────────────
    console.log('5b. reclaimSpace() waits for a batch() whose transaction is still open...');
    {
      const p = path.join(dir, 'opentx.sqlite');
      mute();
      const db: any = initServerfullDb(p, ROOT);
      unmute();
      fillLogs(db, 40000);
      db.rawDb.exec('DELETE FROM logs WHERE id <= 39000');

      // A statement that stays pending inside the transaction (as any async work in a batch would).
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slowStatement: any = {
        run: async () => {
          await gate;
          db.rawDb
            .prepare("INSERT INTO logs (profile_id, timestamp, id, client_ip, domain, record_type, action) VALUES ('tx', ?, 777777, '1.1.1.1', 'tx.example.com', 'A', 'PASS')")
            .run(NOW);
          return { success: true, meta: { changes: 1 } };
        }
      };
      const batchDone = db.batch([slowStatement]); // BEGIN IMMEDIATE is now open until `gate` resolves
      await new Promise((resolve) => setImmediate(resolve));

      const warnings: string[] = [];
      console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(' '));
      const reclaimDone = db.reclaimSpace({ chunkPages: 100, minFreePages: 1, stopBelowPages: 0 });
      await new Promise((resolve) => setTimeout(resolve, 30)); // reclaim must be queued behind the batch
      assert.strictEqual(pragma(db, 'freelist_count') > 0, true, 'reclaim has not touched the database while the transaction is open');
      release();
      const [, result] = await Promise.all([batchDone, reclaimDone]);
      unmute();
      assert.deepStrictEqual(warnings, [], 'no "table is locked" style failure');
      assert.strictEqual(result.remainingFreePages, 0, 'reclaim completed after the batch committed');
      assert.strictEqual((db.rawDb.prepare("SELECT count(*) c FROM logs WHERE profile_id='tx'").get() as any).c, 1, 'batch committed');
      db.close();
      console.log('  Passed.');
    }

    // ── 6. scheduleSpaceReclaim ──────────────────────────────────────────────
    console.log('6. scheduleSpaceReclaim() is a no-op without reclaimSpace and forwards options otherwise...');
    {
      const waits: Promise<unknown>[] = [];
      const ctx: any = { waitUntil: (p: Promise<unknown>) => waits.push(p) };
      scheduleSpaceReclaim({ prepare() {} }, ctx); // D1-like
      scheduleSpaceReclaim(undefined, ctx);
      assert.strictEqual(waits.length, 0, 'nothing scheduled for D1/Turso');

      let received: any = null;
      scheduleSpaceReclaim({ reclaimSpace: async (o: unknown) => ((received = o), {}) }, ctx);
      await Promise.all(waits);
      assert.strictEqual(waits.length, 1);
      assert.strictEqual(received.minFreePages, 1, 'reclaims even a small amount after a user-requested delete');
      assert.strictEqual(received.stopBelowPages, 0);

      // A failing reclaim must not reject the request
      const waits2: Promise<unknown>[] = [];
      mute();
      scheduleSpaceReclaim({ reclaimSpace: async () => { throw new Error('boom'); } }, { waitUntil: (p: Promise<unknown>) => waits2.push(p) } as any);
      await assert.doesNotReject(Promise.all(waits2));
      unmute();
      console.log('  Passed.');
    }

    console.log('\n>>> [TEST] All SQLite space reclaim tests passed!\n');
  } finally {
    unmute();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('>>> [TEST ERROR]', err);
  process.exit(1);
});
