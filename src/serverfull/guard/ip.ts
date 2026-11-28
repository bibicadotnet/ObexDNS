/**
 * @file ip.ts
 * @description IPv4 helpers for the guard: uint32 conversion, private check, CIDR -> range, range merge,
 * binary search and base64 (de)serialisation. Ranges are stored as an interleaved Uint32Array [start, end, start, end, ...],
 * sorted by start, non-overlapping and non-adjacent. No `node:*` imports.
 */

import { ipv4ToNumeric, parseCidr } from '../../utils/cidr';

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
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const range = cidrToRange(line.split(/\s+/)[0]);
    if (range) out.push(range);
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
