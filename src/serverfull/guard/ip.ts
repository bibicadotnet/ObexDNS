/**
 * @file ip.ts
 * @description IPv4 helpers for the guard: uint32 conversion, private check, CIDR -> range, range merge,
 * binary search and base64 (de)serialisation. Ranges are stored as an interleaved Uint32Array [start, end, start, end, ...],
 * sorted by start, non-overlapping and non-adjacent. No `node:*` imports.
 */

import { ipv4ToNumeric, parseCidr } from '../../utils/cidr';
import type { Pacer } from './pace';

/** Converts a remoteAddress string to uint32. Returns null for anything that is not IPv4 (including IPv6). */
export function ipToUint32(ip: string | undefined | null): number | null {
  if (!ip) return null;
  return ipv4ToNumeric(ip.startsWith('::ffff:') ? ip.slice(7) : ip);
}

/** 127/8, 10/8, 172.16/12, 192.168/16. */
export function isPrivateUint32(n: number): boolean {
  const a = n >>> 24;
  return a === 127 || a === 10 || (n >>> 20) === 0xac1 || (n >>> 16) === 0xc0a8;
}

/** Turns "a.b.c.d" or "a.b.c.d/len" into [start, end] (IPv4 only). Returns null for invalid input and IPv6. */
export function cidrToRange(entry: string): [number, number] | null {
  const s = entry.trim();
  if (!s || s.includes(':')) return null;
  const parsed = parseCidr(s.includes('/') ? s : `${s}/32`);
  if (!parsed || parsed.version !== 4) return null;
  return [parsed.net, (parsed.net | (~parsed.mask >>> 0)) >>> 0];
}

/**
 * Parses a text list (one entry per line): skips blank lines and '#' lines, single IP -> /32,
 * drops invalid and IPv6 entries. Returns unmerged [start, end] pairs.
 */
export function parseRangeLines(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const raw of text.split('\n')) { // plain split: far cheaper than a regex, and trim() drops the '\r'
    const range = parseRangeLine(raw);
    if (range) out.push(range);
  }
  return out;
}

function parseRangeLine(raw: string): [number, number] | null {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return null;
  return cidrToRange(line.split(/\s+/)[0]);
}

/** Same result as parseRangeLines, but sleeps whenever the pacer's CPU slice is used up. */
export async function parseRangeLinesPaced(text: string, pace: Pacer): Promise<Array<[number, number]>> {
  const out: Array<[number, number]> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const range = parseRangeLine(lines[i]);
    if (range) out.push(range);
    if ((i & 63) === 63 && pace.due()) await pace.rest();
  }
  return out;
}

/** Sorts, then merges overlapping AND adjacent ranges. */
export function mergeRanges(pairs: ReadonlyArray<readonly [number, number]>): Uint32Array {
  if (pairs.length === 0) return new Uint32Array(0);
  const sorted = pairs.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: number[] = [];
  let cs = sorted[0][0];
  let ce = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= ce + 1) {
      if (e > ce) ce = e;
    } else {
      out.push(cs, ce);
      cs = s;
      ce = e;
    }
  }
  out.push(cs, ce);
  return Uint32Array.from(out);
}

const byStart = (a: readonly [number, number], b: readonly [number, number]): number => a[0] - b[0] || a[1] - b[1];
/** Pairs sorted per slice-friendly run (about 1 ms of sorting each). */
const SORT_RUN = 4096;

async function mergeTwoSorted(
  a: Array<[number, number]>, b: Array<[number, number]>, pace: Pacer
): Promise<Array<[number, number]>> {
  const out: Array<[number, number]> = new Array(a.length + b.length);
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) {
    out[k++] = byStart(a[i], b[j]) <= 0 ? a[i++] : b[j++];
    if ((k & 255) === 0 && pace.due()) await pace.rest();
  }
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

/**
 * Same result as mergeRanges, but never holds the event loop for a whole sort: sorts fixed-size runs, merges the sorted
 * runs two by two, then coalesces, resting whenever the pacer's CPU slice is used up.
 */
