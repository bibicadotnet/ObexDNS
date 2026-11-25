import assert from 'node:assert';
import { FingerprintSet, FingerprintSetBuilder } from '../src/utils/fingerprintSet';

async function runTests() {
  console.log(">>> Testing FingerprintSet basics...");
  const builder = new FingerprintSetBuilder();
  builder.add("example.com");
  builder.addPipePipe("adserver.net");
  builder.add("sub.domain.org");

  const set = await builder.build();
  assert.strictEqual(set.size, 3);
  assert.strictEqual(set.test("example.com"), true);
  assert.strictEqual(set.test("adserver.net"), false); // was added as pipepipe
  assert.strictEqual(set.testPipePipe("adserver.net"), true);
  assert.strictEqual(set.test("sub.domain.org"), true);
  assert.strictEqual(set.test("notfound.com"), false);
  assert.strictEqual(set.testPipePipe("notfound.com"), false);

  console.log(">>> Testing serialization roundtrip...");
  const bytes = set.toUint8Array();
  assert.strictEqual(FingerprintSet.isCurrentVersion(bytes), true);
  const restored = FingerprintSet.fromUint8Array(bytes);
  assert.strictEqual(restored.size, 3);
  assert.strictEqual(restored.test("example.com"), true);
  assert.strictEqual(restored.testPipePipe("adserver.net"), true);
  assert.strictEqual(restored.test("notfound.com"), false);

  console.log(">>> Testing large scale (300,000 domains with 18-bit index & block sorting)...");
  const largeBuilder = new FingerprintSetBuilder();
  const testDomains = [];
  for (let i = 0; i < 300000; i++) {
    const d = `domain-${i}.test.local`;
    largeBuilder.add(d);
    if (i % 10000 === 0) testDomains.push(d);
  }

  const largeSet = await largeBuilder.build();
  assert.strictEqual(largeSet.size, 300000);
  console.log(`Large set byteLength: ${largeSet.byteLength} bytes (~${(largeSet.byteLength / 1024 / 1024).toFixed(2)} MB)`);

  for (const d of testDomains) {
    assert.strictEqual(largeSet.test(d), true);
  }
  assert.strictEqual(largeSet.test("non-existent-domain.xyz"), false);

  console.log(">>> Testing set merging...");
  const b1 = new FingerprintSetBuilder();
  b1.add("a.com");
  b1.add("b.com");
  const s1 = await b1.build();

  const b2 = new FingerprintSetBuilder();
  b2.add("b.com");
  b2.add("c.com");
  const s2 = await b2.build();

  const merged = await FingerprintSet.mergeSets([s1, s2]);
  assert.strictEqual(merged.size, 3); // a, b, c (deduplicated)
  assert.strictEqual(merged.test("a.com"), true);
  assert.strictEqual(merged.test("b.com"), true);
  assert.strictEqual(merged.test("c.com"), true);
  assert.strictEqual(merged.test("d.com"), false);

  console.log(">>> All FingerprintSet tests passed successfully!");
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
