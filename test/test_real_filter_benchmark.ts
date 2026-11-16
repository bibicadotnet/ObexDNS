/**
 * @file test_real_filter_benchmark.ts
 * @description Benchmark comparing the CURRENT parsing pipeline (parseAdGuardLine →
 * ParsedAdGuardRule object → builder.add) versus a DIRECT inline approach on a REAL
 * blocklist (hagezi TIF — The Inline Filter).
 *
 * Downloads the list, runs both phases, and reports rule type breakdown, wall time,
 * CPU user/sys, heap/external/RSS deltas, speedup, heap saving, and count match.
 *
 * Phase A (current):  parseAdGuardLine → object → builder.add/addPipePipe → build()
 * Phase B (direct):   scan char codes directly, inline lowercasing + hashing, store
 *                     into a pre-allocated BigUint64Array via a Uint32Array view, with
 *                     a parseAdGuardLine fallback for anything not on a fast path.
 *
 * Run with:  npx tsx --expose-gc test/test_real_filter_benchmark.ts
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

const RULE_KIND_NAMES: Record<number, string> = {
  [AdGuardRuleKind.BLOOM_DOMAIN]: 'BLOOM_DOMAIN',
  [AdGuardRuleKind.EXCEPTION]: 'EXCEPTION',
  [AdGuardRuleKind.DNS_REWRITE]: 'DNS_REWRITE',
  [AdGuardRuleKind.COMPLEX_PATTERN]: 'COMPLEX_PATTERN',
  [AdGuardRuleKind.COMMENT]: 'COMMENT',
  [AdGuardRuleKind.UNSUPPORTED]: 'UNSUPPORTED',
};

/**
 * Finalize the two 32-bit hash accumulators and write one 64-bit fingerprint into the
 * pre-allocated Uint32 view. Layout matches FingerprintSetBuilder internals:
 * low32 = h2_mixed, high32 = h1. Returns the next write index.
 */
function storeFp(h1: number, h2: number, fps32: Uint32Array, outIdx: number): number {
  h1 = h1 >>> 0;
  let h2_mixed = h2 ^ (h2 >>> 16);
  h2_mixed = Math.imul(h2_mixed, HASH_PRIME_2);
  h2_mixed = (h2_mixed ^ (h2_mixed >>> 13)) >>> 0;
  const idx = outIdx * 2;
  fps32[idx] = h2_mixed;     // low 32 bits
  fps32[idx + 1] = h1;        // high 32 bits
  return outIdx + 1;
}

/**
 * Hash an already-lowercased domain string (as returned by parseAdGuardLine) with the
 * given pipe-pipe flag and store the fingerprint. Used for fallback lines.
 */
function hashDomainStore(domain: string, pipePipe: boolean, fps32: Uint32Array, outIdx: number): number {
  let h1 = pipePipe ? SEED_PIPE_1 : FNV_SEED_1;
  let h2 = pipePipe ? SEED_PIPE_2 : HASH_SEED_2;
  for (let i = 0; i < domain.length; i++) {
    const c = domain.charCodeAt(i);
    h1 = Math.imul(h1 ^ (c & 0xff), FNV_PRIME_1);
    h2 = Math.imul(h2 ^ ((c >>> 8) ^ (c & 0xff)), HASH_PRIME_2);
  }
  return storeFp(h1, h2, fps32, outIdx);
}

/** Returns true if any char in line[start..] is $ (36), * (42), # (35), or / (47). */
function hasSpecialChar(line: string, start: number): boolean {
  const len = line.length;
  for (let j = start; j < len; j++) {
    const c = line.charCodeAt(j);
    if (c === 36 || c === 42 || c === 35 || c === 47) return true;
  }
  return false;
}

/** Inline IPv4/IPv6 check for chars [start, end) of line. Mirrors parser isIpAddress. */
function isIpInline(line: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (line.charCodeAt(i) === 58) return true; // ':' → IPv6
  }
  const len = end - start;
  if (len < 7 || len > 15) return false;
  let dots = 0;
  for (let i = start; i < end; i++) {
    const c = line.charCodeAt(i);
    if (c === 46) dots++;
    else if (c < 48 || c > 57) return false;
  }
  return dots === 3;
}

