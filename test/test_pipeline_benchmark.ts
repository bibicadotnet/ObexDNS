/**
 * @file test_pipeline_benchmark.ts
 * @description Benchmark comparing the CURRENT parsing pipeline (parseAdGuardLine →
 * ParsedAdGuardRule object → builder.add) versus a DIRECT approach that inlines
 * parsing and hashing with zero intermediate object/string allocation.
 *
 * Run with:  npx tsx --expose-gc test/test_pipeline_benchmark.ts
 */

import { parseAdGuardLine } from '../src/lib/adguard/parser';
import { AdGuardRuleKind } from '../src/lib/adguard/types';
import { FingerprintSetBuilder } from '../src/utils/fingerprintSet';

// ---------------------------------------------------------------------------
// Hash constants (replicated from src/utils/fingerprintSet.ts — not exported)
// ---------------------------------------------------------------------------
const FNV_PRIME_1 = 16777619;
const FNV_SEED_1 = 2166136261;
const HASH_PRIME_2 = 2246822519;
const HASH_SEED_2 = 2654435769;

/** Precomputed "||" (ASCII 124, 124) Hash-1 seed — mirrors SEED_PIPE_1 */
const SEED_PIPE_1 = (() => {
  let h = FNV_SEED_1;
  h = Math.imul(h ^ 124, FNV_PRIME_1);
  h = Math.imul(h ^ 124, FNV_PRIME_1);
  return h >>> 0;
})();

