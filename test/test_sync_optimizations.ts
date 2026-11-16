import assert from 'node:assert';
import { FingerprintSet, FingerprintSetBuilder } from '../src/utils/fingerprintSet';
import { fetchListContent } from '../src/utils/listFetcher';
import {
  syncAllListsForProfile,
  syncNextListForProfile,
  syncSingleListForProfile,
  isProfileSyncing,
  _resetInFlightSyncsForTesting
} from '../src/utils/sync/orchestrator';
import { initNodeGlobals } from '../src/serverfull/cache';

async function runOptimizationsTests() {
  console.log('>>> [TEST] Running Sync Optimizations & Mutex Verification Tests...');
  initNodeGlobals();

  const originalFetch = globalThis.fetch;

  try {
    // 1. Verify Accept-Encoding and pointer-based line scanning
    console.log('1. Testing Accept-Encoding header & pointer-based line scanning...');
    let interceptedHeaders: HeadersInit | undefined;

    const mockContent = "||example.com^\r\n||test.org^\n0.0.0.0 bad.site\r\n! comment line\n||trailing.com^";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      interceptedHeaders = init?.headers;
      // Emit content chunk by chunk to test cross-chunk boundary pointer scanning
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode("||example.com^\r\n||test."));
          controller.enqueue(enc.encode("org^\n0.0.0.0 bad.site\r\n! comment line\n||trai"));
          controller.enqueue(enc.encode("ling.com^"));
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      });
    };

    const parsedDomains: string[] = [];
    const result = await fetchListContent(
      'http://93.184.216.34/rules.txt',
      1024 * 1024,
      5000,
      (rule) => {
        if ('domain' in rule && rule.domain) {
          parsedDomains.push(rule.domain);
        }
      }
    );

    // Verify Accept-Encoding header was passed
    assert.ok(interceptedHeaders, 'Headers must be supplied to fetch');
    const headerObj = interceptedHeaders as Record<string, string>;
    assert.strictEqual(
      headerObj['Accept-Encoding'],
      'gzip, deflate, br',
      'fetchListContent must include Accept-Encoding: gzip, deflate, br'
    );
    console.log('   ✓ Accept-Encoding: gzip, deflate, br verified in HTTP request headers.');

    // Verify cross-chunk pointer scanning correctness
    assert.strictEqual(result.count, 4, 'Should parse 4 valid rules (skipping comment)');
    assert.deepStrictEqual(
      parsedDomains,
      ['example.com', 'test.org', 'bad.site', 'trailing.com'],
      'Pointer-based line scanner must correctly reassemble cross-chunk tokens and strip CRLF'
    );
    console.log('   ✓ Pointer-based line scanning parsed cross-chunk and CRLF lines cleanly.');

    // 2. Verify In-Flight Sync Mutex
    console.log('2. Testing In-Flight Sync Mutex & Request Deduplication...');
    _resetInFlightSyncsForTesting();

    const profileId = 'prof_mutex_test';
    let executeCount = 0;

    const sampleSetBuilder = new FingerprintSetBuilder();
    sampleSetBuilder.add("blocked.test");
    const sampleSet = await sampleSetBuilder.build();
    const sampleSetBuf = sampleSet.toUint8Array().buffer;

    // Create a mock DB and environment
    const mockDb = {
      prepare(sql: string) {
        const stmt = {
          async all() {
            if (sql.includes('system_lists')) {
              return { results: [] };
            }
            if (sql.includes('list_blooms')) {
              return {
                results: [{
                  chunk_index: 0,
                  bloom_filter_chunk: sampleSetBuf
                }]
              };
            }
            return {
              results: [
                {
                  id: 1,
                  profile_id: profileId,
                  name: 'List 1',
                  url: 'http://93.184.216.34/rules.txt',
                  enabled: 1,
                  last_synced_at: 0
                }
              ]
            };
          },
          async first() {
            return { id: profileId, list_updated_at: 0, settings: '{}' };
          },
          async run() {
            return { success: true };
          }
        };
        return {
          bind() {
            return stmt;
          },
          ...stmt
        };
      },
      async batch() {
        return [];
      }
    } as any;

    const mockEnv = {
      DB: mockDb
    } as any;

    const mockCtx = {
      waitUntil: () => {}
    } as any;

    // Intercept fetch with a delay to simulate slow download while testing concurrency
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      executeCount++;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return new Response("||blocked.test^\n", {
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      });
    };

    assert.strictEqual(isProfileSyncing(profileId), false);

    // Launch two concurrent full sync requests for the same profile
    const p1 = syncAllListsForProfile(profileId, mockEnv, mockCtx);
    assert.strictEqual(isProfileSyncing(profileId), true, 'Profile must be marked as syncing immediately');

    const p2 = syncAllListsForProfile(profileId, mockEnv, mockCtx);

    // Both promises should resolve
    await Promise.all([p1, p2]);

    assert.strictEqual(isProfileSyncing(profileId), false, 'Profile lock must be released after completion');
    assert.strictEqual(
      executeCount,
      1,
      'Concurrent syncAllListsForProfile calls must deduplicate into exactly 1 underlying sync execution'
    );
    console.log('   ✓ Concurrent syncAllListsForProfile calls deduplicated into single execution.');

    // 3. Test Cron skipping when sync is in-flight
    console.log('3. Testing Cron sync skipping when profile is already syncing...');
    executeCount = 0;

    const slowSync = syncAllListsForProfile(profileId, mockEnv, mockCtx);
    assert.strictEqual(isProfileSyncing(profileId), true);

    // Call cron sync while full sync is active
    await syncNextListForProfile(profileId, mockEnv, mockCtx);

    await slowSync;
    assert.strictEqual(isProfileSyncing(profileId), false);
    assert.strictEqual(
      executeCount,
      1,
      'syncNextListForProfile must skip execution when another sync is already in-flight'
    );
    console.log('   ✓ syncNextListForProfile properly skipped when profile was busy.');

    // 4. Test FingerprintSet Serialization & Element Lookup
    console.log('4. Testing FingerprintSet serialization & element lookup...');
    const builder = new FingerprintSetBuilder();
    for (let i = 0; i < 500; i++) {
      builder.add(`tracker-${i}.adservice.com`);
    }
    const originalFp = await builder.build();

    // A. Verify binary size: exactly 16 bytes header + 8 bytes per domain
    const binary = originalFp.toUint8Array();
    assert.strictEqual(binary.length, 16 + 500 * 8, "Binary must be 16 bytes header + 8 bytes per domain");

    // B. Verify FPRT magic header
    const magicView = new DataView(binary.buffer, binary.byteOffset, 4);
    assert.strictEqual(magicView.getUint32(0, true), 0x54525046, "Header must start with FPRT magic bytes");
    console.log('   ✓ FPRT magic header verified.');

    // C. Verify element lookup
    const restored = FingerprintSet.fromUint8Array(binary);
    assert.strictEqual(restored.size, 500);
    for (let i = 0; i < 500; i++) {
      assert.strictEqual(restored.test(`tracker-${i}.adservice.com`), true);
    }
    assert.strictEqual(restored.test('safe-domain.example.com'), false);
    console.log('   ✓ Restored FingerprintSet correctly verified all elements.');

  } finally {
    globalThis.fetch = originalFetch;
    _resetInFlightSyncsForTesting();
  }

  console.log('\n======================================================');
  console.log('  ALL SYNC OPTIMIZATION TESTS PASSED SUCCESSFULLY!    ');
  console.log('======================================================');
}

runOptimizationsTests().catch((err) => {
  console.error('[TEST ERROR]:', err);
  process.exit(1);
});
