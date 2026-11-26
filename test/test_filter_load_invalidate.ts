import assert from 'node:assert';
import { FingerprintSetBuilder } from '../src/utils/fingerprintSet';

// Slow slices so the index build of a 200K-entry list lasts several hundred ms and a sync can land in the middle of it.
process.env.FILTER_YIELD_CHUNK_ITEMS = '4096';
process.env.FILTER_YIELD_SLEEP_MS = '10';

async function makeFilter(prefix: string, n: number): Promise<ArrayBuffer> {
  const b = new FingerprintSetBuilder();
  for (let i = 0; i < n; i++) b.add(`${prefix}-${i}.list.test`);
  const set = await b.build({ chunkItems: 1 << 30, sleepMs: 0 });
  return set.toUint8Array().buffer as ArrayBuffer;
}

/** Minimal D1 stand-in: serves the filter chunk of list_blooms and no AdGuard rules. */
function fakeDb(nextFilter: () => ArrayBuffer, counter: { reads: number }): any {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async all() {
              if (sql.includes('list_blooms')) {
                counter.reads++;
                await new Promise((r) => setTimeout(r, 2));
                return { results: [{ bloom_filter_chunk: nextFilter() }] };
              }
              return { results: [] };
            },
            async first() {
              return null;
            }
          };
        }
      };
    }
  };
}

async function runTests() {
  const { customListsManager } = await import('../src/lib/filtering/customListsManager');
  const bufA = await makeFilter('alpha', 200_000);
  const bufB = await makeFilter('beta', 150_000);

  console.log('>>> Plain load: index is built while timers keep running, lookups work');
  const c1 = { reads: 0 };
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  await customListsManager.loadList(1, fakeDb(() => bufA, c1));
  clearInterval(timer);
  const f1 = customListsManager.getFilter(1);
  assert.ok(f1, 'filter must be cached');
  assert.strictEqual(f1!.size, 200_000);
  assert.strictEqual(f1!.test('alpha-4242.list.test'), true);
  assert.strictEqual(f1!.test('beta-4242.list.test'), false);
  assert.ok(ticks >= 10, `event loop was starved while loading (ticks=${ticks})`);
  assert.strictEqual(c1.reads, 1);

  console.log('>>> invalidate() in the middle of the sliced index build: stale result is dropped, fresh data is loaded');
  const c2 = { reads: 0 };
  let served = 0;
  const db2 = fakeDb(() => (served++ === 0 ? bufA : bufB), c2);
  customListsManager.invalidate(2);
  const loading = customListsManager.loadList(2, db2);
  await new Promise((r) => setTimeout(r, 120)); // DB read done, index build under way (49 slices x 10 ms)
  assert.strictEqual(customListsManager.getFilter(2), null, 'nothing may be cached while the build is running');
  customListsManager.invalidate(2); // a sync replaced the list meanwhile
  await loading;
  const f2 = customListsManager.getFilter(2);
  assert.ok(f2, 'a retry must have loaded the new list');
  assert.strictEqual(f2!.size, 150_000, 'cache must hold the NEW list, not the stale one');
  assert.strictEqual(f2!.test('beta-7.list.test'), true);
  assert.strictEqual(f2!.test('alpha-7.list.test'), false);
  assert.strictEqual(c2.reads, 2, 'exactly one retry read expected');

  console.log('>>> Corrupt buffer falls back to an empty (negative-cached) set');
  const c3 = { reads: 0 };
  const bad = new Uint8Array(32);
  new DataView(bad.buffer).setUint32(0, 0x54525046, true); // magic ok
  bad[4] = 1;
  new DataView(bad.buffer).setUint32(8, 1_000_000, true); // claims far more entries than present
  await customListsManager.loadList(3, fakeDb(() => bad.buffer as ArrayBuffer, c3));
  const f3 = customListsManager.getFilter(3);
  assert.ok(f3 && f3.size === 0, 'truncated buffer must become an empty set');

  console.log('All filter load/invalidate tests passed.');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
