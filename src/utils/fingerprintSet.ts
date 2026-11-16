/**
 * @file fingerprintSet.ts
 * @description Compact, sorted 64-bit fingerprint table for high-performance domain matching.
 *
 * Characteristics:
 * - Exactly 8 bytes of storage per domain (versus fixed Bloom allocation).
 * - 2M domains take ~15.26 MiB RAM & disk (11 chunks of <= 1.5 MiB).
 * - False positive probability: ~1e-13 for 2M entries (64-bit hash collision floor).
 * - Binary search lookup (~277 ns) accelerated by an 18-bit index (~111 ns for 2M domains).
 * - Asynchronous chunked sorting (128K items per slice) to prevent event-loop blocking.
 */

export const FILTER_CHUNK_SIZE = 1.5 * 1024 * 1024; // 1,572,864 bytes (D1 / SQLite chunk limit)

// Binary format header: ASCII 'FPRT' (0x54525046 in little-endian)
export const FPRT_MAGIC = 0x54525046;
export const FPRT_HEADER_SIZE = 16;
export const FPRT_VERSION = 1;

const CHUNK_SIZE = 128 * 1024; // 128K elements per sorting slice (~1 MiB)
const INITIAL_BLOCK_SIZE = 4096; // 4K elements for small initial allocation (~32 KB)

/** 64-bit FNV-1a & Murmur mixer constants */
const FNV_PRIME_1 = 16777619;
const FNV_SEED_1 = 2166136261;
const HASH_PRIME_2 = 2246822519; // 0x85ebca6b
const HASH_SEED_2 = 2654435769;  // 0x9e3779b9

/** Precomputed "||" (ASCII 124, 124) Hash 1 seed */
const SEED_PIPE_1 = (() => {
  let h = FNV_SEED_1;
  h = Math.imul(h ^ 124, FNV_PRIME_1);
  h = Math.imul(h ^ 124, FNV_PRIME_1);
  return h >>> 0;
})();

/** Precomputed "||" Hash 2 seed */
const SEED_PIPE_2 = (() => {
  let h = HASH_SEED_2;
  h = Math.imul(h ^ 124, HASH_PRIME_2);
  h = Math.imul(h ^ 124, HASH_PRIME_2);
  return h >>> 0;
})();

/**
 * Computes a high-entropy 64-bit fingerprint for a domain string.
 * Uses 32-bit integer arithmetic in V8 inner loop for maximum performance.
 */
export function hashDomain(domain: string): bigint {
  let h1 = FNV_SEED_1;
  let h2 = HASH_SEED_2;
  const len = domain.length;
  for (let i = 0; i < len; i++) {
    const c = domain.charCodeAt(i);
    h1 = Math.imul(h1 ^ (c & 0xff), FNV_PRIME_1);
    h2 = Math.imul(h2 ^ ((c >>> 8) ^ (c & 0xff)), HASH_PRIME_2);
  }
  h1 = h1 >>> 0;
  let h2_mixed = h2 ^ (h2 >>> 16);
  h2_mixed = Math.imul(h2_mixed, HASH_PRIME_2);
  h2_mixed = (h2_mixed ^ (h2_mixed >>> 13)) >>> 0;

  return (BigInt(h1) << 32n) | BigInt(h2_mixed);
}

/**
 * Computes 64-bit fingerprint with pre-hashed "||" prefix without string allocation.
 */
export function hashDomainWithPipePipe(domain: string): bigint {
  let h1 = SEED_PIPE_1;
  let h2 = SEED_PIPE_2;
  const len = domain.length;
  for (let i = 0; i < len; i++) {
    const c = domain.charCodeAt(i);
    h1 = Math.imul(h1 ^ (c & 0xff), FNV_PRIME_1);
    h2 = Math.imul(h2 ^ ((c >>> 8) ^ (c & 0xff)), HASH_PRIME_2);
  }
  h1 = h1 >>> 0;
  let h2_mixed = h2 ^ (h2 >>> 16);
  h2_mixed = Math.imul(h2_mixed, HASH_PRIME_2);
  h2_mixed = (h2_mixed ^ (h2_mixed >>> 13)) >>> 0;

  return (BigInt(h1) << 32n) | BigInt(h2_mixed);
}

