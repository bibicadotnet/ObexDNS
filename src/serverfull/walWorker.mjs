/**
 * @file walWorker.mjs
 * @description Worker thread that runs SQLite WAL checkpoints for the serverfull process.
 *
 * Why it exists: node:sqlite is synchronous. With the default wal_autocheckpoint, the COMMIT that pushes the
 * WAL past ~4 MB also copies it into the main database file and fsyncs it, all on the event loop (measured:
 * COMMIT 85 ms while replacing a 1.1M-rule list, wal_checkpoint 24-38 ms after every log cleanup). Here the
 * main connection has wal_autocheckpoint = 0 and this thread, with its own connection, does the copying.
 *
 * Every intervalMs (WAL_CHECKPOINT_INTERVAL_MS, default 15 s, the same rhythm as the log flush) it runs
 * wal_checkpoint(PASSIVE). When nothing was written since the previous run SQLite returns at once without
 * touching the disk, so an idle database costs nothing. PASSIVE never waits for readers or writers on the main
 * connection, so DNS queries are never delayed by it. The -wal file is trimmed by journal_size_limit once a
 * checkpoint lets SQLite restart it.
 *
 * Plain .mjs on purpose: it is bundled separately to dist/walWorker.mjs and is not part of serverfull.mjs.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const { dbPath, intervalMs } = workerData;

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000;');

let timer = null;
let stopped = false;

function tick() {
  timer = null;
  if (stopped) return;
  try {
    db.exec('PRAGMA wal_checkpoint(PASSIVE);');
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
  if (!stopped) timer = setTimeout(tick, intervalMs);
}

parentPort.on('message', (msg) => {
  if (!msg || msg.type !== 'stop') return;
  stopped = true;
  if (timer) clearTimeout(timer);
  try {
    db.close();
  } catch {
    /* ignore */
  }
  parentPort.postMessage({ type: 'stopped' });
  process.exit(0);
});

parentPort.postMessage({ type: 'ready' });
timer = setTimeout(tick, intervalMs);
