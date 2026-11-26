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
 * - Dedupe and prefix-index construction run slice by slice (FILTER_YIELD_CHUNK_ITEMS / FILTER_YIELD_SLEEP_MS)
 *   and read the 64-bit values through a Uint32 view instead of BigInt, so a list with millions of entries
 *   never blocks the event loop for more than one slice (the native sort() call stays a single step).
 *
 * Byte order: entries are stored as (low word, high word) Uint32 pairs, i.e. the table assumes a
 * little-endian host (x86-64, ARM64), exactly like FingerprintSetBuilder.add() always did.
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
 * Tuning for the slice-by-slice passes over large fingerprint tables (dedupe, index build).
 * Each pass handles `chunkItems` entries, then pauses `sleepMs` so pending DNS I/O can run.
 */
export interface FilterYieldTuning {
  /** Entries processed between two pauses. */
  chunkItems: number;
  /** Pause between two slices in milliseconds. */
  sleepMs: number;
}

export const DEFAULT_FILTER_YIELD_CHUNK_ITEMS = 131072;
export const DEFAULT_FILTER_YIELD_SLEEP_MS = 1;
const MIN_FILTER_YIELD_CHUNK_ITEMS = 4096;
const MAX_FILTER_YIELD_SLEEP_MS = 1000;

