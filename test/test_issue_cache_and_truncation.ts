/// <reference types="node" />
import assert from "node:assert";
import { fetchListContent } from "../src/utils/listFetcher";
import { syncSingleList } from "../src/utils/sync/singleListSync";
import { FingerprintSetBuilder, hashDomain, hashDomainWithPipePipe } from "../src/utils/fingerprintSet";
import type { Env } from "../src/types";

// Verifies fetchListContent truncation / transient-525 retry / 304 handling and the
// zero-allocation addPipePipe hash equivalence with add("||" + domain).
// (The former L2 "filter-bin" + hasFilter rehydration section was removed: the combined
//  profile Bloom L2 cache was retired together with the 32-bit Bloom -> 64-bit FingerprintSet migration.)
async function runIssueVerificationTests() {
  console.log(">>> [TEST] Running Issue Reproduction & Fix Verification Tests...\n");

  const originalFetch = globalThis.fetch;

  try {
    // =========================================================================
    // 1. Verify fetchListContent truncation and MAX_LIST_BYTES behavior
    // =========================================================================
    console.log("1. Testing fetchListContent truncation detection...");

    // Create a mock list stream with 100 domains (~2.5 KB)
    const domainLines: string[] = [];
    for (let i = 0; i < 100; i++) {
      domainLines.push(`||domain${i}.test^`);
    }
    const samplePayload = domainLines.join("\n");
    const samplePayloadBytes = new TextEncoder().encode(samplePayload);

    const mockListUrl = "http://93.184.216.34/mock-list.txt";
    globalThis.fetch = (async (url: string | URL | Request) => {
      return new Response(samplePayloadBytes, {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      });
    }) as any;

    // Test 1.1: Content smaller than maxBytes -> not truncated
    let capturedHeaders: any = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(samplePayloadBytes, {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      });
    }) as any;

    const resNormal = await fetchListContent(mockListUrl, 10000, 5000, () => {});
    assert.strictEqual(resNormal.count, 100);
    assert.strictEqual(resNormal.error, null);
    assert.strictEqual(resNormal.truncated, false, "Should not be truncated when size is within limit");
    assert.ok(capturedHeaders, "Headers should be provided to fetch");
    const ua = capturedHeaders["User-Agent"] || (capturedHeaders instanceof Headers ? capturedHeaders.get("User-Agent") : "");
    assert.ok(ua?.includes("DNS-Worker"), `User-Agent should identify as DNS-Worker, got: ${ua}`);
    console.log("   ✓ Non-truncated list parsed completely with standardized DNS-Worker User-Agent.");

    // Test 1.1b: Transient 525 retry mechanism
    let attemptCount = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      attemptCount++;
      if (attemptCount === 1) {
        // First attempt returns Cloudflare 525
        return new Response("", { status: 525, statusText: "" });
      }
      // Second attempt succeeds
      return new Response(samplePayloadBytes, {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      });
    }) as any;

    const resRetry = await fetchListContent(mockListUrl, 10000, 5000, () => {});
    assert.strictEqual(attemptCount, 2, "Should have retried after initial 525 failure");
    assert.strictEqual(resRetry.count, 100);
    assert.strictEqual(resRetry.error, null);
    console.log("   ✓ Transient HTTP 525 successfully recovered via backoff retry.");

    // Reset fetch mock for 1.2
    globalThis.fetch = (async (url: string | URL | Request) => {
      return new Response(samplePayloadBytes, {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      });
    }) as any;

    // Test 1.2: Content larger than maxBytes (e.g. limit to 500 bytes) -> truncated=true
    let parsedCountTruncated = 0;
    const resTruncated = await fetchListContent(mockListUrl, 500, 5000, () => {
      parsedCountTruncated++;
    });
    assert.strictEqual(resTruncated.truncated, true, "Should be flagged as truncated");
    assert.ok(resTruncated.count < 100, "Truncated count should be less than total 100");
    assert.strictEqual(resTruncated.count, parsedCountTruncated);
    assert.strictEqual(resTruncated.error, null);
    console.log(`   ✓ Truncation detected properly (parsed ${resTruncated.count}/100 rules with truncated=true).`);

    // Test 1.3: Verify syncSingleList sets syncError warning on truncation
    console.log("2. Testing syncSingleList warning on truncation...");
    let savedSyncStatus: any = null;
    const mockListModel: any = {
      updateListSyncStatus: async (id: number, now: number | null, enabled?: number | null, syncError?: string | null) => {
        savedSyncStatus = { id, now, enabled: enabled ?? null, syncError: syncError ?? null };
        return true;
      }
    };
    const mockListFilterModel: any = {
      getListFilterHeader: async () => null,
      upsertListFilter: async () => true,
      deleteListFilter: async () => true
    };
    const mockDbObj = {
      run: async () => ({ success: true }),
      first: async () => null,
      all: async () => ({ results: [] })
    };
    const mockEnv: Env = {
      MAX_LIST_BYTES: 500, // force truncation
      DB: {
        prepare: () => ({
          bind: () => mockDbObj,
          ...mockDbObj
        })
      } as any,
      ASSETS: {}
    };

    const syncRes = await syncSingleList("prof_trunc_test", { id: 42, url: mockListUrl }, mockEnv, mockListModel, mockListFilterModel, Math.floor(Date.now() / 1000));
    const syncWarning = syncRes.syncError;
    assert.ok(syncWarning !== null, "syncError should not be null on truncation");
    // Warning is a machine-readable code carrying the effective env limit; the UI localizes it
    assert.strictEqual(syncWarning, "limit:bytes=500", "syncError should carry the bytes limit code");
    assert.strictEqual(savedSyncStatus?.syncError, syncWarning, "sync_error should be saved in database");
    console.log("   ✓ syncSingleList safely recorded truncation warning without silent pass.");

    // Test 1.4: Zero-allocation addPipePipe bit-for-bit equivalence with add("||" + domain)
    const testDomains = ["adservice.google.com", "tracker.analytics.net", "telemetry.badsite.org"];
    for (const d of testDomains) {
      assert.strictEqual(hashDomainWithPipePipe(d), hashDomain(`||${d}`), "hashDomainWithPipePipe must match hashDomain(||domain)");
    }
    const b1 = new FingerprintSetBuilder();
    const b2 = new FingerprintSetBuilder();
    for (const d of testDomains) {
      b1.add(`||${d}`);
      b2.addPipePipe(d);
    }
    const s1 = await b1.build();
    const s2 = await b2.build();
    const buf1 = s1.toUint8Array();
    const buf2 = s2.toUint8Array();
    assert.strictEqual(buf1.length, buf2.length);
    assert.ok(buf1.every((byte, idx) => byte === buf2[idx]), "addPipePipe must match standard add(||domain) bit for bit");
    console.log("   ✓ addPipePipe zero-heap-allocation prefix hash verified bit-for-bit identical.");

    // Test 1.5: HTTP 304 Not Modified conditional request handling
    let receivedConditionalHeaders: any = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      receivedConditionalHeaders = init?.headers;
      // Per RFC 7230 / WHATWG Fetch spec: status 304 must have null body
      return new Response(null, {
        status: 304,
        headers: { "ETag": '"etag-v123"', "Last-Modified": "Wed, 21 Oct 2026 07:28:00 GMT" }
      });
    }) as any;

    const res304 = await fetchListContent(mockListUrl, 10000, 5000, () => {
      assert.fail("Callback should not be invoked on 304 Not Modified");
    }, { etag: '"etag-v123"' });

    assert.strictEqual(res304.notModified, true, "Should report notModified: true");
    assert.strictEqual(res304.count, 0, "No domains should be parsed on 304");
    assert.strictEqual(res304.error, null);
    assert.strictEqual(receivedConditionalHeaders["If-None-Match"], '"etag-v123"');
    console.log("   ✓ HTTP 304 Not Modified conditional request verified with 0 parsing overhead.");

  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("\n======================================================");
  console.log("   ALL ISSUE VERIFICATION & RECOVERY TESTS PASSED!    ");
  console.log("======================================================");
}

runIssueVerificationTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
