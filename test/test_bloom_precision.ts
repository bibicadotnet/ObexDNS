import assert from 'node:assert';
import { BloomFilter } from '../src/utils/bloom';

async function runBloomPrecisionTests() {
  console.log('>>> [TEST] Running Bloom Filter Precision & Independence Tests...');

  // 1. Basic add & test
  const bf = BloomFilter.create(10000, 0.0001);
  bf.add('example.com');
  bf.addPipePipe('adserver.net');

  assert.strictEqual(bf.test('example.com'), true, 'Exact domain should be found');
  assert.strictEqual(bf.test('notfound.com'), false, 'Non-existent domain should not be found');

  // 2. addPipePipe and testPipePipe equivalence with "||"
  assert.strictEqual(bf.testPipePipe('adserver.net'), true, 'testPipePipe should match addPipePipe');
  assert.strictEqual(bf.test('||adserver.net'), true, 'test("||" + domain) should match addPipePipe');
  assert.strictEqual(bf.test('adserver.net'), false, 'Plain domain test should not match adserver.net when only || was added');
  assert.strictEqual(bf.testPipePipe('notfound.com'), false, 'testPipePipe on non-existent domain should be false');

  // 3. Serialization and Deserialization (BLMZ compressed & uncompressed)
  console.log('>>> [TEST] Testing BLMZ Compression roundtrip...');
  const compressedBytes = bf.toUint8Array(true);
  const uncompressedBytes = bf.toUint8Array(false);

  const restoredFromCompressed = BloomFilter.fromUint8Array(compressedBytes);
  assert.strictEqual(BloomFilter.isCurrentVersion(compressedBytes), true, 'Compressed v2 BLMZ should be recognized as current version');
  assert.strictEqual(BloomFilter.isCurrentVersion(uncompressedBytes), false, 'Legacy uncompressed should not be current version');
  assert.strictEqual(BloomFilter.isCurrentVersion(null), false, 'Null buffer should not be current version');
  assert.strictEqual(restoredFromCompressed.test('example.com'), true);
  assert.strictEqual(restoredFromCompressed.testPipePipe('adserver.net'), true);
  assert.strictEqual(restoredFromCompressed.test('notfound.com'), false);

  const restoredFromRaw = BloomFilter.fromUint8Array(uncompressedBytes);
  assert.strictEqual(restoredFromRaw.test('example.com'), true);
  assert.strictEqual(restoredFromRaw.testPipePipe('adserver.net'), true);

  // 4. Merge tests
  console.log('>>> [TEST] Testing Bloom Filter bitwise merge...');
  const bf1 = BloomFilter.create(10000, 0.0001);
  const bf2 = BloomFilter.create(10000, 0.0001);
  bf1.add('domain1.com');
  bf2.add('domain2.com');
  bf1.merge(bf2);

  assert.strictEqual(bf1.test('domain1.com'), true);
  assert.strictEqual(bf1.test('domain2.com'), true);
  assert.strictEqual(bf1.test('domain3.com'), false);

  // 5. Verification of collision floor (Kirsch-Mitzenmacher 64-bit entropy)
  console.log('>>> [TEST] Validating false positive rate under realistic load (250,000 domains)...');
  const n = 250000;
  const largeFilter = BloomFilter.create(1000000, 0.0001); // m ~ 19.17 Mbits (2.29 MB), k=13
  for (let i = 0; i < n; i++) {
    largeFilter.addPipePipe(`blocked-domain-${i}.tracker.org`);
  }

  // Query 200,000 non-existent domains
  const testQueries = 200000;
  let falsePositives = 0;
  for (let i = 0; i < testQueries; i++) {
    if (largeFilter.testPipePipe(`random-test-query-${i}.legit-site.com`)) {
      falsePositives++;
    }
  }

  const measuredFpRate = falsePositives / testQueries;
  console.log(`>>> [TEST] Inserted: ${n}, Tested: ${testQueries}, False Positives: ${falsePositives} (Rate: ${(measuredFpRate * 100).toFixed(6)}%)`);

  // Under the old 32-bit collision ceiling, 250,000 items had a hard floor of n / 2^32 ≈ 0.0058%
  // With 64-bit independent hashing, the false positive rate matches theoretical Bloom (virtually 0 for 250k in 1M capacity)
  assert(measuredFpRate < 0.00005, `False positive rate ${measuredFpRate} should be well below 0.005% floor`);

  console.log('>>> [TEST] All Bloom Filter precision tests passed successfully!');
}

runBloomPrecisionTests().catch((err) => {
  console.error('>>> [TEST FAILED]:', err);
  process.exit(1);
});

