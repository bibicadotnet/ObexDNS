/**
 * List parse worker: same output as inline parsing, and the main thread stays responsive.
 *
 *   npm run test:listworker            (needs internet; set LIST_URL to use another list; skips when offline)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { parseListCore, ListParseParams } from '../src/utils/sync/listParseCore';
import { runListParse } from '../src/utils/sync/listParseClient';
import { FingerprintSet } from '../src/utils/fingerprintSet';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'listworker-'));
const URL_ = process.env.LIST_URL || 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/ultimate.txt';

buildSync({
  entryPoints: [path.join(root, 'src/utils/sync/listParseWorker.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(tmp, 'list-parse-worker.mjs'),
  logLevel: 'silent',
});
process.env.SYNC_WORKER_FILE = path.join(tmp, 'list-parse-worker.mjs');

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
      return Math.round(Math.max(max, performance.now() - last - intervalMs));
    },
  };
}

const job = {
  url: URL_,
  maxListBytes: 40 * 1024 * 1024,
  timeoutMs: 60_000,
  maxListDomains: 2_000_000,
  maxRegexRules: 1000,
  tuning: { maxRetries: 1 },
};

async function main() {
  // Inline = the previous behaviour (5000-rule slices + 10 ms sleeps). Force it off the worker path.
  let mon = lagMonitor();
  const t0 = performance.now();
  const inline = await parseListCore({ ...job, yieldBatchSize: 5000, yieldSleepMs: 10 } as ListParseParams);
  const inlineMs = Math.round(performance.now() - t0);
  const inlineLag = mon.stop();

  if (inline.fetchError) {
    console.log(`⚠ skipped (could not download ${URL_}): ${inline.fetchError}`);
    return;
  }
  assert.ok(inline.count > 1000, `expected a real list, got ${inline.count} rules`);

  mon = lagMonitor();
  const t1 = performance.now();
  const viaWorker = await runListParse(job, {});
  const workerMs = Math.round(performance.now() - t1);
  const workerLag = mon.stop();

  // Identical output
  assert.equal(viaWorker.fetchError, null);
  assert.equal(viaWorker.count, inline.count);
  assert.deepEqual(viaWorker.adguardPayload, inline.adguardPayload);
  assert.ok(inline.filterBytes && viaWorker.filterBytes);
  assert.equal(Buffer.compare(Buffer.from(viaWorker.filterBytes), Buffer.from(inline.filterBytes)), 0, 'filter bytes must be identical');
  assert.ok(FingerprintSet.isCurrentVersion(viaWorker.filterBytes), 'deserialisable filter');
  assert.equal(viaWorker.filterBytes.buffer.byteLength, viaWorker.filterBytes.byteLength, 'standalone buffer');

  // Errors come back as data, not exceptions
  const bad = await runListParse({ ...job, url: 'http://127.0.0.1:1/x' }, {});
  assert.ok(bad.fetchError, 'unsafe / unreachable URL reports fetchError');
  assert.equal(bad.filterBytes, null);

  // SYNC_WORKER=0 -> inline fallback gives the same result
  const off = await runListParse(job, { SYNC_WORKER: '0' });
  assert.equal(off.count, inline.count);

  console.log(`✓ identical output (${inline.count.toLocaleString()} rules, ${(inline.filterBytes.byteLength / 1024 / 1024).toFixed(1)} MB filter)`);
  console.log(`\nLongest main-thread stall while syncing ${URL_.split('/').slice(-3).join('/')}:`);
  console.log(`  inline (before): ${inlineLag} ms   (total ${inlineMs} ms)`);
  console.log(`  worker thread  : ${workerLag} ms   (total ${workerMs} ms)`);
  assert.ok(workerLag < 50, `worker mode should not block the main thread (got ${workerLag} ms)`);
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
