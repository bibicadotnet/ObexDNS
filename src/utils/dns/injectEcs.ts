/**
 * injectEcs.ts — RFC 7871 EDNS Client Subnet wire-format helpers.
 *
 * Writes (or removes) the ECS option directly in the OPT pseudo-RR of a DNS query, so every
 * EDNS0-capable upstream (ControlD, NextDNS, Quad9, ...) sees it, not only Google-style DoH.
 *
 * Rules enforced here:
 * - An existing OPT RR is edited in place: UDP payload size, extended-RCODE/version/flags
 *   (notably the DNSSEC "DO" bit) and every other EDNS option (cookie, padding, ...) are preserved.
 *   Only the ECS option (code 8) is replaced or removed.
 * - ECS sent by the client is never forwarded as-is: it is either overwritten with the
 *   server-chosen subnet (injectEcsIntoQuery) or removed (stripEcsFromQuery).
 * - Subnets are parsed strictly; host bits beyond the prefix are zeroed.
 *
 * ECS option (RFC 7871 §6): CODE(2)=8 | LEN(2) | FAMILY(2) | SOURCE PREFIX(1) | SCOPE PREFIX(1)=0 | ADDRESS(⌈prefix/8⌉)
 */

import { ipv4ToNumeric, ipv6ToBigInt } from "../cidr";

/** EDNS0 OPT record type code. */
const OPT_TYPE = 41;

/** ECS OPTION-CODE (RFC 7871). */
const ECS_OPTION_CODE = 8;

/** UDP payload size advertised when we have to create a brand-new OPT RR. */
const DEFAULT_UDP_PAYLOAD = 4096;

/** A parsed, masked ECS subnet ready to be encoded. */
export interface EcsSubnet {
  /** 1 = IPv4, 2 = IPv6 (RFC 7871 / IANA address family numbers). */
  family: 1 | 2;
  prefixLen: number;
  /** Network address truncated to ⌈prefixLen/8⌉ bytes with host bits zeroed. */
  addrBytes: Uint8Array;
}

/**
 * Strictly parses "a.b.c.d/N" or "x:y::z/N" into a masked ECS subnet.
 * IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are rejected: callers must convert them to
 * plain IPv4 first (see normalizeClientIp in pipeline/resolver/ecs.ts), otherwise the
 * subnet would silently collapse to ::/N.
 *
 * @returns The subnet, or null if the input is not a valid CIDR.
 */
export function parseEcsCidr(cidr: string): EcsSubnet | null {
  if (typeof cidr !== "string") return null;
  const m = /^([^/\s]+)\/(\d{1,3})$/.exec(cidr.trim());
  if (!m) return null;

  const addr = m[1];
  const prefixLen = Number(m[2]);

  if (addr.includes(":")) {
    if (prefixLen > 128) return null;
    const v = ipv6ToBigInt(addr);
    if (v === null) return null;
    if (v >> 32n === 0xffffn) return null; // IPv4-mapped: not a valid client subnet
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      bytes[i] = Number((v >> BigInt(8 * (15 - i))) & 0xffn);
    }
    return { family: 2, prefixLen, addrBytes: maskBytes(bytes, prefixLen) };
  }

  if (prefixLen > 32) return null;
  const n = ipv4ToNumeric(addr);
  if (n === null) return null;
  const bytes = new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  return { family: 1, prefixLen, addrBytes: maskBytes(bytes, prefixLen) };
}

/** Truncates to ⌈prefixLen/8⌉ bytes and zeroes the host bits of the last byte. */
function maskBytes(bytes: Uint8Array, prefixLen: number): Uint8Array {
  const byteLen = Math.ceil(prefixLen / 8);
  const masked = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) masked[i] = bytes[i] ?? 0;
  const rem = prefixLen % 8;
  if (rem !== 0 && byteLen > 0) {
    masked[byteLen - 1] &= (0xff << (8 - rem)) & 0xff;
  }
  return masked;
}

/**
 * Formats a masked subnet as canonical "address/prefix" text
 * (IPv4 dotted quad; IPv6 lowercase with the longest zero run compressed).
 */