/** Precomputed "||" Hash-2 seed — mirrors SEED_PIPE_2 */
const SEED_PIPE_2 = (() => {
  let h = HASH_SEED_2;
  h = Math.imul(h ^ 124, HASH_PRIME_2);
  h = Math.imul(h ^ 124, HASH_PRIME_2);
  return h >>> 0;
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mem(): string {
  const m = process.memoryUsage();
  return `heap=${(m.heapUsed / 1024 / 1024).toFixed(1)}MB  ext=${(m.external / 1024 / 1024).toFixed(1)}MB  RSS=${(m.rss / 1024 / 1024).toFixed(1)}MB`;
}

function gc(): void {
  if (typeof global.gc === 'function') global.gc();
}

/** Generate 1M realistic AdGuard-format lines. */
function generateLines(n: number): string[] {
  const lines: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = i % 10;
    if (r < 6) {
      lines[i] = `||ads-${i}.example.com^`;   // 60% wildcard block  (||domain^)
    } else if (r < 8) {
      lines[i] = `tracker-${i}.cdn.net`;       // 20% exact block     (plain domain)
    } else if (r < 9) {
      lines[i] = `@@||whitelist-${i}.com^`;     // 10% exception       (skip)
    } else {
      lines[i] = `! Comment line ${i}`;          // 10% comment         (skip)
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Phase A: CURRENT approach — parseAdGuardLine → object → builder.add
// ---------------------------------------------------------------------------
async function phaseA(lines: string[]): Promise<number> {
  const builder = new FingerprintSetBuilder();
  let count = 0;

  for (const line of lines) {
    const rule = parseAdGuardLine(line);
    if (rule && rule.kind === AdGuardRuleKind.BLOOM_DOMAIN && rule.domain) {
      if (rule.includeSubdomains) {
        builder.addPipePipe(rule.domain);
      } else {
        builder.add(rule.domain);
      }
      count++;
    }
  }

  // build() to get a fair end-to-end picture (sort + dedup), same as production
  await builder.build();
  return count;
}

// ---------------------------------------------------------------------------
// Phase B: DIRECT approach — inline parse + inline hash, no object, no substring
//
// Instead of calling parseAdGuardLine (which allocates a ParsedAdGuardRule
// object and a domain substring), we scan the raw line's char codes directly
// and feed them into the same FNV/Murmur hash loop.  Fingerprints are written
// straight into a pre-allocated BigUint64Array via a Uint32 view, mirroring
// what FingerprintSetBuilder does internally but with zero intermediate
// objects or strings.
// ---------------------------------------------------------------------------
function phaseB(lines: string[], fps: BigUint64Array, fps32: Uint32Array): number {
  let outIdx = 0;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    // Quick reject: comments ('!' 33 or '#' 35) and exceptions ('@@')
    const first = line.charCodeAt(0);
    if (first === 33 || first === 35) continue;          // '!' or '#'
    if (first === 64 && line.charCodeAt(1) === 64) continue; // '@@'

    let start: number;
    let end: number;
    let pipePipe: boolean;

    if (first === 124 && line.charCodeAt(1) === 124) {    // '||'
      pipePipe = true;
      start = 2;
      // Find '^' or end of line
      let e = line.length;
      for (let j = 2; j < line.length; j++) {
        if (line.charCodeAt(j) === 94) { e = j; break; }   // '^'
      }
      end = e;
    } else {
      pipePipe = false;
      start = 0;
      // Strip '$' modifiers if present
      let e = line.length;
      for (let j = 0; j < line.length; j++) {
        if (line.charCodeAt(j) === 36) { e = j; break; }  // '$'
      }
      end = e;
    }

    if (end <= start) continue;

    // --- Inline hash over chars [start, end) of the original line ---
    let h1: number;
    let h2: number;

    if (pipePipe) {
      h1 = SEED_PIPE_1;
      h2 = SEED_PIPE_2;
    } else {
      h1 = FNV_SEED_1;
      h2 = HASH_SEED_2;
    }

    for (let i = start; i < end; i++) {
      const c = line.charCodeAt(i);
      h1 = Math.imul(h1 ^ (c & 0xff), FNV_PRIME_1);
      h2 = Math.imul(h2 ^ ((c >>> 8) ^ (c & 0xff)), HASH_PRIME_2);
    }
    h1 = h1 >>> 0;
    let h2_mixed = h2 ^ (h2 >>> 16);
    h2_mixed = Math.imul(h2_mixed, HASH_PRIME_2);
    h2_mixed = (h2_mixed ^ (h2_mixed >>> 13)) >>> 0;

    // Store: h2 in low 32 bits, h1 in high 32 bits (same layout as builder)
    const idx = outIdx * 2;
    fps32[idx] = h2_mixed;
    fps32[idx + 1] = h1;
    outIdx++;
  }

  return outIdx;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const N = 1_000_000;
  console.log('=== Pipeline Benchmark: parse+object+hash  vs  direct inline hash ===\n');

  gc();
  console.log(`Baseline:            ${mem()}`);

  const lines = generateLines(N);
  console.log(`After generate lines: ${mem()}`);

  // ---- Phase A ----------------------------------------------------------
  gc();
  const memBeforeA = process.memoryUsage();
  const cpuBeforeA = process.cpuUsage();
  const t0A = Date.now();

  const countA = await phaseA(lines);

  const t1A = Date.now();
  const cpuAfterA = process.cpuUsage(cpuBeforeA);
  const memAfterA = process.memoryUsage();

  console.log(`\n--- Phase A (parseAdGuardLine → object → builder.add) ---`);
  console.log(`After Phase A:       ${mem()}`);
  console.log(`  domains hashed: ${countA}`);
  console.log(`  wall time:  ${t1A - t0A}ms`);
  console.log(`  CPU user:  ${(cpuAfterA.user / 1000).toFixed(0)}ms`);
  console.log(`  CPU sys:   ${(cpuAfterA.system / 1000).toFixed(0)}ms`);
  console.log(`  heap delta: ${((memAfterA.heapUsed - memBeforeA.heapUsed) / 1024 / 1024).toFixed(1)}MB`);
  console.log(`  ext delta:  ${((memAfterA.external - memBeforeA.external) / 1024 / 1024).toFixed(1)}MB`);
  console.log(`  RSS delta:  ${((memAfterA.rss - memBeforeA.rss) / 1024 / 1024).toFixed(1)}MB`);

  // Clear and GC between phases
  gc();
  console.log(`After GC:            ${mem()}`);

  // ---- Phase B ----------------------------------------------------------
  // Pre-allocate destination arrays (what an optimised direct pipeline would do)
  const fps = new BigUint64Array(N);
  const fps32 = new Uint32Array(fps.buffer);

  gc();
  const memBeforeB = process.memoryUsage();
  const cpuBeforeB = process.cpuUsage();
  const t0B = Date.now();

  const countB = phaseB(lines, fps, fps32);

  const t1B = Date.now();
  const cpuAfterB = process.cpuUsage(cpuBeforeB);
  const memAfterB = process.memoryUsage();

  console.log(`\n--- Phase B (direct inline hash, no object, no string) ---`);
  console.log(`After Phase B:       ${mem()}`);
  console.log(`  domains hashed: ${countB}`);
  console.log(`  wall time:  ${t1B - t0B}ms`);
  console.log(`  CPU user:  ${(cpuAfterB.user / 1000).toFixed(0)}ms`);
  console.log(`  CPU sys:   ${(cpuAfterB.system / 1000).toFixed(0)}ms`);
  console.log(`  heap delta: ${((memAfterB.heapUsed - memBeforeB.heapUsed) / 1024 / 1024).toFixed(1)}MB`);
  console.log(`  ext delta:  ${((memAfterB.external - memBeforeB.external) / 1024 / 1024).toFixed(1)}MB`);
  console.log(`  RSS delta:  ${((memAfterB.rss - memBeforeB.rss) / 1024 / 1024).toFixed(1)}MB`);

  gc();
  console.log(`After GC:            ${mem()}`);

  // ---- Comparison -------------------------------------------------------
  console.log('\n=== Comparison ===');
  console.log(`Phase A wall: ${t1A - t0A}ms  CPU: ${(cpuAfterA.user / 1000).toFixed(0)}ms  heap+${((memAfterA.heapUsed - memBeforeA.heapUsed) / 1024 / 1024).toFixed(1)}MB`);
  console.log(`Phase B wall: ${t1B - t0B}ms  CPU: ${(cpuAfterB.user / 1000).toFixed(0)}ms  heap+${((memAfterB.heapUsed - memBeforeB.heapUsed) / 1024 / 1024).toFixed(1)}MB`);
  const speedup = (t1B - t0B) > 0 ? ((t1A - t0A) / (t1B - t0B)).toFixed(2) : 'inf';
  console.log(`Speedup:     ${speedup}x`);
  console.log(`Heap saving: ${(((memAfterA.heapUsed - memBeforeA.heapUsed) - (memAfterB.heapUsed - memBeforeB.heapUsed)) / 1024 / 1024).toFixed(1)}MB`);
}

main().catch(console.error);
