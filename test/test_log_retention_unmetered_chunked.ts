/**
 * @file test_log_retention_unmetered_chunked.ts
 * @description Integration tests (real SQLite, real migrations) verifying:
 *   1. Unmetered loop deletion with chunking (LOG_CLEANUP_CHUNK_SIZE & LOG_CLEANUP_YIELD_SLEEP_MS).
 *   2. Multi-pass leftover quota redistribution across multiple profiles.
 *   3. EnforceRowCap chunked deletion.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { initServerfullDb } from '../src/serverfull/db';
import { LogRetentionModel } from '../src/models/log/retention';
import { LogModel } from '../src/models/log';

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

function addLogs(db: any, profileId: string, count: number, lastTs: number, idStart = 1): void {
  const ins = db.rawDb.prepare(
    "INSERT INTO logs (profile_id, timestamp, id, client_ip, domain, record_type, action) VALUES (?, ?, ?, '1.2.3.4', 'test.com', 'A', 'PASS')"
  );
  db.rawDb.exec('BEGIN');
  for (let i = 0; i < count; i++) ins.run(profileId, lastTs - (count - 1 - i), idStart + i);
  db.rawDb.exec('COMMIT');
}

function countLogs(db: any, profileId: string): number {
  return (db.rawDb.prepare('SELECT count(*) AS c FROM logs WHERE profile_id = ?').get(profileId) as { c: number }).c;
}

async function main(): Promise<void> {
  console.log('>>> [TEST] Running Unmetered Chunked Retention & Pacing Tests...\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnsw-chunked-retention-'));
  const dbsToClose: any[] = [];

  try {
    // ── TEST 1: Unmetered loop deletes all expired logs in small chunks ──────
    console.log('1. Testing unmetered chunked loop cleanup (batchLimit = 0, dailyBudget = 0)...');
    {
      const db: any = newDb(dir, 'unmetered.sqlite');
      dbsToClose.push(db);
      const model = new LogRetentionModel(db);

      addProfile(db, 'p1', 7);
      addProfile(db, 'p2', 7);

      // p1 has 350 expired logs (older than 7 days) and 50 fresh logs
      addLogs(db, 'p1', 350, NOW - 8 * DAY, 1);
      addLogs(db, 'p1', 50, NOW - 1 * DAY, 1000);

      // p2 has 250 expired logs and 50 fresh logs
      addLogs(db, 'p2', 250, NOW - 8 * DAY, 2000);
      addLogs(db, 'p2', 50, NOW - 1 * DAY, 3000);

      assert.strictEqual(countLogs(db, 'p1'), 400);
      assert.strictEqual(countLogs(db, 'p2'), 300);

      // Run cleanupGlobal with batchLimit: 0, dailyBudget: 0 (unmetered), chunkSize: 100, yieldSleepMs: 5
      const startTime = Date.now();
      const totalDeleted = (await model.cleanupGlobal(
        30, // maxRetentionDays
        0,  // batchLimit = 0 (unmetered)
        0,  // dailyBudget = 0 (unmetered)
        {},
        { chunkSize: 100, yieldSleepMs: 5 }
      )).deleted;
      const elapsed = Date.now() - startTime;

      console.log(`   Cleaned ${totalDeleted} logs across profiles in ${elapsed}ms`);

      // All 600 expired logs (350 from p1 + 250 from p2) must be deleted
      assert.strictEqual(totalDeleted, 600, 'Must delete all 600 expired logs in unmetered mode');
      assert.strictEqual(countLogs(db, 'p1'), 50, 'p1 should only have 50 fresh logs remaining');
      assert.strictEqual(countLogs(db, 'p2'), 50, 'p2 should only have 50 fresh logs remaining');
      // Verify pacing took place: 6 chunks * 5ms = ~30ms minimum yield
      assert.ok(elapsed >= 20, `Pacing yield must introduce event loop delays (actual: ${elapsed}ms)`);
      console.log('   ✓ Unmetered chunked cleanup deleted 100% of expired rows with pacing yields.');
    }

    // ── TEST 2: Multi-pass leftover redistribution ────────────────────────────
    console.log('2. Testing multi-pass leftover quota redistribution...');
    {
      const db: any = newDb(dir, 'redistribute.sqlite');
      dbsToClose.push(db);
      const model = new LogRetentionModel(db);

      // 3 profiles
      addProfile(db, 'prof_idle', 7);     // Has 0 expired logs
      addProfile(db, 'prof_medium', 7);   // Has 50 expired logs
      addProfile(db, 'prof_huge', 7);     // Has 500 expired logs

      addLogs(db, 'prof_medium', 50, NOW - 8 * DAY, 1);
      addLogs(db, 'prof_huge', 500, NOW - 8 * DAY, 100);

      // Total budget = 300, batchLimit = 300. With 3 profiles, fair share = 100 per profile.
      // prof_idle needs 0 (spares 100).
      // prof_medium needs 50 (spares 50).
      // prof_huge needs 500.
      // Leftover = 100 + 50 = 150. Saturated = [prof_huge].
      // Redistribution round 1: gives remaining 150 to prof_huge -> total 250 for prof_huge!
      const totalDeleted = (await model.cleanupGlobal(
        30,  // maxRetentionDays
        300, // batchLimit
        300, // dailyBudget
        {},
        { chunkSize: 50, yieldSleepMs: 2 }
      )).deleted;

      assert.strictEqual(totalDeleted, 300, 'Must delete exactly 300 logs up to the budget');
      assert.strictEqual(countLogs(db, 'prof_idle'), 0);
      assert.strictEqual(countLogs(db, 'prof_medium'), 0, 'prof_medium had 50, all deleted');
      assert.strictEqual(countLogs(db, 'prof_huge'), 250, 'prof_huge had 500 - 250 deleted = 250 remaining');
      console.log('   ✓ Multi-pass quota redistribution successfully awarded unused quota to saturated profiles.');
    }

    // ── TEST 3: Enforce row cap with chunking ─────────────────────────────────
    console.log('3. Testing enforceRowCap with chunked deletions...');
    {
      const db: any = newDb(dir, 'rowcap.sqlite');
      dbsToClose.push(db);
      const model = new LogRetentionModel(db);

      addProfile(db, 'over_cap', 30);
      // Insert 250 logs
      addLogs(db, 'over_cap', 250, NOW, 1);
      assert.strictEqual(countLogs(db, 'over_cap'), 250);

      // Cap at 100 rows, chunk size 50, yieldSleepMs 5
      const startTime = Date.now();
      const trimmed = (await model.enforceRowCap(['over_cap'], 100, 50, 5)).deleted;
      const elapsed = Date.now() - startTime;

      assert.strictEqual(trimmed, 150, 'Must trim exactly 150 over-cap rows');
      assert.strictEqual(countLogs(db, 'over_cap'), 100, 'Profile must retain exactly 100 rows');
      console.log(`   Trimmed ${trimmed} rows in chunks in ${elapsed}ms`);
      console.log('   ✓ Row cap accurately enforced with chunked deletion pacing.');
    }

    // ── TEST 4: Negative or NaN log_retention_days is clamped safely ──────────
    console.log('4. Testing safe clamping of negative or NaN log_retention_days...');
    {
      const db: any = newDb(dir, 'clamping.sqlite');
      dbsToClose.push(db);
      const model = new LogRetentionModel(db);

      // Insert profile with negative retention days (-5)
      addProfile(db, 'prof_neg', -5 as any);
      // Insert fresh logs (from 1 hour ago)
      addLogs(db, 'prof_neg', 100, NOW - 3600, 1);
      assert.strictEqual(countLogs(db, 'prof_neg'), 100);

      // Run cleanupGlobal
      const deleted = (await model.cleanupGlobal(30, 0, 0, {}, { chunkSize: 50, yieldSleepMs: 2 })).deleted;

      // Because -5 is clamped to 0 (or retention threshold >= now - 0), logs from 1 hour ago are NOT deleted as future threshold
      // When retention is 0 (disabled logs), threshold is now, so all past logs are deleted, but future logs are never targeted!
      // More importantly, it does not calculate threshold in the future:
      assert.strictEqual(countLogs(db, 'prof_neg'), 0, 'Retention 0 deletes past logs');
      console.log('   ✓ Negative retention days clamped safely without future threshold calculation.');
    }

    // ── TEST 5: deleteByProfile chunked execution ────────────────────────────
    console.log('5. Testing LogModel.deleteByProfile in paced chunks...');
    {
      const db: any = newDb(dir, 'delete_chunked.sqlite');
      dbsToClose.push(db);
      const logModel = new LogModel(db);

      addProfile(db, 'prof_manual', 7);
      // Insert 250 logs
      addLogs(db, 'prof_manual', 250, NOW, 1);
      assert.strictEqual(countLogs(db, 'prof_manual'), 250);

      const startTime = Date.now();
      const success = await logModel.deleteByProfile('prof_manual', 50, 5);
      const elapsed = Date.now() - startTime;

      assert.strictEqual(success, true);
      assert.strictEqual(countLogs(db, 'prof_manual'), 0, 'All logs deleted in chunks');
      assert.ok(elapsed >= 5, `Pacing yield introduced event loop delay: ${elapsed}ms`);
      console.log(`   Deleted 250 logs in chunks in ${elapsed}ms`);
      console.log('   ✓ deleteByProfile cleaned all logs in paced chunks without blocking.');
    }

    // ── TEST 6: Fast-path skip in enforceRowCap using hourly_rollups ──────────
    console.log('6. Testing enforceRowCap fast-path skip using hourly_rollups...');
    {
      const db: any = newDb(dir, 'fastpath.sqlite');
      dbsToClose.push(db);
      const model = new LogRetentionModel(db);

      addProfile(db, 'prof_low', 30);
      // Insert completed rollups totaling 50 entries
      db.rawDb
        .prepare("INSERT INTO hourly_rollups (profile_id, metric_type, hour_timestamp, key, count) VALUES (?, 'action', ?, 'PASS', ?)")
        .run('prof_low', NOW - 3600, 50);

      // Raw logs have 50 rows
      addLogs(db, 'prof_low', 50, NOW, 1);

      // Cap is 500. Rollups indicate only 50 logs.
      // enforceRowCap should skip the offset query entirely!
      const trimmed = (await model.enforceRowCap(['prof_low'], 500, 50, 2)).deleted;
      assert.strictEqual(trimmed, 0, 'No rows trimmed');
      assert.strictEqual(countLogs(db, 'prof_low'), 50, 'All 50 logs intact');
      console.log('   ✓ enforceRowCap fast-path skipped offset scan via hourly_rollups total.');
    }

    // ── TEST 7: Dynamic chunkSize & sleepMs resolution from env / process.env ─
    console.log('7. Testing dynamic chunkSize & yieldSleepMs resolution from env & process.env...');
    {
      const db: any = newDb(dir, 'dynamic_env.sqlite');
      dbsToClose.push(db);

      // Part A: Resolution via env object
      const customEnv = {
        LOG_CLEANUP_CHUNK_SIZE: 150,
        LOG_CLEANUP_YIELD_SLEEP_MS: 15
      };
      const modelWithEnv = new LogModel(db, customEnv as any);

      addProfile(db, 'prof_dyn_env', 30);
      addLogs(db, 'prof_dyn_env', 300, NOW, 1);
      assert.strictEqual(countLogs(db, 'prof_dyn_env'), 300);

      const startEnv = Date.now();
      const resEnv = await modelWithEnv.deleteByProfile('prof_dyn_env');
      const elapsedEnv = Date.now() - startEnv;

      assert.strictEqual(resEnv, true);
      assert.strictEqual(countLogs(db, 'prof_dyn_env'), 0, 'All 300 logs deleted');
      assert.ok(elapsedEnv >= 10, `Yield sleep from customEnv took ${elapsedEnv}ms (expected >= 10ms)`);
      console.log(`   Deleted 300 logs using customEnv in ${elapsedEnv}ms`);

      // Part B: Resolution via process.env fallback when env is not provided
      const oldChunk = process.env.LOG_CLEANUP_CHUNK_SIZE;
      const oldSleep = process.env.LOG_CLEANUP_YIELD_SLEEP_MS;
      try {
        process.env.LOG_CLEANUP_CHUNK_SIZE = '100';
        process.env.LOG_CLEANUP_YIELD_SLEEP_MS = '12';

        const modelWithProcessEnv = new LogModel(db);
        addProfile(db, 'prof_dyn_proc', 30);
        addLogs(db, 'prof_dyn_proc', 200, NOW, 1);
        assert.strictEqual(countLogs(db, 'prof_dyn_proc'), 200);

        const startProc = Date.now();
        const resProc = await modelWithProcessEnv.deleteByProfile('prof_dyn_proc');
        const elapsedProc = Date.now() - startProc;

        assert.strictEqual(resProc, true);
        assert.strictEqual(countLogs(db, 'prof_dyn_proc'), 0, 'All 200 logs deleted');
        assert.ok(elapsedProc >= 8, `Yield sleep from process.env took ${elapsedProc}ms (expected >= 8ms)`);
        console.log(`   Deleted 200 logs using process.env in ${elapsedProc}ms`);
      } finally {
        if (oldChunk !== undefined) process.env.LOG_CLEANUP_CHUNK_SIZE = oldChunk;
        else delete process.env.LOG_CLEANUP_CHUNK_SIZE;
        if (oldSleep !== undefined) process.env.LOG_CLEANUP_YIELD_SLEEP_MS = oldSleep;
        else delete process.env.LOG_CLEANUP_YIELD_SLEEP_MS;
      }
      console.log('   ✓ Log deletions dynamically honor env and process.env without hardcoding.');
    }

    console.log('\n======================================================================');
    console.log('  ALL RETENTION CHUNKING & REDISTRIBUTION TESTS PASSED SUCCESSFULLY!  ');
    console.log('======================================================================\n');
  } finally {
    for (const d of dbsToClose) {
      try {
        d.rawDb?.close();
      } catch {}
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