/**
 * Yield control to the event loop.
 */
function yieldLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * FingerprintSet represents an immutable, sorted 64-bit table of domain fingerprints.
 */
export class FingerprintSet {
  private readonly data: BigUint64Array;
  private readonly length: number;
  private indexTable?: Uint32Array;
  private indexBits: number = 0;

  constructor(data: BigUint64Array) {
    this.data = data;
    this.length = data.length;
    this.buildIndex();
  }

  /**
   * Number of domain fingerprints in this set.
   */
  get size(): number {
    return this.length;
  }

  /**
   * Approximate memory footprint in bytes.
   */
  get byteLength(): number {
    return this.data.byteLength + (this.indexTable ? this.indexTable.byteLength : 0);
  }

  /**
   * Direct access to underlying BigUint64Array.
   */
  get rawArray(): BigUint64Array {
    return this.data;
  }

  /**
   * Checks whether the set is empty.
   */
  isEmpty(): boolean {
    return this.length === 0;
  }

  /**
   * Returns a truncated copy containing at most maxCount items.
   *
   * NOTE: Because fingerprints are stored in ascending sorted 64-bit hash order,
   * truncating via slice(0, maxCount) discards domain hashes above the cutoff.
   * Since the 64-bit hash function uniformly distributes domain names across the
   * integer space, this acts as an unbiased pseudo-random uniform sample across
   * all domains, rather than prioritizing or dropping by list source or alphabetical name.
   */
  truncate(maxCount: number): FingerprintSet {
    if (this.length <= maxCount) return this;
    return new FingerprintSet(this.data.slice(0, maxCount));
  }

  /**
   * Builds an in-memory prefix index for fast binary search range clamping.
   * Target ~4 to 8 entries per bucket for N >= 64K.
   */
  private buildIndex(): void {
    const n = this.length;
    if (n < 65536) {
      return; // List small enough, standard binary search is already fast (< 50 ns)
    }

    // Target ~4 entries per bucket: bits = clamp(floor(log2(n / 4)), 10, 18)
    const targetBuckets = Math.floor(n / 4);
    let bits = 0;
    while ((1 << (bits + 1)) <= targetBuckets && bits < 18) {
      bits++;
    }
    if (bits < 10) return;

    this.indexBits = bits;
    const bucketCount = 1 << bits;
    const shift = BigInt(64 - bits);
    const table = new Uint32Array(bucketCount + 1);

    const arr = this.data;
    let currBucket = 0;
    table[0] = 0;

    for (let i = 0; i < n; i++) {
      const b = Number(arr[i] >> shift);
      while (currBucket < b) {
        currBucket++;
        table[currBucket] = i;
      }
    }
    // Bug fix: only fill buckets strictly past currBucket with n
    for (let k = currBucket + 1; k <= bucketCount; k++) {
      table[k] = n;
    }

    this.indexTable = table;
  }

  /**
   * Test whether a domain fingerprint is present.
   */
  hasHash(fp: bigint): boolean {
    const len = this.length;
    if (len === 0) return false;

    let low = 0;
    let high = len - 1;

    if (this.indexTable && this.indexBits > 0) {
      const b = Number(fp >> BigInt(64 - this.indexBits));
      low = this.indexTable[b];
      high = this.indexTable[b + 1] - 1;
      if (low > high) return false;
    }

    const arr = this.data;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const val = arr[mid];
      if (val === fp) {
        return true;
      } else if (val < fp) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return false;
  }

  /**
   * Test exact domain.
   */
  test(domain: string): boolean {
    return this.hasHash(hashDomain(domain));
  }

  /**
   * Test "||" prefixed domain.
   */
  testPipePipe(domain: string): boolean {
    return this.hasHash(hashDomainWithPipePipe(domain));
  }

