/**
 * Worker-thread SQLite adapter: correctness + event-loop latency.
 *
 *   npm run test:dbworker            (tsx / Node)
 *   bun test/test_db_worker.ts       (Bun, if installed)
 *
 * Correctness covers D1 semantics (params, blobs, batch rollback, read-after-write, reclaim).
 * The benchmark runs heavy DELETE / GROUP BY work and reports the longest time the main event loop
 * was blocked, with SQLite in-process (old behaviour) vs in worker threads.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { initServerfullDb } from '../src/serverfull/db';
import { createWorkerDb } from '../src/serverfull/workerDb';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbworker-'));

buildSync({
  entryPoints: [path.join(root, 'src/serverfull/dbWorker.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(tmp, 'db-worker.mjs'),
  external: ['node:sqlite'],
  logLevel: 'silent',
});
const workerFile = path.join(tmp, 'db-worker.mjs');

function lagMonitor(intervalMs = 5) {
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - intervalMs);
    last = now;
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
      // A fully synchronous job finishes before the timer ever fires, so also count the gap up to now.
      return Math.round(Math.max(max, performance.now() - last - intervalMs));
    },
  };
}

async function seed(db: any, rows: number) {
  await db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, k INTEGER, pad TEXT)');
  for (let start = 0; start < rows; start += 5000) {
    const stmts = [];
    for (let i = start; i < Math.min(rows, start + 5000); i++) {
      stmts.push(db.prepare('INSERT INTO big (id, k, pad) VALUES (?, ?, ?)').bind(i, i % 997, 'x'.repeat(40)));
    }
    await db.batch(stmts);
  }
}

async function heavyWork(db: any): Promise<void> {
  // The kind of work that used to stall DNS: big delete, big aggregate, checkpoint.
  await Promise.all([
    db.prepare('DELETE FROM big WHERE id % 2 = 0').run(),
    db.prepare('SELECT k, COUNT(*) AS c, SUM(length(pad)) AS s FROM big GROUP BY k ORDER BY c DESC').all(),
    db.prepare('SELECT COUNT(*) AS c FROM big WHERE pad LIKE ?').bind('%y%').first(),
  ]);
  await db.exec('PRAGMA wal_checkpoint(PASSIVE)');
}

async function main() {
  // ── Correctness ─────────────────────────────────────────────────────────────────────────────
  const dbPath = path.join(tmp, 't.sqlite');
  const inline = initServerfullDb(dbPath, root); // real migrations + INCREMENTAL auto_vacuum, as in production
  const db = (await createWorkerDb(dbPath, { workerFile, readers: 1 }))!;
  assert.ok(db, 'worker DB should start');
  inline.close();

  await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, a, b, blob BLOB)');

  // params: undefined -> NULL, boolean -> 1/0, lastInsertRowid, changes
  const ins = await db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').bind('x', undefined).run();
  assert.equal(ins.meta.changes, 1);
  assert.equal(ins.meta.last_row_id, 1);
  await db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').bind(true, false).run();
  const row = await db.prepare('SELECT a, b FROM t WHERE id = 2').first<{ a: number; b: number }>();
  assert.deepEqual({ ...row }, { a: 1, b: 0 });
  assert.equal(await db.prepare('SELECT a FROM t WHERE id = 1').first('a'), 'x');
  assert.equal(await db.prepare('SELECT b FROM t WHERE id = 1').first('b'), null);
  assert.equal(await db.prepare('SELECT a FROM t WHERE id = 99').first(), null);

  // raw()
  const raw = await db.prepare('SELECT id, a FROM t ORDER BY id').raw({ columnNames: true });
  assert.deepEqual(raw[0], ['id', 'a']);
  assert.equal(raw.length, 3);

  // BLOB: a 1.5 MB view into a 6 MB buffer must store exactly 1.5 MB, and the caller's buffer stays usable.
  const big = new Uint8Array(6 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 0xff;
  const view = big.subarray(1_572_864, 3_145_728);
  const blobStmt = db.prepare('INSERT INTO t (a, blob) VALUES (?, ?)').bind('blob', view);
  await blobStmt.run();
  await blobStmt.run(); // same statement object can run twice (no detached-buffer error)
  assert.equal(big.byteLength, 6 * 1024 * 1024, 'caller buffer must not be detached');
  const got = await db.prepare('SELECT blob, length(blob) AS n FROM t WHERE a = ? ORDER BY id LIMIT 1').bind('blob').first<{
    blob: ArrayBuffer;
    n: number;
  }>();
  assert.equal(got!.n, 1_572_864);
  assert.ok(got!.blob instanceof ArrayBuffer, 'BLOBs come back as ArrayBuffer like D1');
  assert.equal(got!.blob.byteLength, 1_572_864);
  assert.deepEqual(new Uint8Array(got!.blob).subarray(0, 8192), view.subarray(0, 8192));

  // Buffer params (pooled small buffers) must not corrupt the pool or the stored value.
  const small = Buffer.from('hello');
  await db.prepare('INSERT INTO t (a, blob) VALUES (?, ?)').bind('small', small).run();
  const sm = await db.prepare('SELECT blob FROM t WHERE a = ?').bind('small').first<{ blob: ArrayBuffer }>();
  assert.equal(Buffer.from(sm!.blob).toString(), 'hello');
  assert.equal(Buffer.from('still works').toString(), 'still works');

  // batch(): atomic; a failing statement rolls everything back and the SQLite message survives.
  await assert.rejects(
    db.batch([
      db.prepare("INSERT INTO t (a) VALUES ('batch-ok')"),
      db.prepare('INSERT INTO no_such_table VALUES (1)'),
    ]),
    /no such table: no_such_table/
  );
  assert.equal((await db.prepare("SELECT COUNT(*) AS c FROM t WHERE a = 'batch-ok'").first<{ c: number }>())!.c, 0);
  const results = await db.batch([
    db.prepare("INSERT INTO t (a) VALUES ('b1')"),
    db.prepare("INSERT INTO t (a) VALUES ('b2')"),
  ]);
  assert.equal(results.length, 2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS c FROM t WHERE a IN ('b1','b2')").first<{ c: number }>())!.c, 2);

  // read-after-write: the reader thread sees every awaited write immediately
  for (let i = 0; i < 200; i++) {
    await db.prepare('INSERT INTO t (a) VALUES (?)').bind(`raw-${i}`).run();
    const c = await db.prepare('SELECT COUNT(*) AS c FROM t WHERE a = ?').bind(`raw-${i}`).first<{ c: number }>();
    assert.equal(c!.c, 1, `reader must see write ${i}`);
  }

  // reclaimSpace(): delete a lot, then give the pages back from the writer thread
  await db.exec('CREATE TABLE junk (id INTEGER PRIMARY KEY, pad BLOB)');
  const payload = new Uint8Array(4096);
  for (let start = 0; start < 6000; start += 1000) {
    const stmts = [];
    for (let i = start; i < start + 1000; i++) stmts.push(db.prepare('INSERT INTO junk VALUES (?, ?)').bind(i, payload));
    await db.batch(stmts);
  }
  await db.prepare('DELETE FROM junk').run();
  const rec = await db.reclaimSpace({ minFreePages: 1, stopBelowPages: 0, maxMs: 20_000 });
  assert.ok(rec.reclaimedPages > 1000, `expected pages reclaimed, got ${JSON.stringify(rec)}`);

  // Error shape used by callers (e.g. "no such column" fallbacks)
  await assert.rejects(db.prepare('SELECT nope FROM t').all(), /no such column: nope/);

  await db.close();
  await assert.rejects(db.prepare('SELECT 1').first(), /closed/i);
  console.log('✓ correctness: params, blobs (no detach / exact size), batch rollback, read-after-write, reclaim, errors');

  // ── Event-loop latency ──────────────────────────────────────────────────────────────────────
  const ROWS = Number(process.env.BENCH_ROWS) || 400_000;

  const inlinePath = path.join(tmp, 'inline.sqlite');
  const a = initServerfullDb(inlinePath, root);
  await seed(a, ROWS);
  let mon = lagMonitor();
  await heavyWork(a);
  const inlineLag = mon.stop();
  a.close();

  const workerPath = path.join(tmp, 'worker.sqlite');
  initServerfullDb(workerPath, root).close();
  const w = (await createWorkerDb(workerPath, { workerFile }))!;
  await seed(w, ROWS);
  mon = lagMonitor();
  await heavyWork(w);
  const workerLag = mon.stop();
  await w.close();

  console.log(`\nLongest main-thread stall during DELETE + GROUP BY + checkpoint on ${ROWS.toLocaleString()} rows:`);
  console.log(`  SQLite in-process (before): ${inlineLag} ms`);
  console.log(`  SQLite in worker threads  : ${workerLag} ms`);
  assert.ok(workerLag < 60, `worker mode should keep the main thread responsive (got ${workerLag} ms)`);
  console.log('✓ latency');
}

main()
  .then(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error('✗ FAILED:', err);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  });
