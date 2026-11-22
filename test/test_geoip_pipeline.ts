import assert from 'node:assert/strict';

let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any) => {
  const u = String(url);
  if (u.includes('ip-api.com') || u.includes('ipwho.is')) {
    fetchCalls++;
    await new Promise((r) => setTimeout(r, 300)); // slow GeoIP provider
    return new Response(JSON.stringify({ status: 'success', countryCode: 'US', country: 'United States', isp: 'X' }), { status: 200 });
  }
  return realFetch(url);
}) as any;

async function run() {
  const { fetchGeoIP } = await import('../src/utils/geoip');
  const { recordSuccessAndCache } = await import('../src/pipeline/resolver/observability');
  const { dnsCache } = await import('../src/pipeline/cache');

  // 1. In-flight de-duplication + IPv4-mapped normalisation share one request
  const [a, b, c] = await Promise.all([fetchGeoIP('8.8.8.8'), fetchGeoIP('8.8.8.8'), fetchGeoIP('::ffff:8.8.8.8')]);
  assert.equal(a?.country_code, 'US'); assert.deepEqual(a, b); assert.deepEqual(a, c);
  assert.equal(fetchCalls, 1, 'concurrent lookups must share one fetch');

  // 2. Cache is written synchronously, before any GeoIP work
  const waits: Promise<unknown>[] = [];
  const ctx: any = { waitUntil: (p: Promise<unknown>) => waits.push(p) };
  const mk = (retention: number) => ({ settings: { upstream: [], default_policy: 'ALLOW', log_retention_days: retention } as any });
  const request = new Request('http://x', { headers: { 'CF-Connecting-IP': '203.0.113.9', 'CF-IPCountry': 'VN' } });
  const answers = [{ name: 'a.com', type: 'A', data: '1.1.1.1', ttl: 60 }];
  const context: any = { profileId: 'p1', startTime: Date.now(), env: {}, ctx };

  fetchCalls = 0;
  recordSuccessAndCache(request, { name: 'a.com', type: 'A', raw: new Uint8Array() } as any, context, mk(7).settings, 'PASS', undefined, answers, new Uint8Array([1, 2]), 60, 'u');
  assert.ok(dnsCache.get('p1:a.com:A'), 'dnsCache must be set synchronously, before GeoIP completes');
  assert.equal(waits.length, 1);
  await Promise.all(waits);
  assert.equal(fetchCalls, 1);

  // 3. retention 0 -> no GeoIP at all, but cache still populated
  waits.length = 0; fetchCalls = 0;
  const ctx2: any = { profileId: 'p2', startTime: Date.now(), env: {}, ctx };
  const answers2 = [{ name: 'b.com', type: 'A', data: '9.9.9.9', ttl: 60 }];
  recordSuccessAndCache(request, { name: 'b.com', type: 'A', raw: new Uint8Array() } as any, ctx2, mk(0).settings, 'PASS', undefined, answers2, new Uint8Array([1]), 60, 'u');
  assert.equal(waits.length, 0, 'no background work when log is discarded');
  assert.equal(fetchCalls, 0, 'no GeoIP when log is discarded');
  assert.ok(dnsCache.get('p2:b.com:A'));
  console.log('geoip pipeline tests passed'); process.exit(0);
}
run().catch((e) => { console.error(e); process.exit(1); });
