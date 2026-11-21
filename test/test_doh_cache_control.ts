/**
 * @file test_doh_cache_control.ts
 * @description DoH `Cache-Control: max-age` follows the smallest TTL inside the DNS message and never exceeds `ttl`.
 */
import assert from 'node:assert';
import { formatDohResponse } from '../src/api/doh';
import { minResponseTtl } from '../src/utils/dns';
import { buildResponse } from '../src/utils/dns/encoder';

/** a.com A answer(s) with the given TTLs, optional EDNS OPT. */
function packet(ttls: number[], opt = true, rcode = 0): Uint8Array {
  const b: number[] = [0x12, 0x34, 0x81, 0x80 | rcode, 0, 1, 0, ttls.length, 0, 0, 0, opt ? 1 : 0, 1, 0x61, 3, 0x63, 0x6f, 0x6d, 0, 0, 1, 0, 1];
  for (const t of ttls) b.push(0xc0, 0x0c, 0, 1, 0, 1, (t >>> 24) & 255, (t >>> 16) & 255, (t >>> 8) & 255, t & 255, 0, 4, 1, 2, 3, 4);
  if (opt) b.push(0, 0, 0x29, 0x10, 0, 0, 0, 0x80, 0, 0, 0);
  return new Uint8Array(b);
}
const cc = (answer: Uint8Array | null, ttl?: number) => formatDohResponse(answer, null, ttl).headers.get('Cache-Control');

assert.strictEqual(minResponseTtl(packet([300, 60, 120])), 60, 'smallest TTL');
assert.strictEqual(minResponseTtl(packet([300], false)), 300);
assert.strictEqual(minResponseTtl(packet([], true)), null, 'OPT only: no record');
assert.strictEqual(minResponseTtl(packet([300]).slice(0, 30)), null, 'truncated packet');

assert.strictEqual(cc(packet([3600]), 86400), 'max-age=3600', 'cached BLOCK: server keeps 1 day, clients/proxies 1 hour');
assert.strictEqual(cc(packet([300]), 120), 'max-age=120', 'fresh cache hit: remaining server-side life is shorter');
assert.strictEqual(cc(packet([300]), 30), 'max-age=30', 'stale answer');
assert.strictEqual(cc(packet([60, 300]), 3600), 'max-age=60', 'smallest of several records');
assert.strictEqual(cc(packet([0]), 3600), 'max-age=0, no-cache, no-store', 'TTL 0 is not cacheable');
assert.strictEqual(cc(packet([], false), 90), 'max-age=90', 'no record in the message: falls back to ttl');
// Server-built NXDOMAIN / NODATA carry a SOA, so max-age follows the packet (3600), not the 1 day RAM cache.
for (const rcode of [3, 0]) {
  const q = new Uint8Array([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 3, 0x61, 0x62, 0x63, 0, 0, 1, 0, 1]);
  const neg = buildResponse(q, 'A', '', 3600, rcode);
  assert.strictEqual(minResponseTtl(neg), 3600, 'SOA TTL is readable from the packet');
  assert.strictEqual(cc(neg, 86400), 'max-age=3600', `cached NXDOMAIN/NODATA block (rcode ${rcode}): follows packet, not 1 day`);
}
assert.strictEqual(cc(packet([300]), 0), 'max-age=0, no-cache, no-store', 'ttl 0');
assert.strictEqual(cc(null, 60), 'max-age=0, no-cache, no-store', 'invalid answer becomes SERVFAIL, not cacheable');
console.log('test_doh_cache_control: OK');
