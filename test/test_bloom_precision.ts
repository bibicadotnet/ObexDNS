import assert from 'node:assert';
import { FingerprintSet, FingerprintSetBuilder } from '../src/utils/fingerprintSet';

async function runPrecisionTests() {
  console.log('>>> [TEST] Running FingerprintSet Precision Tests...');

  // 1. Basic add & test
  const builder = new FingerprintSetBuilder();
  builder.add('example.com');
  builder.addPipePipe('adserver.net');
  const set = await builder.build();

  assert.strictEqual(set.test('example.com'), true, 'Exact domain should be found');
  assert.strictEqual(set.test('notfound.com'), false, 'Non-existent domain should not be found');

  // 2. addPipePipe and testPipePipe equivalence with "||"
  assert.strictEqual(set.testPipePipe('adserver.net'), true, 'testPipePipe should match addPipePipe');
  assert.strictEqual(set.test('adserver.net'), false, 'Plain domain test should not match adserver.net when only || was added');
  assert.strictEqual(set.testPipePipe('notfound.com'), false, 'testPipePipe on non-existent domain should be false');

  // 3. Serialization and Deserialization
  console.log('>>> [TEST] Testing serialization roundtrip...');
  const bytes = set.toUint8Array();
  const restored = FingerprintSet.fromUint8Array(bytes);
  assert.strictEqual(FingerprintSet.isCurrentVersion(bytes), true, 'FPRT should be recognized as current version');
  assert.strictEqual(FingerprintSet.isCurrentVersion(null), false, 'Null buffer should not be current version');
  assert.strictEqual(restored.test('example.com'), true);
  assert.strictEqual(restored.testPipePipe('adserver.net'), true);
  assert.strictEqual(restored.test('notfound.com'), false);

  // 4. Merge tests
  console.log('>>> [TEST] Testing FingerprintSet merge...');
  const b1 = new FingerprintSetBuilder();
  const b2 = new FingerprintSetBuilder();
  b1.add('domain1.com');
  b2.add('domain2.com');
  const s1 = await b1.build();
  const s2 = await b2.build();
  const merged = await FingerprintSet.mergeSets([s1, s2]);

  assert.strictEqual(merged.test('domain1.com'), true);
  assert.strictEqual(merged.test('domain2.com'), true);
  assert.strictEqual(merged.test('domain3.com'), false);

  // 5. False positive rate test under realistic load (250,000 domains)
  console.log('>>> [TEST] Validating collision rate under realistic load (250,000 domains)...');
  const bigBuilder = new FingerprintSetBuilder();
  for (let i = 0; i < 250000; i++) {
    bigBuilder.add(`blocked-domain-${i}.com`);
  }
  const bigSet = await bigBuilder.build();

  let falsePositives = 0;
  const testCount = 200000;
  for (let i = 0; i < testCount; i++) {
    if (bigSet.test(`unlisted-domain-${i}.org`)) {
      falsePositives++;
    }
  }

  assert.strictEqual(falsePositives, 0, '64-bit fingerprint should have 0 collisions in 200k tests');
  console.log(`>>> [TEST] Inserted: 250000, Tested: ${testCount}, False Positives: ${falsePositives}`);
  console.log('>>> [TEST] All precision tests passed successfully!');
}

runPrecisionTests().catch(e => {
  console.error("Test failed:", e);
  process.exit(1);
});
