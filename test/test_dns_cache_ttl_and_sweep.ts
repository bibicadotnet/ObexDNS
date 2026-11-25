/**
 * @file test_dns_cache_ttl_and_sweep.ts
 * @description Formal integration test verifying:
 *   1. DNS Cache TTL expiration tracking in RAM (expiresAt).
 *   2. Lazy eviction on query (expired records are purged immediately from RAM upon get).
 *   3. Periodic sweep (sweepExpiredDnsCache purges all expired entries without affecting fresh ones).
 *   4. ECS-scoped vs unscoped key separation during expiration.
 */

import assert from 'node:assert';
import { dnsCache, sweepExpiredDnsCache, getProfileGeneration, bumpProfileGeneration } from '../src/pipeline/cache';
import { pipeline } from '../src/pipeline';
import { recordSuccessAndCache } from '../src/pipeline/resolver/observability';
import { ExecutionContext, ProfileSettings } from '../src/types';

async function main(): Promise<void> {
  console.log('>>> [TEST] Running DNS Cache TTL, Lazy Eviction & Periodic Sweep Tests...\n');

  const now = Date.now();

  // ── TEST 1: Periodic Sweep (sweepExpiredDnsCache) ──────────────────────────
  console.log('1. Testing sweepExpiredDnsCache periodic sweep...');
  dnsCache.clear();

  // Insert 3 expired entries and 2 fresh entries
  dnsCache.set('p1:expired1.com:A', { expiresAt: now - 10000, answer: new Uint8Array([1, 2]), ttl: 20 });
  dnsCache.set('p1:expired2.com:A', { expiresAt: now - 5000, answer: new Uint8Array([1, 2]), ttl: 20 });
  dnsCache.set('p1:expired3.com:AAAA', { expiresAt: now - 100, answer: new Uint8Array([1, 2]), ttl: 20 });
  dnsCache.set('p1:fresh1.com:A', { expiresAt: now + 60000, answer: new Uint8Array([1, 2]), ttl: 60 });
  dnsCache.set('p1:fresh2.com:A', { expiresAt: now + 120000, answer: new Uint8Array([1, 2]), ttl: 120 });

  assert.strictEqual(dnsCache.size, 5, 'Initially 5 entries in cache');

  const sweptCount = sweepExpiredDnsCache();
  assert.strictEqual(sweptCount, 3, 'Should have swept exactly 3 expired entries');
  assert.strictEqual(dnsCache.size, 2, 'Only 2 fresh entries should remain in cache');
  assert.strictEqual(dnsCache.has('p1:expired1.com:A'), false, 'expired1 must be deleted');
  assert.strictEqual(dnsCache.has('p1:expired2.com:A'), false, 'expired2 must be deleted');
  assert.strictEqual(dnsCache.has('p1:expired3.com:AAAA'), false, 'expired3 must be deleted');
  assert.strictEqual(dnsCache.has('p1:fresh1.com:A'), true, 'fresh1 must remain');
  assert.strictEqual(dnsCache.has('p1:fresh2.com:A'), true, 'fresh2 must remain');
  console.log('   ✓ Periodic sweep accurately removed expired records and preserved fresh ones.');

  // ── TEST 2: Lazy Eviction on Pipeline Resolution ───────────────────────────
  console.log('2. Testing Lazy Eviction on query lookup...');
  dnsCache.clear();

  const dummyPacket = new Uint8Array([0x12, 0x34, 0x81, 0x80, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
  
  // Cache an entry that has already expired 2 seconds ago
  const expiredKey = 'prof_test:expired-query.com:A';
  dnsCache.set(expiredKey, {
    answer: dummyPacket,
    ttl: 20,
    action: 'PASS',
    reason: 'Default Allow',
    expiresAt: Date.now() - 2000 // Expired
  });

  assert.strictEqual(dnsCache.has(expiredKey), true, 'Expired entry exists in cache before lookup');

  // Perform lookup using pipeline.execute with mock context
  const mockContext: any = {
    profileId: 'prof_test',
    startTime: Date.now(),
    env: { FAIL_OPEN_UPSTREAM: 'https://1.1.1.1/dns-query' }
  };
  const mockQuery: any = {
    name: 'expired-query.com',
    type: 'A',
    raw: new Uint8Array([0x56, 0x78])
  };
  const mockRequest = new Request('https://dns.example.com/dns-query');

  // Trigger pipeline execution
  try {
    await pipeline.process(mockRequest, mockQuery, mockContext);
  } catch {
    // Upstream fetch might fail in offline test, but lazy eviction check happens BEFORE upstream
  }

  // Verify that the expired entry was lazily purged from dnsCache
  assert.strictEqual(dnsCache.has(expiredKey), false, 'Expired entry must be lazily evicted from RAM on lookup');
  console.log('   ✓ Lazy eviction on query purged expired record immediately from RAM.');

  // ── TEST 3: Fresh Entry Returns Cache Hit ──────────────────────────────────
  console.log('3. Testing Fresh Cache Entry hit...');
  dnsCache.clear();

  const freshKey = 'prof_test:fresh-query.com:A';
  dnsCache.set(freshKey, {
    answer: dummyPacket,
    ttl: 60,
    action: 'PASS',
    reason: 'Default Allow',
    expiresAt: Date.now() + 60000 // Fresh
  });

  const queryHit: any = {
    name: 'fresh-query.com',
    type: 'A',
    raw: new Uint8Array([0xaa, 0xbb])
  };

  const result = await pipeline.process(mockRequest, queryHit, mockContext);
  assert.strictEqual(result.action, 'PASS');
  assert.strictEqual(result.reason, 'Default Allow');
  assert.ok(result.timings.dns_cache_mem !== undefined, 'Result was served directly from in-memory cache');
  assert.strictEqual(result.answer[0], 0xaa, 'DNS Transaction ID matched query ID');
  assert.strictEqual(result.answer[1], 0xbb);
  assert.strictEqual(dnsCache.has(freshKey), true, 'Fresh entry remains in cache');
  console.log('   ✓ Fresh entry hit cache successfully with correct DNS transaction ID.');

  // ── TEST 4: Scoped ECS Fallback ────────────────────────────────────────────
  console.log('4. Testing ECS-scoped fallback after unscoped expiration...');
  dnsCache.clear();

  const baseKey = 'prof_test:ecs-domain.com:A';
  const ecsScope = 'none'; // request has no CF-Connecting-IP
  const scopedKey = `${baseKey}|${ecsScope}`;

  // Unscoped is expired, but scoped is fresh!
  dnsCache.set(baseKey, { expiresAt: Date.now() - 5000, answer: dummyPacket, ttl: 20 });
  dnsCache.set(scopedKey, { expiresAt: Date.now() + 50000, answer: dummyPacket, ttl: 50, action: 'PASS', reason: 'ECS Allow' });

  const queryEcs: any = { name: 'ecs-domain.com', type: 'A', raw: new Uint8Array([0x11, 0x22]) };
  const resEcs = await pipeline.process(mockRequest, queryEcs, mockContext);

  assert.strictEqual(dnsCache.has(baseKey), false, 'Expired unscoped key was purged');
  assert.strictEqual(dnsCache.has(scopedKey), true, 'Fresh scoped key remained and was hit');
  assert.strictEqual(resEcs.reason, 'ECS Allow');
  console.log('   ✓ Expired unscoped key purged and fresh scoped key hit cleanly.');

  // ── TEST 5: Cache Invalidation Race Condition (Profile Generation) ─────────
  console.log('5. Testing cache invalidation race condition with profile generation...');
  dnsCache.clear();

  const raceProfile = 'prof_race';
  const initialGen = getProfileGeneration(raceProfile);

  const raceContext: any = {
    profileId: raceProfile,
    profileGeneration: initialGen,
    startTime: Date.now(),
    noLog: true,
    env: {}
  };
  const raceQuery: any = { name: 'race.com', type: 'A', raw: new Uint8Array([0x11, 0x22]) };

  // Simulate user changing config or clearing cache while query is in-flight:
  await pipeline.clearCache(raceProfile);
  assert.strictEqual(getProfileGeneration(raceProfile), initialGen + 1, 'Profile generation incremented on cache clear');

  // Query resolves now and attempts to cache old PASS result:
  recordSuccessAndCache(
    mockRequest,
    raceQuery,
    raceContext,
    {} as any,
    'PASS',
    'Old Config Allow',
    [],
    dummyPacket,
    60,
    'https://1.1.1.1/dns-query'
  );

  const raceKey = `${raceProfile}:race.com:A`;
  assert.strictEqual(dnsCache.has(raceKey), false, 'Stale DNS cache write must be discarded when generation mismatched');
  console.log('   ✓ In-flight query with outdated generation discarded stale cache write.');

  console.log('\n======================================================================');
  console.log('  ALL DNS CACHE TTL, LAZY EVICTION & SWEEP TESTS PASSED SUCCESSFULLY! ');
  console.log('======================================================================\n');
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
