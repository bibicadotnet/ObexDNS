/**
 * @file test_log_row_cap_and_redistribution.ts
 * @description Integration tests (real SQLite, real migrations) for LogRetentionModel.cleanupGlobal:
 *   1. MAX_LOGS_PER_PROFILE row cap trims the OLDEST rows and leaves other profiles alone.
 *   2. Unused per-profile delete quota is handed to profiles that still have expired rows.
 *   3. Row-cap deletions do not consume the daily deletion budget.
 *   4. cron.ts enables the row cap only for databases that can reclaim space (local SQLite), never D1.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { initServerfullDb } from '../src/serverfull/db';
import { LogRetentionModel } from '../src/models/log/retention';

const ROOT = path.resolve(__dirname, '..');
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function newDb(dir: string, name: string) {
  return initServerfullDb(path.join(dir, name), ROOT);
}

function addProfile(db: any, id: string, retentionDays = 7): void {
  db.rawDb
    .prepare('INSERT INTO profiles (id, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, id, JSON.stringify({ log_retention_days: retentionDays }), NOW, NOW);
}

/** Inserts `count` logs for a profile, one second apart, ending at `lastTs`. */
function addLogs(db: any, profileId: string, count: number, lastTs: number, idStart = 1): void {
  const ins = db.rawDb.prepare(
    "INSERT INTO logs (profile_id, timestamp, id, client_ip, domain, record_type, action) VALUES (?, ?, ?, '1.2.3.4', 'a.example.com', 'A', 'PASS')"
  );
  db.rawDb.exec('BEGIN');
  for (let i = 0; i < count; i++) ins.run(profileId, lastTs - (count - 1 - i), idStart + i);
  db.rawDb.exec('COMMIT');
}

function countLogs(db: any, profileId: string): number {
  return (db.rawDb.prepare('SELECT count(*) AS c FROM logs WHERE profile_id = ?').get(profileId) as { c: number }).c;
}

function oldestTs(db: any, profileId: string): number {
  return (db.rawDb.prepare('SELECT min(timestamp) AS t FROM logs WHERE profile_id = ?').get(profileId) as { t: number }).t;
}

