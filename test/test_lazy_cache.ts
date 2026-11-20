/**
 * @file test_lazy_cache.ts
 * @description Lazy cache: an expired DNS answer is served at once (short TTL) and refreshed in the background.
 *   1. capResponseTtl lowers record TTLs but not the EDNS OPT record.
 *   2. Sweep keeps entries inside their stale window and drops the rest.
 *   3. pipeline.process serves a stale entry with a short TTL and keeps it; past the window it is dropped.
 *   4. scheduleStaleRefresh: single flight, retry back-off, concurrency cap, failures swallowed.
 *   5. recordSuccessAndCache: staleUntil is set; a background refresh never replaces a good entry with SERVFAIL,
 *      and a good refresh overwrites the same entry without losing hit counting.
 */
import assert from 'node:assert';
import { dnsCache, sweepExpiredDnsCache } from '../src/pipeline/cache';
import { pipeline } from '../src/pipeline';
import { recordSuccessAndCache } from '../src/pipeline/resolver/observability';
import { capResponseTtl } from '../src/utils/dns';
import { scheduleStaleRefresh, inflightRefreshCount, MAX_CONCURRENT_REFRESHES } from '../src/pipeline/lazyRefresh';

/** a.com A answer (TTL `ttl`) + EDNS OPT record whose "TTL" field carries flags. */
function packet(ttl: number, rcode = 0): Uint8Array {
  const bytes = [
    0x12, 0x34, 0x81, 0x80 | rcode, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    1, 0x61, 3, 0x63, 0x6f, 0x6d, 0, 0x00, 0x01, 0x00, 0x01, // question a.com A IN
    0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, (ttl >>> 24) & 255, (ttl >>> 16) & 255, (ttl >>> 8) & 255, ttl & 255, 0x00, 0x04, 1, 2, 3, 4,
    0x00, 0x00, 0x29, 0x10, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, // OPT, flags 0x00008000
  ];
  return new Uint8Array(bytes);
}
const ttlOf = (p: Uint8Array) => new DataView(p.buffer, p.byteOffset).getUint32(29);
const optFlags = (p: Uint8Array) => new DataView(p.buffer, p.byteOffset).getUint32(p.length - 6);