export function formatEcsSubnet(s: EcsSubnet): string {
  if (s.family === 1) {
    const o = [0, 0, 0, 0];
    s.addrBytes.forEach((b, i) => { o[i] = b; });
    return `${o.join(".")}/${s.prefixLen}`;
  }
  const full = new Uint8Array(16);
  full.set(s.addrBytes);
  const g: number[] = [];
  for (let i = 0; i < 8; i++) g.push((full[i * 2] << 8) | full[i * 2 + 1]);

  // Longest run (>=2) of zero groups gets compressed to "::"
  let bestStart = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  let text: string;
  if (bestLen >= 2) {
    text = `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
  } else {
    text = hex.join(":");
  }
  return `${text}/${s.prefixLen}`;
}

/** Encodes one ECS option (header + payload). */
function buildEcsOption(s: EcsSubnet): Uint8Array {
  const dataLen = 4 + s.addrBytes.length;
  const out = new Uint8Array(4 + dataLen);
  out[0] = 0x00;
  out[1] = ECS_OPTION_CODE;
  out[2] = (dataLen >> 8) & 0xff;
  out[3] = dataLen & 0xff;
  out[4] = 0x00;
  out[5] = s.family;
  out[6] = s.prefixLen;
  out[7] = 0x00; // SCOPE PREFIX-LENGTH must be 0 in queries
  out.set(s.addrBytes, 8);
  return out;
}

// ─── Wire scanning ───────────────────────────────────────────────────────────

interface EdnsOption { code: number; bytes: Uint8Array }

interface OptLocation {
  start: number;
  end: number;
  udpSize: number;
  /** Extended RCODE (1) + VERSION (1) + flags/DO (2), copied verbatim. */
  ttl: Uint8Array;
  options: EdnsOption[];
  /** True when the option list was truncated/garbled (remaining bytes are dropped). */
  malformed: boolean;
}

interface QueryScan {
  arCount: number;
  opt: OptLocation | null;
}

/** Returns the offset just after a (possibly compressed) name, or -1 if out of bounds/invalid. */
function skipName(raw: Uint8Array, offset: number): number {
  for (;;) {
    if (offset >= raw.length) return -1;
    const len = raw[offset];
    if (len === 0) return offset + 1;
    if ((len & 0xc0) === 0xc0) return offset + 2 <= raw.length ? offset + 2 : -1;
    if ((len & 0xc0) !== 0) return -1;
    offset += 1 + len;
  }
}

/** Returns the offset just after a resource record, or -1 if truncated. */
function skipRR(raw: Uint8Array, offset: number): number {
  const afterName = skipName(raw, offset);
  if (afterName === -1 || afterName + 10 > raw.length) return -1;
  const rdLength = (raw[afterName + 8] << 8) | raw[afterName + 9];
  const end = afterName + 10 + rdLength;
  return end <= raw.length ? end : -1;
}

function parseOpt(raw: Uint8Array, start: number, end: number): OptLocation {
  const rdLen = (raw[start + 9] << 8) | raw[start + 10];
  const rdStart = start + 11;
  const rdEnd = Math.min(end, rdStart + rdLen);
  const options: EdnsOption[] = [];
  let malformed = false;
  let p = rdStart;
  while (p < rdEnd) {
    if (p + 4 > rdEnd) { malformed = true; break; }
    const code = (raw[p] << 8) | raw[p + 1];
    const len = (raw[p + 2] << 8) | raw[p + 3];
    if (p + 4 + len > rdEnd) { malformed = true; break; }
    options.push({ code, bytes: raw.slice(p, p + 4 + len) });
    p += 4 + len;
  }
  return {
    start,
    end,
    udpSize: (raw[start + 3] << 8) | raw[start + 4],
    ttl: raw.slice(start + 5, start + 9),
    options,
    malformed
  };
}

/** Locates the OPT RR of a query. Returns null if the packet cannot be walked safely. */
function scanQuery(raw: Uint8Array): QueryScan | null {
  if (raw.length < 12) return null;
  const qdCount = (raw[4] << 8) | raw[5];
  const anCount = (raw[6] << 8) | raw[7];
  const nsCount = (raw[8] << 8) | raw[9];
  const arCount = (raw[10] << 8) | raw[11];

  let off = 12;
  for (let i = 0; i < qdCount; i++) {
    off = skipName(raw, off);
    if (off === -1 || off + 4 > raw.length) return null;
    off += 4; // QTYPE + QCLASS
  }
  for (let i = 0; i < anCount + nsCount; i++) {
    off = skipRR(raw, off);
    if (off === -1) return null;
  }

  let opt: OptLocation | null = null;
  for (let i = 0; i < arCount; i++) {
    const start = off;
    const end = skipRR(raw, start);
    if (end === -1) return null;
    // OPT owner name is always the root (single 0x00 byte)
    if (!opt && raw[start] === 0x00 && ((raw[start + 1] << 8) | raw[start + 2]) === OPT_TYPE) {
      opt = parseOpt(raw, start, end);
    }
    off = end;
  }
  return { arCount, opt };
}

function buildOptRr(udpSize: number, ttl: Uint8Array, options: Uint8Array[]): Uint8Array {
  const rdLen = options.reduce((n, o) => n + o.length, 0);
  const rr = new Uint8Array(11 + rdLen);
  rr[0] = 0x00;                       // NAME = root
  rr[1] = 0x00;                       // TYPE = 41
  rr[2] = OPT_TYPE;
  rr[3] = (udpSize >> 8) & 0xff;      // CLASS = UDP payload size
  rr[4] = udpSize & 0xff;
  rr.set(ttl, 5);                     // ext-RCODE, version, flags (DO)
  rr[9] = (rdLen >> 8) & 0xff;
  rr[10] = rdLen & 0xff;
  let p = 11;
  for (const o of options) { rr.set(o, p); p += o.length; }
  return rr;
}

/**
 * Rewrites the ECS option of a query: replaces it with `ecsOption`, or removes it when null.
 * Returns the original array untouched when there is nothing to change.
 */
function rewriteEcs(raw: Uint8Array, ecsOption: Uint8Array | null): Uint8Array {
  const scan = scanQuery(raw);
  if (!scan) return raw;

  const { opt } = scan;
  const hadEcs = !!opt && opt.options.some((o) => o.code === ECS_OPTION_CODE);
  if (!ecsOption && !hadEcs && !(opt && opt.malformed)) return raw;

  const kept = opt ? opt.options.filter((o) => o.code !== ECS_OPTION_CODE).map((o) => o.bytes) : [];
  const options = ecsOption ? [ecsOption, ...kept] : kept;
  const newOpt = buildOptRr(opt ? opt.udpSize : DEFAULT_UDP_PAYLOAD, opt ? opt.ttl : new Uint8Array(4), options);

  if (opt) {
    const out = new Uint8Array(opt.start + newOpt.length + (raw.length - opt.end));
    out.set(raw.subarray(0, opt.start), 0);
    out.set(newOpt, opt.start);
    out.set(raw.subarray(opt.end), opt.start + newOpt.length);
    return out;
  }

  const out = new Uint8Array(raw.length + newOpt.length);
  out.set(raw, 0);
  out.set(newOpt, raw.length);
  const ar = scan.arCount + 1;
  out[10] = (ar >> 8) & 0xff;
  out[11] = ar & 0xff;
  return out;
}

/**
 * Sets the ECS option of a DNS query to `cidr`, replacing any ECS the client sent.
 * All other EDNS data (DO bit, UDP size, cookies, padding, ...) is kept.
 *
 * If `cidr` is invalid, the client's own ECS is still removed (never forwarded).
 *
 * @param raw - Wire-format DNS query.
 * @param cidr - Subnet such as "1.2.3.0/24" or "2001:db8::/48".
 */
export function injectEcsIntoQuery(raw: Uint8Array, cidr: string): Uint8Array {
  const subnet = parseEcsCidr(cidr);
  if (!subnet) {
    console.warn(`[ECS] Invalid CIDR "${cidr}", opting out of ECS instead of injecting.`);
    return disableEcsInQuery(raw);
  }
  return rewriteEcs(raw, buildEcsOption(subnet));
}

/**
 * Removes any ECS option from a DNS query (client-supplied ECS must not reach the upstream
 * when ECS is disabled). Returns `raw` itself when there is no ECS option.
 */
export function stripEcsFromQuery(raw: Uint8Array): Uint8Array {
  return rewriteEcs(raw, null);
}

/**
 * Tells the upstream NOT to use or forward any client subnet, via an ECS option with
 * source prefix-length 0 (RFC 7871 §7.1.2). Resolvers such as Google Public DNS add an ECS of
 * their own when the query carries none; the /0 option is the standard way to opt out.
 * Any ECS the client sent is replaced; other EDNS data is preserved.
 */
export function disableEcsInQuery(raw: Uint8Array): Uint8Array {
  return rewriteEcs(raw, buildEcsOption({ family: 1, prefixLen: 0, addrBytes: new Uint8Array(0) }));
}

/**
 * Removes the ECS option from an upstream RESPONSE before it is cached or returned to the client.
 * Upstreams (e.g. Google) may echo or add ECS even when we sent none; clients never asked for it.
 * Everything else in the OPT RR is preserved. Returns `raw` itself when there is no ECS option.
 */
export function stripEcsFromResponse(raw: Uint8Array): Uint8Array {
  return rewriteEcs(raw, null);
}