async function main(): Promise<void> {
  console.log('>>> [TEST] Log row cap, quota redistribution and cron gating...');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnsw-rowcap-'));
  const quiet = console.log;

  try {
    // ── 1. Row cap ───────────────────────────────────────────────────────────
    console.log('1. Row cap trims the oldest rows of an over-cap profile only...');
    {
      const db: any = newDb(dir, 'cap.sqlite');
      addProfile(db, 'big');
      addProfile(db, 'small');
      const recent = NOW - 60;
      addLogs(db, 'big', 250, recent);
      addLogs(db, 'small', 40, recent, 100000);
      const newestBefore = (db.rawDb.prepare("SELECT max(timestamp) t FROM logs WHERE profile_id='big'").get() as any).t;

      const model = new LogRetentionModel(db);
      console.log = () => {};
      // chunkSize 7 forces many delete chunks
      const deleted = await model.cleanupGlobal(30, 1000, 0, {}, { maxLogsPerProfile: 100, chunkSize: 7 });
      console.log = quiet;

      assert.strictEqual(deleted, 150, 'returns number of rows deleted (250 -> 100)');
      assert.strictEqual(countLogs(db, 'big'), 100, 'over-cap profile trimmed to exactly the cap');
      assert.strictEqual(countLogs(db, 'small'), 40, 'profile under the cap is untouched');
      assert.strictEqual(oldestTs(db, 'big'), recent - 99, 'the 100 NEWEST rows are the ones kept');
      assert.strictEqual((db.rawDb.prepare("SELECT max(timestamp) t FROM logs WHERE profile_id='big'").get() as any).t, newestBefore, 'newest row kept');

      // Idempotent: a second run has nothing to do
      console.log = () => {};
      const again = await model.cleanupGlobal(30, 1000, 0, {}, { maxLogsPerProfile: 100 });
      console.log = quiet;
      assert.strictEqual(again, 0, 'second run deletes nothing');
      assert.strictEqual(countLogs(db, 'big'), 100);

      // Disabled when cap is 0 / omitted
      addLogs(db, 'big', 50, recent + 1000, 500000);
      console.log = () => {};
      assert.strictEqual(await model.cleanupGlobal(30, 1000, 0, {}, { maxLogsPerProfile: 0 }), 0);
      assert.strictEqual(await model.cleanupGlobal(30, 1000, 0), 0);
      console.log = quiet;
      assert.strictEqual(countLogs(db, 'big'), 150, 'no cap means no trimming');
      db.close();
      console.log('  Passed.');
    }

    // ── 1b. Ties on timestamp ───────────────────────────────────────────────
    console.log('1b. Row cap is exact when many rows share one timestamp...');
    {
      const db: any = newDb(dir, 'ties.sqlite');
      addProfile(db, 'p');
      const ins = db.rawDb.prepare(
        "INSERT INTO logs (profile_id, timestamp, id, client_ip, domain, record_type, action) VALUES ('p', ?, ?, '1.2.3.4', 'a.example.com', 'A', 'PASS')"
      );
      db.rawDb.exec('BEGIN');
      for (let i = 0; i < 60; i++) ins.run(NOW - 120, i + 1); // 60 rows, identical timestamp
      db.rawDb.exec('COMMIT');
      console.log = () => {};
      const deleted = await new LogRetentionModel(db).cleanupGlobal(30, 1000, 0, {}, { maxLogsPerProfile: 25, chunkSize: 10 });
      console.log = quiet;
      assert.strictEqual(deleted, 35);
      assert.strictEqual(countLogs(db, 'p'), 25, 'exactly the cap remains even with identical timestamps');
      const ids = (db.rawDb.prepare('SELECT id FROM logs ORDER BY id').all() as { id: number }[]).map((r) => r.id);
      assert.deepStrictEqual(ids, Array.from({ length: 25 }, (_, i) => 36 + i), 'highest ids (newest) are kept');
      db.close();
      console.log('  Passed.');
    }

    // ── 2. Redistribution ────────────────────────────────────────────────────
    console.log('2. Unused delete quota is redistributed to profiles with a backlog...');
    {
      const db: any = newDb(dir, 'redistribute.sqlite');
      for (const id of ['busy', 'idle1', 'idle2']) addProfile(db, id, 1);
      addLogs(db, 'busy', 500, NOW - 5 * DAY); // all expired (retention 1 day)
      addLogs(db, 'idle1', 20, NOW - 60, 100000); // nothing expired
      addLogs(db, 'idle2', 20, NOW - 60, 200000);

      console.log = () => {};
      // batchLimit 90 / 3 profiles = 30 each. Old behaviour deletes 30; now the idle profiles' quota is reused.
      const deleted = await new LogRetentionModel(db).cleanupGlobal(30, 90, 0);
      console.log = quiet;
      assert.strictEqual(deleted, 90, 'whole batch budget is used by the profile that has a backlog');
      assert.strictEqual(countLogs(db, 'busy'), 410, 'busy profile lost 90 rows, not 30');
      assert.strictEqual(countLogs(db, 'idle1'), 20);
      assert.strictEqual(countLogs(db, 'idle2'), 20);

      // Budget is never exceeded when several profiles have a backlog
      const db2: any = newDb(dir, 'redistribute2.sqlite');
      for (const id of ['a', 'b', 'c']) addProfile(db2, id, 1);
      addLogs(db2, 'a', 400, NOW - 5 * DAY);
      addLogs(db2, 'b', 400, NOW - 5 * DAY, 100000);
      addLogs(db2, 'c', 10, NOW - 5 * DAY, 200000); // fewer expired rows than its share
      console.log = () => {};
      const deleted2 = await new LogRetentionModel(db2).cleanupGlobal(30, 300, 0);
      console.log = quiet;
      assert.strictEqual(deleted2, 300, 'exactly batchLimit rows deleted in total');
      assert.strictEqual(countLogs(db2, 'c'), 0, 'small profile fully cleaned');
      assert.strictEqual(countLogs(db2, 'a') + countLogs(db2, 'b'), 800 - 290, 'the remaining 290 came from the two busy profiles');
      db.close();
      db2.close();
      console.log('  Passed.');
    }

    // ── 3. Daily budget accounting ───────────────────────────────────────────
    console.log('3. Row-cap deletions do not consume the daily deletion budget...');
    {
      const db: any = newDb(dir, 'budget.sqlite');
      addProfile(db, 'p', 1);
      addLogs(db, 'p', 100, NOW - 5 * DAY); // 100 expired rows
      addLogs(db, 'p', 300, NOW - 60, 100000); // 300 fresh rows; after the 100 expired are gone, 100 are over the cap of 200
      console.log = () => {};
      const deleted = await new LogRetentionModel(db).cleanupGlobal(30, 1000, 20000, {}, { maxLogsPerProfile: 200 });
      console.log = quiet;
      const counted = (db.rawDb.prepare("SELECT value FROM system_settings WHERE key = 'log_cleanup_daily_count'").get() as { value: string }).value;
      assert.strictEqual(counted, '100', 'daily counter only includes retention-based deletions');
      assert.strictEqual(deleted, 100 + 100, 'return value includes retention (100) and row-cap (100) deletions');
      assert.strictEqual(countLogs(db, 'p'), 200);
      db.close();
      console.log('  Passed.');
    }

    // ── 4. cron gating ───────────────────────────────────────────────────────
    console.log('4. cron.ts enables the row cap only on databases that can reclaim space...');
    {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error('offline in test');
      }) as typeof fetch;
      const origLog = console.log;
      const origWarn = console.warn;
      const origErr = console.error;

      /** Loads a pristine copy of cron.ts (it throttles cleanup through module-level state). */
      const freshCron = (): typeof import('../src/cron') => {
        for (const key of Object.keys(require.cache)) {
          if (key.includes(`${path.sep}src${path.sep}`)) delete require.cache[key];
        }
        return require('../src/cron');
      };

      const runCron = async (withReclaim: boolean) => {
        const cron = freshCron();
        const queries: { sql: string; args: unknown[] }[] = [];
        let reclaimCalls = 0;
        const mk = (sql: string, args: unknown[] = []): any => ({
          sql,
          bind: (...a: unknown[]) => mk(sql, a),
          async all() {
            queries.push({ sql, args });
            return { results: sql.includes('SELECT id, settings FROM profiles') ? [{ id: 'p1', settings: '{}' }] : [] };
          },
          async first() {
            queries.push({ sql, args });
            return null;
          },
          async run() {
            queries.push({ sql, args });
            return { success: true, meta: { changes: 0 } };
          }
        });
        const db: any = {
          prepare: (sql: string) => mk(sql),
          async batch(stmts: any[]) {
            return stmts.map(() => ({ success: true, meta: { changes: 0 } }));
          }
        };
        if (withReclaim) {
          db.reclaimSpace = async () => {
            reclaimCalls++;
            return {};
          };
        }
        const pending: Promise<unknown>[] = [];
        const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
        const env: any = {
          DB: db,
          MAX_LOGS_PER_PROFILE: '5',
          CF_IP_SYNC_INTERVAL_SEC: '999999',
          SYNC_SYSTEM_INTERVAL_SEC: '999999',
          SYNC_IDLE_INTERVAL_SEC: '999999'
        };
        console.log = console.warn = console.error = () => {};
        try {
          await cron.handleScheduled({} as any, env, ctx);
          await Promise.all(pending);
        } finally {
          console.log = origLog;
          console.warn = origWarn;
          console.error = origErr;
        }
        const lookup = queries.find((q) => q.sql.includes('ORDER BY timestamp DESC, id DESC LIMIT 1 OFFSET ?'));
        return { queries, reclaimCalls, lookup };
      };

      try {
        const d1Like = await runCron(false);
        assert(
          d1Like.queries.some((q) => q.sql.includes('SELECT id, settings FROM profiles')),
          'sanity: the cleanup phase ran'
        );
        assert.strictEqual(d1Like.lookup, undefined, 'D1-like DB (no reclaimSpace): no per-profile row-cap query');
        assert.strictEqual(d1Like.reclaimCalls, 0);

        const local = await runCron(true);
        assert(local.lookup, 'local SQLite-like DB: row-cap lookup is issued');
        assert.deepStrictEqual(local.lookup!.args, ['p1', 5], 'row cap taken from MAX_LOGS_PER_PROFILE');
        assert.strictEqual(local.reclaimCalls, 1, 'reclaimSpace is scheduled after cleanup');
      } finally {
        globalThis.fetch = realFetch;
        console.log = origLog;
        console.warn = origWarn;
        console.error = origErr;
      }
      console.log('  Passed.');
    }

    console.log('\n>>> [TEST] All log row cap, redistribution and cron gating tests passed!\n');
  } finally {
    console.log = quiet;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('>>> [TEST ERROR]', err);
  process.exit(1);
});