  /**
   * Serializes the sorted fingerprint set to Uint8Array.
   */
  toUint8Array(): Uint8Array {
    const n = this.length;
    const payloadBytes = n * 8;
    const out = new Uint8Array(FPRT_HEADER_SIZE + payloadBytes);
    const view = new DataView(out.buffer, out.byteOffset, FPRT_HEADER_SIZE);

    view.setUint32(0, FPRT_MAGIC, true);
    view.setUint8(4, FPRT_VERSION);
    view.setUint8(5, 0); // flags
    view.setUint16(6, 0, true); // reserved
    view.setUint32(8, n, true); // count
    view.setUint32(12, 0, true); // reserved

    new Uint8Array(out.buffer, out.byteOffset + FPRT_HEADER_SIZE, payloadBytes).set(
      new Uint8Array(this.data.buffer, this.data.byteOffset, payloadBytes)
    );

    return out;
  }

  /**
   * Deserializes a FingerprintSet from binary buffer.
   */
  static fromUint8Array(buffer: Uint8Array | ArrayBuffer): FingerprintSet {
    const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (buf.byteLength < FPRT_HEADER_SIZE) {
      throw new Error("Invalid fingerprint buffer: header too short");
    }

    const view = new DataView(buf.buffer, buf.byteOffset, FPRT_HEADER_SIZE);
    const magic = view.getUint32(0, true);
    if (magic !== FPRT_MAGIC) {
      throw new Error(`Invalid fingerprint magic header: 0x${magic.toString(16)}`);
    }

    const version = view.getUint8(4);
    if (version !== FPRT_VERSION) {
      throw new Error(`Unsupported fingerprint version: ${version}`);
    }

    const count = view.getUint32(8, true);
    const expectedPayload = count * 8;
    if (buf.byteLength < FPRT_HEADER_SIZE + expectedPayload) {
      throw new Error(`Truncated fingerprint buffer: expected ${expectedPayload} bytes, got ${buf.byteLength - FPRT_HEADER_SIZE}`);
    }

    const payloadOffset = buf.byteOffset + FPRT_HEADER_SIZE;
    let data: BigUint64Array;
    if (payloadOffset % 8 === 0) {
      data = new BigUint64Array(buf.buffer, payloadOffset, count);
    } else {
      const copy = new Uint8Array(expectedPayload);
      copy.set(buf.subarray(FPRT_HEADER_SIZE, FPRT_HEADER_SIZE + expectedPayload));
      data = new BigUint64Array(copy.buffer, 0, count);
    }

    return new FingerprintSet(data);
  }

  /**
   * Header check helper without reading entire chunks.
   */
  static isCurrentVersion(buffer: ArrayBuffer | Uint8Array | null | undefined): boolean {
    if (!buffer || buffer.byteLength < FPRT_HEADER_SIZE) return false;
    const view = buffer instanceof Uint8Array
      ? new DataView(buffer.buffer, buffer.byteOffset, FPRT_HEADER_SIZE)
      : new DataView(buffer, 0, Math.min(buffer.byteLength, FPRT_HEADER_SIZE));
    return view.getUint32(0, true) === FPRT_MAGIC && view.getUint8(4) === FPRT_VERSION;
  }

  /**
   * Merges multiple FingerprintSet instances into one sorted, deduplicated FingerprintSet.
   */
  static async mergeSets(sets: FingerprintSet[]): Promise<FingerprintSet> {
    const validSets = sets.filter((s) => s.length > 0);
    if (validSets.length === 0) {
      return new FingerprintSet(new BigUint64Array(0));
    }
    if (validSets.length === 1) {
      return validSets[0];
    }

    let current = validSets[0].data;
    for (let k = 1; k < validSets.length; k++) {
      const next = validSets[k].data;
      current = await mergeTwoSortedBigUint64(current, next);
    }

    return new FingerprintSet(current);
  }
}

/**
 * Merge two sorted BigUint64Array with deduplication and cooperative event loop yielding.
 */
