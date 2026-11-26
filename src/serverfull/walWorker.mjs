/**
 * @file walWorker.mjs
 * @description Worker thread that runs SQLite WAL checkpoints for the serverfull process.
 *
 * Why it exists: node:sqlite is synchronous. With the default wal_autocheckpoint, the COMMIT that pushes the
 * WAL past ~4 MB also copies it into the main database file and fsyncs it, all on the event loop (measured:
 * COMMIT 85 ms while replacing a 1.1M-rule list, wal_checkpoint 24-38 ms after every log cleanup). Here the
 * main connection has wal_autocheckpoint = 0 and this thread, with its own connection, does the copying.
 *
 * PASSIVE mode only: it never waits for readers or writers on the main connection, so DNS queries are never
 * delayed by it. The -wal file is trimmed by journal_size_limit once a checkpoint lets SQLite restart it.
 *
 * Plain .mjs on purpose: it is bundled separately to dist/walWorker.mjs and is not part of serverfull.mjs.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const { dbPath, pollMs } = workerData;
const walPath = `${dbPath}-wal`;

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000;');

let timer = null;
let stopped = false;
let lastSeen = '';

function walStamp() {
  try {
    const st = fs.statSync(walPath);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '';
  }
}

function tick() {
  timer = null;
  if (stopped) return;
  // Only checkpoint when the WAL changed since the previous run; an idle database costs one stat() per poll.
  const stamp = walStamp();
  if (stamp && stamp !== lastSeen) {
    lastSeen = stamp;
    try {
      db.exec('PRAGMA wal_checkpoint(PASSIVE);');
    } catch (err) {
      parentPort.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
    }
  }
  if (!stopped) timer = setTimeout(tick, pollMs);
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
timer = setTimeout(tick, pollMs);
