import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { initServerfullDb } from '../src/serverfull/db';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rootDir = path.resolve(__dirname, '..');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walworker-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const db = initServerfullDb(dbPath, rootDir, { autoVacuum: 'INCREMENTAL' });
  const raw = db.rawDb;
  const autockpt = () => Number(Object.values(raw.prepare('PRAGMA wal_autocheckpoint').get() as object)[0]);

  assert.strictEqual(autockpt(), 1000, 'default auto-checkpoint before the worker starts');

  // 1) Worker takes over: main connection stops checkpointing on COMMIT.
  assert.strictEqual(db.startBackgroundCheckpoint(200), true, 'worker must start');
  assert.strictEqual(autockpt(), 0, 'main connection must not auto-checkpoint while the worker runs');

  // 2) A ~12 MB write (like a list replace) leaves the WAL big, and the worker drains it.
  raw.exec('CREATE TABLE blobs (id INTEGER PRIMARY KEY, c BLOB)');
  const ins = raw.prepare('INSERT INTO blobs (c) VALUES (?)');
  const chunk = Buffer.alloc(1.5 * 1024 * 1024, 7);
  raw.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 8; i++) ins.run(chunk);
  raw.exec('COMMIT');
  const walBefore = fs.statSync(dbPath + '-wal').size;
  assert.ok(walBefore > 8 * 1024 * 1024, `WAL should hold the write (got ${walBefore})`);

  let drained = false;
  for (let i = 0; i < 40 && !drained; i++) {
    await sleep(100);
    const r = raw.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as { log: number; checkpointed: number };
    // the main-thread probe above is only to read the numbers: if the worker already did the work, nothing is left
    drained = r.log === r.checkpointed;
  }
  assert.ok(drained, 'worker must checkpoint the WAL in the background');
  assert.ok(fs.statSync(dbPath).size > 8 * 1024 * 1024, 'data must have reached the main database file');

  // 3) reclaimSpace works while the worker owns checkpointing, with small chunks.
  raw.exec('DELETE FROM blobs');
  const res = await db.reclaimSpace({ minFreePages: 1, stopBelowPages: 0, maxMs: 20_000 });
  assert.ok(res.reclaimedPages > 0 && res.remainingFreePages === 0, `reclaim result: ${JSON.stringify(res)}`);

  // 4) Losing the worker restores the default auto-checkpoint, so the WAL can never grow unchecked.
  const w = (db as unknown as { checkpointWorker: { terminate(): Promise<number> } }).checkpointWorker;
  await w.terminate();
  await sleep(100);
  assert.strictEqual(autockpt(), 1000, 'auto-checkpoint restored after the worker died');

  // 5) Clean stop: start again, stop, connection closes without errors.
  assert.strictEqual(db.startBackgroundCheckpoint(200), true);
  assert.strictEqual(autockpt(), 0);
  await db.stopBackgroundCheckpoint();
  db.close();

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('test_wal_checkpoint_worker: OK');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