async function main(): Promise<void> {
  console.log('>>> [TEST] Lazy cache...\n');

  console.log('1. capResponseTtl');
  assert.strictEqual(ttlOf(packet(300)), 300);
  const capped = capResponseTtl(packet(300), 30);
  assert.strictEqual(ttlOf(capped), 30, 'TTL above the cap is lowered');
  assert.strictEqual(optFlags(capped), 0x00008000, 'OPT flags are untouched');
  assert.strictEqual(ttlOf(capResponseTtl(packet(10), 30)), 10, 'lower TTL is kept');
  const cutoff = packet(300).slice(0, 25);
  assert.deepStrictEqual(Array.from(capResponseTtl(cutoff, 30)), Array.from(cutoff), 'truncated packet returned unchanged');
  console.log('   ✓');

  console.log('2. sweep honours staleUntil');
  dnsCache.clear();
  const now = Date.now();
  dnsCache.set('p:inwindow.com:A', { answer: packet(60), expiresAt: now - 1000, staleUntil: now + 60000 });
  dnsCache.set('p:pastwindow.com:A', { answer: packet(60), expiresAt: now - 5000, staleUntil: now - 1000 });
  dnsCache.set('p:legacy.com:A', { answer: packet(60), expiresAt: now - 1000 });
  dnsCache.set('p:fresh.com:A', { answer: packet(60), expiresAt: now + 60000, staleUntil: now + 120000 });
  assert.strictEqual(sweepExpiredDnsCache(), 2);
  assert.ok(dnsCache.has('p:inwindow.com:A') && dnsCache.has('p:fresh.com:A'));
  assert.ok(!dnsCache.has('p:pastwindow.com:A') && !dnsCache.has('p:legacy.com:A'));
  console.log('   ✓');

  console.log('3. pipeline serves a stale entry with a short TTL');
  dnsCache.clear();
  const ctx: any = { profileId: 'prof_lazy', startTime: Date.now(), noLog: true, env: { DNS_STALE_ANSWER_TTL_SEC: 20, DNS_STALE_WINDOW_SEC: 3600 } };
  const req = new Request('https://dns.example.com/dns-query');
  const key = 'prof_lazy:a.com:A';
  dnsCache.set(key, { answer: packet(300), ttl: 300, action: 'PASS', reason: 'Default Allow', expiresAt: Date.now() - 2000, staleUntil: Date.now() + 60000 });
  const res = await pipeline.process(req, { name: 'a.com', type: 'A', raw: new Uint8Array([0xaa, 0xbb]) } as any, ctx);
  assert.strictEqual(res.action, 'PASS');
  assert.strictEqual(res.ttl, 20, 'client gets the stale TTL');
  assert.strictEqual(ttlOf(res.answer), 20, 'record TTL inside the packet is capped too');
  assert.strictEqual(res.answer[0], 0xaa, 'transaction id of the new query');
  assert.ok(res.timings?.dns_cache_mem !== undefined, 'served from memory without waiting for upstream');
  assert.ok(dnsCache.has(key), 'stale entry is kept for the refresh to overwrite');

  dnsCache.set(key, { answer: packet(300), ttl: 300, action: 'PASS', expiresAt: Date.now() - 5000, staleUntil: Date.now() - 1 });
  try { await pipeline.process(req, { name: 'a.com', type: 'A', raw: new Uint8Array([1, 2]) } as any, ctx); } catch { /* upstream unavailable in test */ }
  assert.ok(!dnsCache.has(key), 'entry past its stale window is removed');
  console.log('   ✓');

  console.log('4. scheduleStaleRefresh');
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const entry: { nextRefreshAt?: number } = {};
  assert.strictEqual(scheduleStaleRefresh('k1', entry, async () => { runs++; await gate; }, {}, undefined), true);
  assert.strictEqual(scheduleStaleRefresh('k1', {}, async () => { runs++; }, {}, undefined), false, 'single flight per key');
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(inflightRefreshCount(), 0, 'finished refresh is forgotten');
  assert.strictEqual(scheduleStaleRefresh('k1', entry, async () => { runs++; }, {}, undefined), false, 'retry back-off after an attempt');
  assert.strictEqual(scheduleStaleRefresh('k1', entry, async () => { runs++; }, {}, undefined, Date.now() + 60000), true, 'allowed again after the back-off');
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(runs, 2);
  assert.strictEqual(scheduleStaleRefresh('boom', {}, async () => { throw new Error('upstream down'); }, {}, undefined), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(inflightRefreshCount(), 0, 'a failing refresh is swallowed and cleaned up');
  const holders: Array<() => void> = [];
  for (let i = 0; i < MAX_CONCURRENT_REFRESHES; i++) {
    assert.strictEqual(scheduleStaleRefresh(`c${i}`, {}, () => new Promise<void>((r) => holders.push(r)), {}, undefined), true);
  }
  assert.strictEqual(scheduleStaleRefresh('over', {}, async () => undefined, {}, undefined), false, 'concurrency cap');
  holders.forEach((r) => r());
  await new Promise((r) => setTimeout(r, 10));
  console.log('   ✓');

  console.log('5. recordSuccessAndCache');
  dnsCache.clear();
  const settings: any = { log_policy: 'all' };
  const base: any = { profileId: 'prof_rec', startTime: Date.now(), env: { DNS_STALE_WINDOW_SEC: 100 } };
  const q: any = { name: 'a.com', type: 'A', raw: new Uint8Array([0, 0]) };
  const rkey = 'prof_rec:a.com:A';
  recordSuccessAndCache(req, q, { ...base, noLog: true }, settings, 'PASS', 'ok', [], packet(60), 60, 'https://u/dns-query');
  const first = dnsCache.get(rkey);
  assert.ok(first && first.staleUntil - first.expiresAt === 100000, 'staleUntil = expiresAt + window');

  first.countHits = true;
  const refreshCtx = { ...base, isBackgroundRefresh: true };
  recordSuccessAndCache(req, q, refreshCtx, settings, 'PASS', 'ok', [], packet(60, 2), 60, 'https://u/dns-query');
  assert.strictEqual(dnsCache.get(rkey), first, 'SERVFAIL refresh does not replace the good entry');
  recordSuccessAndCache(req, q, refreshCtx, settings, 'PASS', 'ok', [], packet(120), 120, 'https://u/dns-query');
  const second = dnsCache.get(rkey);
  assert.notStrictEqual(second, first, 'good refresh overwrites the entry');
  assert.strictEqual(ttlOf(second.answer), 120);
  assert.strictEqual(dnsCache.size, 1, 'same key: no second entry, nothing left behind');
  console.log('   ✓');

  console.log('\n  LAZY CACHE TESTS PASSED\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
