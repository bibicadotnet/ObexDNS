/**
 * @file test_blocked_cache.ts
 * @description BLOCK / REDIRECT answers are cached like PASS ones (DNS_CACHE_BLOCKED, DNS_CACHE_REDIRECT, DNS_CACHE_BLOCKED_TTL_SEC).
 */
import assert from 'node:assert';
import { dnsCache, bumpProfileGeneration, getProfileGeneration } from '../src/pipeline/cache';
import { pipeline } from '../src/pipeline';
import { handleBlockOrRedirect } from '../src/pipeline/resolver/block';
import { formatDohResponse } from '../src/api/doh';
import { minResponseTtl } from '../src/utils/dns';

function question(name: string, qtype = 1): Uint8Array {
  const labels = name.split('.');
  const bytes: number[] = [0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
  for (const l of labels) { bytes.push(l.length, ...(Array.from(Buffer.from(l)) as number[])); }
  bytes.push(0, 0, qtype, 0, 1);
  return new Uint8Array(bytes);
}
const mkQuery = (name: string, type = 'A') => ({ name, type, raw: question(name, type === 'AAAA' ? 28 : 1) }) as any;
const req = new Request('https://dns.example.com/dns-query');
const settings: any = { log_retention_days: 0, block_mode: 'NULL_IP', upstream: ['https://u/dns-query'] };
const ctxOf = (env: any = {}, extra: any = {}): any => ({ profileId: 'prof_b', startTime: Date.now(), noLog: true, env, ctx: { waitUntil() {} }, ...extra });

async function main(): Promise<void> {
  console.log('>>> [TEST] BLOCK / REDIRECT cache...\n');
  const key = (n: string, t = 'A') => `prof_b:${n}:${t}`;

  console.log('1. BLOCK is cached for 1 day by default and never served stale');
  dnsCache.clear();
  await handleBlockOrRedirect(req, mkQuery('ads.example'), ctxOf(), settings, 'BLOCK', 'List #1');
  const e = dnsCache.get(key('ads.example'));
  assert.ok(e, 'entry stored');
  assert.strictEqual(e.action, 'BLOCK');
  assert.strictEqual(e.reason, 'List #1');
  assert.ok(Math.abs(e.expiresAt - Date.now() - 86400_000) < 2000, 'default TTL 86400s');
  assert.strictEqual(e.staleUntil, e.expiresAt, 'no stale window for a block');
  console.log('   ✓');

  console.log('2. second query is answered from the cache (no rule matching, action BLOCK)');
  const hit = await pipeline.process(req, mkQuery('ads.example'), ctxOf());
  assert.strictEqual(hit.action, 'BLOCK');
  assert.strictEqual(hit.reason, 'List #1');
  assert.ok(hit.timings?.dns_cache_mem !== undefined, 'served from memory');
  console.log('   ✓ (client TTL reported for the hit: ' + hit.ttl + 's)');
  const clientTtl = hit.ttl;

  console.log('3. switches and TTL');
  dnsCache.clear();
  await handleBlockOrRedirect(req, mkQuery('a.example'), ctxOf({ DNS_CACHE_BLOCKED: 'false' }), settings, 'BLOCK', 'r');
  assert.ok(!dnsCache.has(key('a.example')), 'DNS_CACHE_BLOCKED=false: not cached');
  await handleBlockOrRedirect(req, mkQuery('b.example'), ctxOf({ DNS_CACHE_BLOCKED_TTL_SEC: '120' }), settings, 'BLOCK', 'r');
  assert.ok(Math.abs(dnsCache.get(key('b.example')).expiresAt - Date.now() - 120_000) < 2000, 'custom TTL');
  await handleBlockOrRedirect(req, mkQuery('c.example'), ctxOf({ DNS_CACHE_REDIRECT: 'false' }), settings, 'BLOCK', 'r');
  assert.ok(dnsCache.has(key('c.example')), 'DNS_CACHE_REDIRECT=false does not affect BLOCK');
  await handleBlockOrRedirect(req, mkQuery('d.example'), ctxOf({ DNS_CACHE_REDIRECT: 'false' }), settings, 'REDIRECT', 'r', '1.2.3.4', 'A');
  assert.ok(!dnsCache.has(key('d.example')), 'DNS_CACHE_REDIRECT=false: redirect not cached');
  await handleBlockOrRedirect(req, mkQuery('e.example'), ctxOf({ DNS_CACHE_BLOCKED: 'false' }), settings, 'REDIRECT', 'r', '1.2.3.4', 'A');
  assert.ok(dnsCache.has(key('e.example')), 'DNS_CACHE_BLOCKED=false does not affect REDIRECT');
  console.log('   ✓');

  console.log('4. REDIRECT lives for the TTL of its answer (min 10s), also with a CNAME target');
  const r = dnsCache.get(key('e.example'));
  const redirectSec = (r.expiresAt - Date.now()) / 1000;
  assert.ok(redirectSec >= 9 && redirectSec <= 3600, 'redirect TTL from the answer, got ' + redirectSec);
  const okResolver = async () => ({ answer: new Uint8Array([0x12, 0x34, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0x74, 0, 0, 1, 0, 1, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 90, 0, 4, 9, 9, 9, 9]), ttl: 90, action: 'PASS', latency: 1 }) as any;
  await handleBlockOrRedirect(req, mkQuery('f.example'), ctxOf(), settings, 'REDIRECT', 'r', 'target.test', 'CNAME', okResolver);
  assert.ok(dnsCache.has(key('f.example')), 'CNAME redirect cached after a successful target lookup');
  const failResolver = async () => { throw new Error('upstream down'); };
  await handleBlockOrRedirect(req, mkQuery('g.example'), ctxOf(), settings, 'REDIRECT', 'r', 'target.test', 'CNAME', failResolver as any);
  assert.ok(!dnsCache.has(key('g.example')), 'failed target lookup is not cached');
  const emptyResolver = async () => ({ answer: new Uint8Array(0), ttl: 0, action: 'PASS', latency: 1 }) as any;
  await handleBlockOrRedirect(req, mkQuery('h.example'), ctxOf(), settings, 'REDIRECT', 'r', 'target.test', 'CNAME', emptyResolver);
  assert.ok(!dnsCache.has(key('h.example')), 'empty target answer is not cached');
  console.log('   ✓');

  console.log('5. a block computed while the profile changed is dropped');
  dnsCache.clear();
  const gen = getProfileGeneration('prof_b');
  bumpProfileGeneration('prof_b');
  await handleBlockOrRedirect(req, mkQuery('i.example'), ctxOf({}, { profileGeneration: gen }), settings, 'BLOCK', 'r');
  assert.ok(!dnsCache.has(key('i.example')), 'stale generation: not cached');
  await handleBlockOrRedirect(req, mkQuery('j.example'), ctxOf({}, { profileGeneration: getProfileGeneration('prof_b') }), settings, 'BLOCK', 'r');
  assert.ok(dnsCache.has(key('j.example')), 'current generation: cached');
  console.log('   ✓');

  console.log('6. an expired block is dropped, not served stale');
  dnsCache.clear();
  await handleBlockOrRedirect(req, mkQuery('k.example'), ctxOf(), settings, 'BLOCK', 'r');
  dnsCache.get(key('k.example')).expiresAt = Date.now() - 1;
  dnsCache.get(key('k.example')).staleUntil = Date.now() - 1;
  try { await pipeline.process(req, mkQuery('k.example'), ctxOf({ FAIL_OPEN_UPSTREAM: 'https://127.0.0.1/x' })); } catch { /* no DB in test */ }
  assert.ok(!dnsCache.has(key('k.example')), 'expired block removed');
  console.log('   ✓');

  console.log('7. what a proxy in front of the server may cache (DoH Cache-Control)');
  assert.ok(clientTtl > 3600, 'the server keeps the block for a day (reported ' + clientTtl + 's)');
  const doh = formatDohResponse(hit.answer, hit.answer, clientTtl);
  const packetTtl = minResponseTtl(hit.answer);
  assert.ok(packetTtl !== null && packetTtl <= 3600, 'TTL set by buildResponse inside the packet: ' + packetTtl);
  assert.strictEqual(doh.headers.get('Cache-Control'), `max-age=${packetTtl}`, 'max-age follows the TTL inside the DNS message, not the server-side cache life');
  console.log('   ✓');

  console.log('8. REDIRECT uses the lazy cache: served after its TTL, refreshed in the background without a log row');
  dnsCache.clear();
  const logSettings: any = { log_retention_days: 7, block_mode: 'NULL_IP', upstream: ['https://u/dns-query'] };
  let waitUntilCalls = 0;
  const logCtx = (extra: any = {}): any => ({ profileId: 'prof_b', startTime: Date.now(), noLog: false, env: {}, ctx: { waitUntil() { waitUntilCalls++; } }, ...extra });
  await handleBlockOrRedirect(req, mkQuery('l.example'), logCtx(), logSettings, 'REDIRECT', 'DNS Rewrite', 'target.test', 'CNAME', okResolver);
  assert.strictEqual(waitUntilCalls, 1, 'the first (miss) query is logged');
  const re = dnsCache.get(key('l.example'));
  assert.deepStrictEqual(re.redirect, { value: 'target.test', type: 'CNAME' }, 'entry remembers how to refresh itself');
  assert.ok(re.staleUntil > re.expiresAt, 'REDIRECT has a stale window');
  assert.strictEqual(re.staleUntil - re.expiresAt, 3600_000, 'default DNS_STALE_WINDOW_SEC');
  await handleBlockOrRedirect(req, mkQuery('m.example'), ctxOf({ DNS_STALE_WINDOW_SEC: '0' }), settings, 'REDIRECT', 'r', '1.2.3.4', 'A');
  assert.strictEqual(dnsCache.get(key('m.example')).staleUntil, dnsCache.get(key('m.example')).expiresAt, 'DNS_STALE_WINDOW_SEC=0 turns the stale window off');

  // expired but inside the stale window: still answered as REDIRECT
  re.expiresAt = Date.now() - 1000;
  const staleHit = await pipeline.process(req, mkQuery('l.example'), ctxOf({ FAIL_OPEN_UPSTREAM: 'https://127.0.0.1/x' }));
  assert.strictEqual(staleHit.action, 'REDIRECT', 'stale entry answered as REDIRECT, not resolved upstream');
  assert.strictEqual(staleHit.reason, 'DNS Rewrite');
  assert.ok(dnsCache.has(key('l.example')), 'entry kept for the refresh');

  // background refresh: same redirect again, no log row, entry renewed and still a REDIRECT
  waitUntilCalls = 0;
  const before = dnsCache.get(key('l.example')).expiresAt;
  await handleBlockOrRedirect(req, mkQuery('l.example'), logCtx({ isBackgroundRefresh: true }), logSettings, 'REDIRECT', 'DNS Rewrite', 'target.test', 'CNAME', okResolver);
  assert.strictEqual(waitUntilCalls, 0, 'background refresh writes no log row');
  const renewed = dnsCache.get(key('l.example'));
  assert.ok(renewed.expiresAt > before && renewed.expiresAt > Date.now(), 'entry renewed');
  assert.strictEqual(renewed.action, 'REDIRECT');

  // a refresh whose target lookup fails or has no address keeps the good entry
  const servfail = async () => ({ answer: new Uint8Array([0x12, 0x34, 0x81, 0x82, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0x74, 0, 0, 1, 0, 1]), ttl: 0, action: 'PASS', latency: 1 }) as any;
  const good = dnsCache.get(key('l.example'));
  await handleBlockOrRedirect(req, mkQuery('l.example'), logCtx({ isBackgroundRefresh: true }), logSettings, 'REDIRECT', 'DNS Rewrite', 'target.test', 'CNAME', servfail);
  await handleBlockOrRedirect(req, mkQuery('l.example'), logCtx({ isBackgroundRefresh: true }), logSettings, 'REDIRECT', 'DNS Rewrite', 'target.test', 'CNAME', failResolver as any);
  assert.strictEqual(dnsCache.get(key('l.example')), good, 'failed refresh leaves the old entry in place');
  console.log('   ✓');

  console.log('\n  BLOCKED CACHE TESTS PASSED\n');
  process.exit(0);
}
main().catch((err) => { console.error('Test failed:', err.message ?? err); process.exit(1); });