async function mergeTwoSortedBigUint64(a: BigUint64Array, b: BigUint64Array): Promise<BigUint64Array> {
  const lenA = a.length;
  const lenB = b.length;
  const maxMerged = lenA + lenB;
  const out = new BigUint64Array(maxMerged);

  let i = 0;
  let j = 0;
  let outIdx = 0;
  let countSinceYield = 0;

  while (i < lenA && j < lenB) {
    const valA = a[i];
    const valB = b[j];

    let chosen: bigint;
    if (valA === valB) {
      chosen = valA;
      i++;
      j++;
    } else if (valA < valB) {
      chosen = valA;
      i++;
    } else {
      chosen = valB;
      j++;
    }

    if (outIdx === 0 || out[outIdx - 1] !== chosen) {
      out[outIdx++] = chosen;
    }

    if (++countSinceYield >= CHUNK_SIZE) {
      countSinceYield = 0;
      await yieldLoop();
    }
  }

  while (i < lenA) {
    const valA = a[i++];
    if (outIdx === 0 || out[outIdx - 1] !== valA) {
      out[outIdx++] = valA;
    }
    if (++countSinceYield >= CHUNK_SIZE) {
      countSinceYield = 0;
      await yieldLoop();
    }
  }

  while (j < lenB) {
    const valB = b[j++];
    if (outIdx === 0 || out[outIdx - 1] !== valB) {
      out[outIdx++] = valB;
    }
    if (++countSinceYield >= CHUNK_SIZE) {
      countSinceYield = 0;
      await yieldLoop();
    }
  }

  return outIdx === maxMerged ? out : out.slice(0, outIdx);
}

/**
 * Builder for FingerprintSet using lazy, chunked allocation.
 */
export class FingerprintSetBuilder {
  private blocks: BigUint64Array[] = [];
  private currentBlock: BigUint64Array | null = null;
  private currentCapacity: number = 0;
  private currentOffset: number = 0;
  private totalCount: number = 0;

  add(domain: string): void {
    this.addHash(hashDomain(domain));
  }

  addPipePipe(domain: string): void {
    this.addHash(hashDomainWithPipePipe(domain));
  }

  addHash(fp: bigint): void {
    if (!this.currentBlock || this.currentOffset >= this.currentCapacity) {
      if (this.currentBlock) {
        this.blocks.push(this.currentBlock.subarray(0, this.currentOffset));
      }
      // First block starts small (INITIAL_BLOCK_SIZE), subsequent blocks use CHUNK_SIZE
      const nextCap = this.totalCount === 0 ? INITIAL_BLOCK_SIZE : CHUNK_SIZE;
      this.currentBlock = new BigUint64Array(nextCap);
      this.currentCapacity = nextCap;
      this.currentOffset = 0;
    }
    this.currentBlock[this.currentOffset++] = fp;
    this.totalCount++;
  }

  get count(): number {
    return this.totalCount;
  }

  /**
   * Sorts and merges slices, deduplicating elements even if there is only 1 block.
   */
  async build(): Promise<FingerprintSet> {
    if (this.totalCount === 0) {
      return new FingerprintSet(new BigUint64Array(0));
    }

    const allBlocks: BigUint64Array[] = [...this.blocks];
    if (this.currentBlock && this.currentOffset > 0) {
      allBlocks.push(this.currentBlock.subarray(0, this.currentOffset));
    }

    if (allBlocks.length === 1) {
      const block = allBlocks[0];
      block.sort();
      let outIdx = 0;
      for (let i = 0; i < block.length; i++) {
        if (outIdx === 0 || block[i] !== block[outIdx - 1]) {
          block[outIdx++] = block[i];
        }
      }
      const trimmed = block.slice(0, outIdx);
      return new FingerprintSet(trimmed);
    }

    for (let i = 0; i < allBlocks.length; i++) {
      allBlocks[i].sort();
      if (allBlocks.length > 1) {
        await yieldLoop();
      }
    }

    let merged = allBlocks[0];
    for (let i = 1; i < allBlocks.length; i++) {
      merged = await mergeTwoSortedBigUint64(merged, allBlocks[i]);
    }

    return new FingerprintSet(merged);
  }
}