export async function mergeRangesPaced(pairs: ReadonlyArray<readonly [number, number]>, pace: Pacer): Promise<Uint32Array> {
  if (pairs.length === 0) return new Uint32Array(0);
  let runs: Array<Array<[number, number]>> = [];
  for (let i = 0; i < pairs.length; i += SORT_RUN) {
    runs.push((pairs.slice(i, i + SORT_RUN) as Array<[number, number]>).sort(byStart));
    if (pace.due()) await pace.rest();
  }
  while (runs.length > 1) {
    const next: Array<Array<[number, number]>> = [];
    for (let r = 0; r < runs.length; r += 2) {
      next.push(r + 1 < runs.length ? await mergeTwoSorted(runs[r], runs[r + 1], pace) : runs[r]);
    }
    runs = next;
  }
  const sorted = runs[0];
  const out: number[] = [];
  let cs = sorted[0][0];
  let ce = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= ce + 1) {
      if (e > ce) ce = e;
    } else {
      out.push(cs, ce);
      cs = s;
      ce = e;
    }
    if ((i & 255) === 255 && pace.due()) await pace.rest();
  }
  out.push(cs, ce);
  return Uint32Array.from(out);
}

/** Paced counterpart of mergeRangeArrays. */
export async function mergeRangeArraysPaced(arrays: ReadonlyArray<Uint32Array | null | undefined>, pace: Pacer): Promise<Uint32Array> {
  const pairs: Array<[number, number]> = [];
  for (const arr of arrays) {
    if (!arr) continue;
    for (let i = 0; i + 1 < arr.length; i += 2) {
      pairs.push([arr[i], arr[i + 1]]);
      if ((i & 1023) === 1022 && pace.due()) await pace.rest();
    }
  }
  return mergeRangesPaced(pairs, pace);
}

/** Merges several already-built range arrays into one. */
export function mergeRangeArrays(arrays: ReadonlyArray<Uint32Array | null | undefined>): Uint32Array {
  const pairs: Array<[number, number]> = [];
  for (const arr of arrays) {
    if (!arr) continue;
    for (let i = 0; i + 1 < arr.length; i += 2) pairs.push([arr[i], arr[i + 1]]);
  }
  return mergeRanges(pairs);
}

/** Number of ranges in an interleaved array. */
export function rangeCount(arr: Uint32Array | null | undefined): number {
  return arr ? arr.length >>> 1 : 0;
}

/** Binary search: is `ip` inside any range of the interleaved array? */
export function inRanges(arr: Uint32Array | null | undefined, ip: number): boolean {
  if (!arr || arr.length === 0) return false;
  let lo = 0;
  let hi = (arr.length >>> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (ip < arr[mid * 2]) hi = mid - 1;
    else if (ip > arr[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Uint32Array -> base64 (little-endian, independent of the host endianness). */
export function encodeRanges(arr: Uint32Array): string {
  const bytes = new Uint8Array(arr.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < arr.length; i++) view.setUint32(i * 4, arr[i], true);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(bin);
}

/** Same output as encodeRanges, but rests whenever the pacer's CPU slice is used up. */
export async function encodeRangesPaced(arr: Uint32Array, pace: Pacer): Promise<string> {
  const bytes = new Uint8Array(arr.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < arr.length; i++) {
    view.setUint32(i * 4, arr[i], true);
    if ((i & 1023) === 1023 && pace.due()) await pace.rest();
  }
  // 24576 is a multiple of 3, so independently encoded pieces concatenate to the same base64 text.
  let out = '';
  for (let i = 0; i < bytes.length; i += 24576) {
    out += btoa(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 24576))));
    if (pace.due()) await pace.rest();
  }
  return out;
}

/**
 * base64 -> Uint32Array. Returns null when the payload is malformed
 * (bad base64, length not a multiple of 8 bytes, start > end, unsorted or overlapping ranges).
 */
export function decodeRanges(b64: string | null | undefined): Uint32Array | null {
  if (typeof b64 !== 'string') return null;
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  if (bin.length % 8 !== 0) return null;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const arr = new Uint32Array(bin.length / 4);
  for (let i = 0; i < arr.length; i++) arr[i] = view.getUint32(i * 4, true);
  for (let i = 0; i < arr.length; i += 2) {
    if (arr[i] > arr[i + 1]) return null;
    if (i >= 2 && arr[i] <= arr[i - 1]) return null;
  }
  return arr;
}
