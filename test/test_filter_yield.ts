import assert from 'node:assert';
import {
  FingerprintSet,
  FingerprintSetBuilder,
  getFilterYieldTuning,
  hashDomain,
  hashDomainWithPipePipe,
  sortBlocksSliced,
  DEFAULT_FILTER_YIELD_CHUNK_ITEMS,
  DEFAULT_FILTER_YIELD_SLEEP_MS
} from '../src/utils/fingerprintSet';

/** Reference result computed the slow way: BigInt values, Set for dedupe, native sort. */
function referenceSorted(domains: string[], pipePipeEvery: number): BigUint64Array {
  const set = new Set<bigint>();
  domains.forEach((d, i) => set.add(pipePipeEvery > 0 && i % pipePipeEvery === 0 ? hashDomainWithPipePipe(d) : hashDomain(d)));
  const arr = BigUint64Array.from(set);
  arr.sort();
  return arr;
}

function sameArray(a: BigUint64Array, b: BigUint64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function buildFrom(domains: string[], pipePipeEvery: number, tuning: { chunkItems: number; sleepMs: number }) {
  const builder = new FingerprintSetBuilder();
  domains.forEach((d, i) => (pipePipeEvery > 0 && i % pipePipeEvery === 0 ? builder.addPipePipe(d) : builder.add(d)));
  return builder.build(tuning);
}

async function runTests() {
  console.log('>>> getFilterYieldTuning: defaults, overrides, clamping');
  const saved = { c: process.env.FILTER_YIELD_CHUNK_ITEMS, s: process.env.FILTER_YIELD_SLEEP_MS };
  delete process.env.FILTER_YIELD_CHUNK_ITEMS;
  delete process.env.FILTER_YIELD_SLEEP_MS;
  assert.deepStrictEqual(getFilterYieldTuning(), { chunkItems: DEFAULT_FILTER_YIELD_CHUNK_ITEMS, sleepMs: DEFAULT_FILTER_YIELD_SLEEP_MS });
  assert.deepStrictEqual(getFilterYieldTuning({}), { chunkItems: DEFAULT_FILTER_YIELD_CHUNK_ITEMS, sleepMs: DEFAULT_FILTER_YIELD_SLEEP_MS });
  assert.deepStrictEqual(getFilterYieldTuning({ FILTER_YIELD_CHUNK_ITEMS: '65536', FILTER_YIELD_SLEEP_MS: '3' }), { chunkItems: 65536, sleepMs: 3 });
  assert.deepStrictEqual(getFilterYieldTuning({ FILTER_YIELD_CHUNK_ITEMS: 100, FILTER_YIELD_SLEEP_MS: 0 }), { chunkItems: 4096, sleepMs: 0 });
  assert.deepStrictEqual(getFilterYieldTuning({ FILTER_YIELD_CHUNK_ITEMS: 'abc', FILTER_YIELD_SLEEP_MS: -5 }), { chunkItems: DEFAULT_FILTER_YIELD_CHUNK_ITEMS, sleepMs: DEFAULT_FILTER_YIELD_SLEEP_MS });
  assert.strictEqual(getFilterYieldTuning({ FILTER_YIELD_SLEEP_MS: 999999 }).sleepMs, 1000);
  process.env.FILTER_YIELD_CHUNK_ITEMS = '8192';
  assert.strictEqual(getFilterYieldTuning().chunkItems, 8192); // falls back to process.env when env object lacks the key
  assert.strictEqual(getFilterYieldTuning({ FILTER_YIELD_CHUNK_ITEMS: 16384 }).chunkItems, 16384); // explicit env wins
  if (saved.c === undefined) delete process.env.FILTER_YIELD_CHUNK_ITEMS; else process.env.FILTER_YIELD_CHUNK_ITEMS = saved.c;
  if (saved.s === undefined) delete process.env.FILTER_YIELD_SLEEP_MS; else process.env.FILTER_YIELD_SLEEP_MS = saved.s;

  console.log('>>> Sliced dedupe + index equals the BigInt reference (duplicates, || entries, slice boundaries)');
  const N = 400000;
  const domains: string[] = [];
  for (let i = 0; i < N; i++) domains.push(`host-${i % 250000}.example.test`); // ~37% duplicates, spread across blocks
  const tinySlices = { chunkItems: 4096, sleepMs: 0 }; // many slices, duplicates certainly straddle slice boundaries
  const built = await buildFrom(domains, 5, tinySlices);
  const ref = referenceSorted(domains, 5);
  assert.ok(ref.length < domains.length, 'test data must contain duplicates');
  assert.ok(sameArray(built.rawArray, ref), 'sorted+deduped table differs from reference');
  assert.strictEqual(built.size, ref.length);

  const bigSlices = await buildFrom(domains, 5, { chunkItems: 1 << 30, sleepMs: 0 });
  assert.ok(sameArray(bigSlices.rawArray, ref), 'single-slice result differs from reference');

  console.log('>>> Lookups: every member found, non-members rejected, index identical to the synchronous build');
  const sync = new FingerprintSet(new BigUint64Array(built.rawArray)); // constructor builds the index synchronously
  const bi: any = built, si: any = sync;
  assert.ok(bi.indexTable && si.indexTable, 'a 100K+ table must carry a prefix index');
  assert.strictEqual(bi.indexBits, si.indexBits);
  assert.strictEqual(bi.indexTable.length, si.indexTable.length);
  for (let k = 0; k < bi.indexTable.length; k++) {
    if (bi.indexTable[k] !== si.indexTable[k]) assert.fail(`index bucket ${k} differs: ${bi.indexTable[k]} vs ${si.indexTable[k]}`);
  }
  for (let i = 0; i < N; i += 97) {
    const d = domains[i];
    const wasPipe = i % 5 === 0;
    // names repeat every 250000 entries and 250000 is a multiple of 5, so a name is always added in the same form
    assert.strictEqual(wasPipe ? built.testPipePipe(d) : built.test(d), true, `missing ${d}`);
  }
  for (let i = 0; i < 5000; i++) {
    assert.strictEqual(built.test(`absent-${i}.nowhere.invalid`), false);
  }

  console.log('>>> fromUint8ArrayAsync equals fromUint8Array (aligned and unaligned buffers)');
  const bytes = built.toUint8Array();
  const viaSync = FingerprintSet.fromUint8Array(bytes);
  const viaAsync = await FingerprintSet.fromUint8ArrayAsync(bytes, tinySlices);
  assert.ok(sameArray(viaSync.rawArray, viaAsync.rawArray));
  assert.strictEqual((viaAsync as any).indexBits, (viaSync as any).indexBits);
  for (let k = 0; k < (viaSync as any).indexTable.length; k++) {
    if ((viaSync as any).indexTable[k] !== (viaAsync as any).indexTable[k]) assert.fail(`async-loaded index bucket ${k} differs`);
  }
  const shifted = new Uint8Array(bytes.length + 3);
  shifted.set(bytes, 3); // payload offset no longer a multiple of 8 -> copy path
  const viaShifted = await FingerprintSet.fromUint8ArrayAsync(shifted.subarray(3), tinySlices);
  assert.ok(sameArray(viaShifted.rawArray, built.rawArray));
  assert.strictEqual(viaShifted.test(domains[1]), built.test(domains[1]));
  await assert.rejects(() => FingerprintSet.fromUint8ArrayAsync(new Uint8Array(4)));

  console.log('>>> Edge cases');
  const one = await buildFrom(['only.test'], 0, tinySlices);
  assert.strictEqual(one.size, 1);
  assert.strictEqual(one.test('only.test'), true);
  const same = await buildFrom(Array.from({ length: 20000 }, () => 'same.test'), 0, tinySlices); // all duplicates, several blocks
  assert.strictEqual(same.size, 1);
  assert.strictEqual(same.test('same.test'), true);
  const empty = await new FingerprintSetBuilder().build(tinySlices);
  assert.strictEqual(empty.size, 0);
  assert.strictEqual(empty.test('x.test'), false);
  const tiny = await buildFrom(['a.test', 'b.test', 'a.test'], 0, tinySlices); // single-block fast path with a duplicate
  assert.strictEqual(tiny.size, 2);

  console.log('>>> mergeSets still correct with the sliced index build');
  const half1 = await buildFrom(domains.slice(0, 250000), 0, tinySlices);
  const half2 = await buildFrom(domains.slice(150000), 0, tinySlices);
  const merged = await FingerprintSet.mergeSets([half1, half2]);
  const mergedRef = referenceSorted(domains, 0);
  assert.ok(sameArray(merged.rawArray, mergedRef), 'merged table differs from reference');
  assert.strictEqual(merged.test(domains[123456]), true);

  console.log('>>> The event loop keeps ticking while a large list is built and indexed');
  const big = new FingerprintSetBuilder();
  for (let i = 0; i < 1_200_000; i++) big.add(`big-${i % 1_100_000}.bulk.test`);
  let ticks = 0;
  let maxGap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, 1);
  const t0 = performance.now();
  const bigSet = await big.build({ chunkItems: 65536, sleepMs: 1 });
  const total = performance.now() - t0;
  clearInterval(timer);
  console.log(`    build 1.2M entries (1.1M unique): ${total.toFixed(0)} ms total, ${ticks} timer ticks, longest gap ${maxGap.toFixed(0)} ms`);
  assert.strictEqual(bigSet.size, 1_100_000);
  assert.ok(ticks >= 10, `timers never ran during build (ticks=${ticks}): slices are not yielding`);
  assert.strictEqual(bigSet.test('big-777.bulk.test'), true);
  assert.strictEqual(bigSet.test('big-1100000.bulk.test'), false);

  console.log('>>> sortBlocksSliced equals a native sort for random, skewed, boundary and duplicate-heavy inputs');
  const rnd32 = (() => {
    let x = 0x9e3779b9;
    return () => {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      return x >>> 0;
    };
  })();
  /** Builds blocks of the given sizes; hiOf/loOf produce the two 32-bit words of each entry. */
  function makeBlocks(sizes: number[], hiOf: (i: number) => number, loOf: (i: number) => number): BigUint64Array[] {
    let n = 0;
    return sizes.map((len) => {
      const b = new BigUint64Array(len);
      const w = new Uint32Array(b.buffer);
      for (let i = 0; i < len; i++, n++) {
        w[2 * i] = loOf(n) >>> 0;
        w[2 * i + 1] = hiOf(n) >>> 0;
      }
      return b;
    });
  }
  function nativeSorted(blocks: BigUint64Array[]): BigUint64Array {
    let total = 0;
    for (const b of blocks) total += b.length;
    const all = new BigUint64Array(total);
    let o = 0;
    for (const b of blocks) { all.set(b, o); o += b.length; }
    all.sort();
    return all;
  }
  const cases: Array<[string, BigUint64Array[]]> = [
    ['random, uneven blocks', makeBlocks([4096, 131072, 131072, 77777, 1, 50000], rnd32, rnd32)],
    ['one bucket only (all high words equal)', makeBlocks([131072, 131072, 40000], () => 0xabcdef12, rnd32)],
    ['two buckets (high bit only)', makeBlocks([131072, 100000], (i) => (i & 1 ? 0x80000000 : 0), rnd32)],
    ['bucket edges 0 and 0xFFFFFFFF', makeBlocks([131072, 131072], (i) => (i % 3 === 0 ? 0 : i % 3 === 1 ? 0xffffffff : rnd32()), rnd32)],
    ['all values identical', makeBlocks([131072, 131072], () => 0x12345678, () => 0x9abcdef0)],
    ['descending order input', makeBlocks([131072, 131072], (i) => 0xffffffff - i * 8000, (i) => 0xffffffff - i)],
    ['tiny table (below the usual 65536 index limit)', makeBlocks([4096, 900], rnd32, rnd32)],
    ['few entries, many slices', makeBlocks([4096, 3, 4096], rnd32, rnd32)]
  ];
  for (const [name, blocks] of cases) {
    const expected = nativeSorted(blocks);
    for (const tuning of [{ chunkItems: 4096, sleepMs: 0 }, { chunkItems: 1 << 30, sleepMs: 0 }]) {
      const got = await sortBlocksSliced(blocks, tuning);
      assert.ok(sameArray(got, expected), `sortBlocksSliced differs from native sort: ${name} (chunk ${tuning.chunkItems})`);
    }
  }
  assert.strictEqual((await sortBlocksSliced([], { chunkItems: 4096, sleepMs: 0 })).length, 0);

  console.log('All filter-yield tests passed.');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