function readTunable(env: any, key: string): number | undefined {
  const raw = env?.[key] ?? (typeof process !== 'undefined' ? process.env?.[key] : undefined);
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Reads FILTER_YIELD_CHUNK_ITEMS / FILTER_YIELD_SLEEP_MS from `env` (or process.env when absent),
 * falling back to the defaults for missing or invalid values.
 */
export function getFilterYieldTuning(env?: any): FilterYieldTuning {
  const chunk = readTunable(env, 'FILTER_YIELD_CHUNK_ITEMS');
  const sleep = readTunable(env, 'FILTER_YIELD_SLEEP_MS');
  return {
    chunkItems: chunk !== undefined ? Math.max(MIN_FILTER_YIELD_CHUNK_ITEMS, Math.floor(chunk)) : DEFAULT_FILTER_YIELD_CHUNK_ITEMS,
    sleepMs: sleep !== undefined && sleep >= 0 ? Math.min(MAX_FILTER_YIELD_SLEEP_MS, Math.floor(sleep)) : DEFAULT_FILTER_YIELD_SLEEP_MS
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Prefix-index bit count for `n` entries, or 0 when no index is worth building. */
function indexBitsFor(n: number): number {
  if (n < 65536) return 0; // standard binary search is already fast (< 50 ns)
  // Target ~4 entries per bucket: bits = clamp(floor(log2(n / 4)), 10, 18)
  const targetBuckets = Math.floor(n / 4);
  let bits = 0;
  while ((1 << (bits + 1)) <= targetBuckets && bits < 18) {
    bits++;
  }
  return bits < 10 ? 0 : bits;
}

interface PrefixIndex {
  table: Uint32Array;
  bits: number;
}

interface IndexScan {
  /** Uint32 view over the sorted table: high word of entry i is words[2 * i + 1]. */
  words: Uint32Array;
  table: Uint32Array;
  bits: number;
  bucketCount: number;
  currBucket: number;
}

function startIndexScan(data: BigUint64Array, bits: number): IndexScan {
  const bucketCount = 1 << bits;
  return {
    words: new Uint32Array(data.buffer, data.byteOffset, data.length * 2),
    table: new Uint32Array(bucketCount + 1),
    bits,
    bucketCount,
    currBucket: 0
  };
}

/** Scans entries [start, end) of the sorted table and records the first position of each prefix bucket. */
function scanIndexSlice(scan: IndexScan, start: number, end: number): void {
  const { table, words } = scan;
  const shift = 32 - scan.bits; // top `bits` bits of the 64-bit value = high word >>> (32 - bits)
  let curr = scan.currBucket;
  for (let i = start; i < end; i++) {
    const b = words[2 * i + 1] >>> shift;
    while (curr < b) {
      curr++;
      table[curr] = i;
    }
  }
  scan.currBucket = curr;
}

function finishIndexScan(scan: IndexScan, n: number): PrefixIndex {
  // Only fill buckets strictly past currBucket with n
  for (let k = scan.currBucket + 1; k <= scan.bucketCount; k++) {
    scan.table[k] = n;
  }
  return { table: scan.table, bits: scan.bits };
}

/** Builds the prefix index in one go (small tables, legacy synchronous callers). */
function computeIndex(data: BigUint64Array): PrefixIndex | null {
  const n = data.length;
  const bits = indexBitsFor(n);
  if (!bits) return null;
  const scan = startIndexScan(data, bits);
  scanIndexSlice(scan, 0, n);
  return finishIndexScan(scan, n);
}

/** Builds the prefix index slice by slice, pausing between slices so DNS queries keep flowing. */
async function computeIndexAsync(data: BigUint64Array, tuning: FilterYieldTuning): Promise<PrefixIndex | null> {
  const n = data.length;
  const bits = indexBitsFor(n);
  if (!bits) return null;
  const scan = startIndexScan(data, bits);
  const chunk = Math.max(1, tuning.chunkItems);
  for (let start = 0; start < n; start += chunk) {
    const end = Math.min(n, start + chunk);
    scanIndexSlice(scan, start, end);
    if (end < n) await pause(tuning.sleepMs);
  }
  return finishIndexScan(scan, n);
}

/**
 * In-place dedupe of entries [start, end) of a sorted table viewed as Uint32 pairs (lo, hi).
 * `w` is the number of unique entries kept so far; returns the updated count.
 * Comparing the two words avoids reading each element as a BigInt.
 */
function dedupeSortedSlice(words: Uint32Array, start: number, end: number, w: number): number {
  for (let i = start; i < end; i++) {
    const lo = words[2 * i];
    const hi = words[2 * i + 1];
    if (w === 0 || lo !== words[2 * w - 2] || hi !== words[2 * w - 1]) {
      words[2 * w] = lo;
      words[2 * w + 1] = hi;
      w++;
    }
  }
  return w;
}

/**
 * FingerprintSet represents an immutable, sorted 64-bit table of domain fingerprints.
 */
export class FingerprintSet {
  private readonly data: BigUint64Array;
  private readonly length: number;
  private indexTable?: Uint32Array;
  private indexBits: number = 0;

  /**
   * @param data Sorted, deduplicated fingerprints.
   * @param prebuiltIndex Index computed by FingerprintSet.create(); when omitted it is built here synchronously.
   */
  constructor(data: BigUint64Array, prebuiltIndex?: PrefixIndex | null) {
    this.data = data;
    this.length = data.length;
    if (prebuiltIndex) {
      this.indexTable = prebuiltIndex.table;
      this.indexBits = prebuiltIndex.bits;
    } else {
      this.buildIndex();
    }
  }

  /**
   * Creates a set and builds its prefix index slice by slice (see FilterYieldTuning), so a table with
   * millions of entries never blocks the event loop for more than one slice.
   * Same result as `new FingerprintSet(data)`.
   */
  static async create(data: BigUint64Array, tuning: FilterYieldTuning = getFilterYieldTuning()): Promise<FingerprintSet> {
    const index = await computeIndexAsync(data, tuning);
    return new FingerprintSet(data, index);
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
   * Builds an in-memory prefix index for fast binary search range clamping.
   * Target ~4 to 8 entries per bucket for N >= 64K.
   */
  private buildIndex(): void {
    const index = computeIndex(this.data);
    if (index) {
      this.indexTable = index.table;
      this.indexBits = index.bits;
    }
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
  private static parseBuffer(buffer: Uint8Array | ArrayBuffer): BigUint64Array {
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

    return data;
  }

  static fromUint8Array(buffer: Uint8Array | ArrayBuffer): FingerprintSet {
    return new FingerprintSet(FingerprintSet.parseBuffer(buffer));
  }

  /**
   * Same as fromUint8Array, but the prefix index is built slice by slice (see FilterYieldTuning)
   * so loading a large list does not block the event loop.
   */
  static async fromUint8ArrayAsync(buffer: Uint8Array | ArrayBuffer, tuning: FilterYieldTuning = getFilterYieldTuning()): Promise<FingerprintSet> {
    return FingerprintSet.create(FingerprintSet.parseBuffer(buffer), tuning);
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

    return FingerprintSet.create(current);
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
 * Builder for FingerprintSet using zero-allocation 32-bit streaming blocks.
 */
export class FingerprintSetBuilder {
  private blocks: BigUint64Array[] = [];
  private currentBlock: BigUint64Array | null = null;
  private currentBlock32: Uint32Array | null = null;
  private currentCapacity: number = 0;
  private currentOffset: number = 0;
  private totalCount: number = 0;

  private ensureCapacity(): void {
    if (!this.currentBlock || this.currentOffset >= this.currentCapacity) {
      if (this.currentBlock) {
        this.blocks.push(this.currentBlock.subarray(0, this.currentOffset));
      }
      // First block starts small (INITIAL_BLOCK_SIZE), subsequent blocks use CHUNK_SIZE
      const nextCap = this.totalCount === 0 ? INITIAL_BLOCK_SIZE : CHUNK_SIZE;
      this.currentBlock = new BigUint64Array(nextCap);
      this.currentBlock32 = new Uint32Array(this.currentBlock.buffer, this.currentBlock.byteOffset, nextCap * 2);
      this.currentCapacity = nextCap;
      this.currentOffset = 0;
    }
  }

  add(domain: string): void {
    this.ensureCapacity();
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

    const idx = this.currentOffset * 2;
    this.currentBlock32![idx] = h2_mixed;
    this.currentBlock32![idx + 1] = h1;
    this.currentOffset++;
    this.totalCount++;
  }

  addPipePipe(domain: string): void {
    this.ensureCapacity();
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

    const idx = this.currentOffset * 2;
    this.currentBlock32![idx] = h2_mixed;
    this.currentBlock32![idx + 1] = h1;
    this.currentOffset++;
    this.totalCount++;
  }

  /**
   * Hash domain chars directly from a source string at [start, end) with inline lowercasing.
   * Avoids creating an intermediate domain string — used by the sync fast-path.
   */
  addFromLine(line: string, start: number, end: number): void {
    this.ensureCapacity();
    let h1 = FNV_SEED_1;
    let h2 = HASH_SEED_2;
    for (let i = start; i < end; i++) {
      let c = line.charCodeAt(i);
      // Inline lowercase: A-Z (65-90) → a-z (97-122)
      if (c >= 65 && c <= 90) c += 32;
      h1 = Math.imul(h1 ^ (c & 0xff), FNV_PRIME_1);
      h2 = Math.imul(h2 ^ ((c >>> 8) ^ (c & 0xff)), HASH_PRIME_2);
    }
    h1 = h1 >>> 0;
    let h2_mixed = h2 ^ (h2 >>> 16);
    h2_mixed = Math.imul(h2_mixed, HASH_PRIME_2);
    h2_mixed = (h2_mixed ^ (h2_mixed >>> 13)) >>> 0;
    const idx = this.currentOffset * 2;
    this.currentBlock32![idx] = h2_mixed;
    this.currentBlock32![idx + 1] = h1;
    this.currentOffset++;
    this.totalCount++;
  }

  /**
   * Hash domain chars from [start, end) with pre-computed "||" prefix seed and inline lowercasing.
   * Avoids creating an intermediate domain string — used by the sync fast-path.
   */
  addPipePipeFromLine(line: string, start: number, end: number): void {
    this.ensureCapacity();
    let h1 = SEED_PIPE_1;
    let h2 = SEED_PIPE_2;
    for (let i = start; i < end; i++) {
      let c = line.charCodeAt(i);
      if (c >= 65 && c <= 90) c += 32;
      h1 = Math.imul(h1 ^ (c & 0xff), FNV_PRIME_1);
      h2 = Math.imul(h2 ^ ((c >>> 8) ^ (c & 0xff)), HASH_PRIME_2);
    }
    h1 = h1 >>> 0;
    let h2_mixed = h2 ^ (h2 >>> 16);
    h2_mixed = Math.imul(h2_mixed, HASH_PRIME_2);
    h2_mixed = (h2_mixed ^ (h2_mixed >>> 13)) >>> 0;
    const idx = this.currentOffset * 2;
    this.currentBlock32![idx] = h2_mixed;
    this.currentBlock32![idx + 1] = h1;
    this.currentOffset++;
    this.totalCount++;
  }

  get count(): number {
    return this.totalCount;
  }

  clear(): void {
    this.blocks = [];
    this.currentBlock = null;
    this.currentBlock32 = null;
    this.currentCapacity = 0;
    this.currentOffset = 0;
    this.totalCount = 0;
  }

  /**
   * Assembles, sorts and deduplicates elements into a single FingerprintSet.
   */
  async build(tuning: FilterYieldTuning = getFilterYieldTuning()): Promise<FingerprintSet> {
    if (this.totalCount === 0) {
      return new FingerprintSet(new BigUint64Array(0));
    }

    const allBlocks: BigUint64Array[] = [...this.blocks];
    if (this.currentBlock && this.currentOffset > 0) {
      allBlocks.push(this.currentBlock.subarray(0, this.currentOffset));
    }
    this.currentBlock = null;
    this.currentBlock32 = null;
    this.blocks = [];

    // Single block fast path (tiny list, one slice is enough)
    if (allBlocks.length === 1) {
      const block = allBlocks[0];
      block.sort();
      const unique = dedupeSortedSlice(new Uint32Array(block.buffer, block.byteOffset, block.length * 2), 0, block.length, 0);
      return new FingerprintSet(unique === block.length ? block : block.subarray(0, unique));
    }

    // Allocate single contiguous destination array for all blocks
    const full = new BigUint64Array(this.totalCount);
    let offset = 0;
    for (const b of allBlocks) {
      full.set(b, offset);
      offset += b.length;
    }
    allBlocks.length = 0;

    await yieldLoop();

    // Fast in-place native sort (one call, cannot be sliced)
    full.sort();

    await yieldLoop();

    // Deduplicate in place, slice by slice, comparing the two 32-bit words instead of BigInt values
    const words = new Uint32Array(full.buffer, full.byteOffset, full.length * 2);
    const total = full.length;
    const chunk = Math.max(1, tuning.chunkItems);
    let unique = 0;
    for (let start = 0; start < total; start += chunk) {
      const end = Math.min(total, start + chunk);
      unique = dedupeSortedSlice(words, start, end, unique);
      if (end < total) await pause(tuning.sleepMs);
    }

    const finalData = unique === total ? full : full.subarray(0, unique);
    // The prefix index is built slice by slice as well
    return FingerprintSet.create(finalData, tuning);
  }
}