/** Case-insensitive check if [start, end) matches "localhost", "0.0.0.0", or "127.0.0.1". */
function isExcludedHost(line: string, start: number, end: number): boolean {
  const len = end - start;
  const lc = (i: number) => {
    const c = line.charCodeAt(start + i);
    return c >= 65 && c <= 90 ? c + 32 : c;
  };
  if (len === 9) {
    // "localhost": 108 111 99 97 108 104 111 115 116
    if (lc(0) === 108 && lc(1) === 111 && lc(2) === 99 && lc(3) === 97 && lc(4) === 108 &&
        lc(5) === 104 && lc(6) === 111 && lc(7) === 115 && lc(8) === 116) return true;
    // "127.0.0.1": 49 50 55 46 48 46 48 46 49
    if (lc(0) === 49 && lc(1) === 50 && lc(2) === 55 && lc(3) === 46 && lc(4) === 48 &&
        lc(5) === 46 && lc(6) === 48 && lc(7) === 46 && lc(8) === 49) return true;
  } else if (len === 7) {
    // "0.0.0.0": 48 46 48 46 48 46 48
    if (lc(0) === 48 && lc(1) === 46 && lc(2) === 48 && lc(3) === 46 &&
        lc(4) === 48 && lc(5) === 46 && lc(6) === 48) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Phase A: CURRENT approach — parseAdGuardLine → object → builder.add → build
// ---------------------------------------------------------------------------
async function phaseA(lines: string[]) {
  const builder = new FingerprintSetBuilder();
  let count = 0;
  const breakdown: Record<number, number> = {};

  for (const line of lines) {
    const rule = parseAdGuardLine(line);
    if (rule) {
      breakdown[rule.kind] = (breakdown[rule.kind] || 0) + 1;
      if (rule.kind === AdGuardRuleKind.BLOOM_DOMAIN && rule.domain) {
        if (rule.includeSubdomains) builder.addPipePipe(rule.domain);
        else builder.add(rule.domain);
        count++;
      }
    }
  }
  await builder.build();
  return { count, breakdown };
}

// ---------------------------------------------------------------------------
// Phase B: DIRECT approach — inline parse + inline hash, no object, no string
//
// For each line we scan the raw char codes directly and feed them into the same
// FNV/Murmur hash loop with inline lowercasing (A-Z → a-z). Fingerprints are
// written straight into a pre-allocated BigUint64Array via a Uint32 view.
//
// Fast paths:
//   ||domain^  (no $ * # /)  →  hash [2..^end) with pipe prefix
//   plain domain (no $ * # /) →  hash [0..end)
//   hosts (digit + space, valid IP) →  hash parts[1] (after space), no pipe
// Everything else falls back to parseAdGuardLine.
// ---------------------------------------------------------------------------
function phaseB(lines: string[], fps32: Uint32Array) {
  let outIdx = 0;
  let fallbacks = 0;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const len = line.length;
    if (len === 0) continue;

    const first = line.charCodeAt(0);

    // --- Skip comments (!, #, [), exceptions (@@), regex (/) ---
    if (first === 33 || first === 35 || first === 91) continue;          // '!' '#' '['
    if (first === 64 && line.charCodeAt(1) === 64) continue;             // '@@'
    if (first === 47) continue;                                          // '/' regex

    // --- Pipe-prefixed rules ---
    if (first === 124) {                                                 // '|'
      if (line.charCodeAt(1) === 124) {
        // ||domain^ fast path — check no $ * # / in the rest of the line
        if (hasSpecialChar(line, 2)) {
          // Fallback to parser
          fallbacks++;
          const rule = parseAdGuardLine(line);
          if (rule && rule.kind === AdGuardRuleKind.BLOOM_DOMAIN && rule.domain) {
            outIdx = hashDomainStore(rule.domain, !!rule.includeSubdomains, fps32, outIdx);
          }
          continue;
        }
        // Find end: '^' (94) or '\r' (13) or line end
        let end = len;
        for (let j = 2; j < len; j++) {
          const c = line.charCodeAt(j);
          if (c === 94 || c === 13) { end = j; break; }
        }
        // Trim whitespace [2, end)
        let s = 2;
        while (s < end && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
        let e = end;
        while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
        if (e <= s) continue;

        // Inline hash [s..e) with pipe prefix + lowercasing
        let h1 = SEED_PIPE_1;
        let h2 = SEED_PIPE_2;
        for (let i = s; i < e; i++) {
          let c = line.charCodeAt(i);
          if (c >= 65 && c <= 90) c += 32;                                // A-Z → a-z
          h1 = Math.imul(h1 ^ (c & 0xff), FNV_PRIME_1);
          h2 = Math.imul(h2 ^ ((c >>> 8) ^ (c & 0xff)), HASH_PRIME_2);
        }
        outIdx = storeFp(h1, h2, fps32, outIdx);
      } else {
        // Single '|' → fallback (parser strips the leading pipe)
        fallbacks++;
        const rule = parseAdGuardLine(line);
        if (rule && rule.kind === AdGuardRuleKind.BLOOM_DOMAIN && rule.domain) {
          outIdx = hashDomainStore(rule.domain, !!rule.includeSubdomains, fps32, outIdx);
        }
      }
      continue;
    }

    // --- Hosts format (digit + space) ---
    if (first >= 48 && first <= 57) {                                   // '0'-'9'
      let spaceIdx = -1;
      for (let j = 0; j < len; j++) {
        if (line.charCodeAt(j) === 32) { spaceIdx = j; break; }          // ' '
      }
      if (spaceIdx !== -1 && isIpInline(line, 0, spaceIdx)) {
        // Extract parts[1]: skip whitespace after spaceIdx, up to next whitespace / \r
        let dStart = spaceIdx + 1;
        while (dStart < len && line.charCodeAt(dStart) === 32) dStart++;
        let dEnd = dStart;
        while (dEnd < len && line.charCodeAt(dEnd) !== 32 && line.charCodeAt(dEnd) !== 13) dEnd++;
        if (dEnd > dStart && !isExcludedHost(line, dStart, dEnd)) {
          // Inline hash [dStart..dEnd) lowercase, no pipe
          let h1 = FNV_SEED_1;
          let h2 = HASH_SEED_2;
          for (let i = dStart; i < dEnd; i++) {
            let c = line.charCodeAt(i);
            if (c >= 65 && c <= 90) c += 32;
            h1 = Math.imul(h1 ^ (c & 0xff), FNV_PRIME_1);
            h2 = Math.imul(h2 ^ ((c >>> 8) ^ (c & 0xff)), HASH_PRIME_2);
          }
          outIdx = storeFp(h1, h2, fps32, outIdx);
        }
        continue; // hosts handled (counted or skipped)
      }
      // Not a valid hosts line — fall through to plain domain / fallback
    }

    // --- Plain domain fast path ---
    if (hasSpecialChar(line, 0)) {
      // Fallback to parser
      fallbacks++;
      const rule = parseAdGuardLine(line);
      if (rule && rule.kind === AdGuardRuleKind.BLOOM_DOMAIN && rule.domain) {
        outIdx = hashDomainStore(rule.domain, !!rule.includeSubdomains, fps32, outIdx);
      }
      continue;
    }

    // Plain domain: find '^' (94) or '\r' (13) → end
    let end = len;
    for (let j = 0; j < len; j++) {
      const c = line.charCodeAt(j);
      if (c === 94 || c === 13) { end = j; break; }
    }
    // Trim whitespace [0, end)
    let s = 0;
    while (s < end && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
    let e = end;
    while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
    if (e <= s) continue;

    // Inline hash [s..e) lowercase, no pipe
    let h1 = FNV_SEED_1;
    let h2 = HASH_SEED_2;
    for (let i = s; i < e; i++) {
      let c = line.charCodeAt(i);
      if (c >= 65 && c <= 90) c += 32;
      h1 = Math.imul(h1 ^ (c & 0xff), FNV_PRIME_1);
      h2 = Math.imul(h2 ^ ((c >>> 8) ^ (c & 0xff)), HASH_PRIME_2);
    }
    outIdx = storeFp(h1, h2, fps32, outIdx);
  }

  return { count: outIdx, fallbacks };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const URL = 'https://github.com/hagezi/dns-blocklists/raw/refs/heads/main/adblock/tif.txt';

  console.log('=== Real Filter Benchmark: hagezi TIF (The Inline Filter) ===');
  console.log(`URL: ${URL}\n`);

  console.log('Downloading filter list...');
  const res = await fetch(URL);
  if (!res.ok) {
    console.error(`Download failed: HTTP ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const text = await res.text();
  const lines = text.split('\n');
  const totalBytes = Buffer.byteLength(text, 'utf8');
  console.log(`Downloaded: ${totalBytes} bytes (${(totalBytes / 1024 / 1024).toFixed(1)} MB), ${lines.length} lines`);
  console.log(`Baseline:            ${mem()}`);

  // ---- Phase A ----------------------------------------------------------
  gc();
  const memBeforeA = process.memoryUsage();
  const cpuBeforeA = process.cpuUsage();
  const t0A = Date.now();

  const resultA = await phaseA(lines);
  const countA = resultA.count;

  const t1A = Date.now();
  const cpuAfterA = process.cpuUsage(cpuBeforeA);
  const memAfterA = process.memoryUsage();

  console.log(`\n--- Phase A (parseAdGuardLine → object → builder.add → build) ---`);
  console.log(`After Phase A:       ${mem()}`);
  console.log(`  domains hashed: ${countA}`);
  console.log(`  wall time:  ${t1A - t0A}ms`);
  console.log(`  CPU user:  ${(cpuAfterA.user / 1000).toFixed(0)}ms`);
  console.log(`  CPU sys:   ${(cpuAfterA.system / 1000).toFixed(0)}ms`);
  console.log(`  heap delta: ${((memAfterA.heapUsed - memBeforeA.heapUsed) / 1024 / 1024).toFixed(1)}MB`);
  console.log(`  ext delta:  ${((memAfterA.external - memBeforeA.external) / 1024 / 1024).toFixed(1)}MB`);
  console.log(`  RSS delta:  ${((memAfterA.rss - memBeforeA.rss) / 1024 / 1024).toFixed(1)}MB`);
  console.log(`  rule type breakdown:`);
  for (const kind of Object.keys(RULE_KIND_NAMES).map(Number).sort((a, b) => a - b)) {
    const n = resultA.breakdown[kind] || 0;
    console.log(`    ${RULE_KIND_NAMES[kind]}: ${n}`);
  }

  // Clear and GC between phases
  gc();
  console.log(`After GC:            ${mem()}`);

  // ---- Phase B ----------------------------------------------------------
  // Pre-allocate destination arrays (what an optimised direct pipeline would do)
  const fps = new BigUint64Array(lines.length);
  const fps32 = new Uint32Array(fps.buffer);

  gc();
  const memBeforeB = process.memoryUsage();
  const cpuBeforeB = process.cpuUsage();
  const t0B = Date.now();

  const resultB = phaseB(lines, fps32);
  const countB = resultB.count;

  const t1B = Date.now();
  const cpuAfterB = process.cpuUsage(cpuBeforeB);
  const memAfterB = process.memoryUsage();

  console.log(`\n--- Phase B (direct inline hash, no object, no string) ---`);
  console.log(`After Phase B:       ${mem()}`);
  console.log(`  domains hashed: ${countB}`);
  console.log(`  fallbacks:   ${resultB.fallbacks}`);
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
  console.log(`Count match: ${countA === countB ? 'YES' : 'NO'} (Phase A: ${countA}, Phase B: ${countB})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
