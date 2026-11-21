/**
 * @file ttl.ts
 * @description Caps the TTL of every resource record in a DNS wire-format response.
 *
 * Used when a cached answer is served after it expired (lazy cache): the packet must tell the client to
 * ask again soon, otherwise the client would keep the old answer for the original TTL.
 */

const OPT_TYPE = 41;

/** Offset right after the (possibly compressed) name that starts at `offset`, or -1 when malformed. */
function skipName(buf: Uint8Array, offset: number): number {
  let pos = offset;
  for (let i = 0; i < 128; i++) {
    if (pos >= buf.length) return -1;
    const len = buf[pos];
    if (len === 0) return pos + 1;
    if ((len & 0xc0) === 0xc0) return pos + 2 <= buf.length ? pos + 2 : -1;
    if ((len & 0xc0) !== 0) return -1;
    pos += 1 + len;
  }
  return -1;
}

/**
 * Smallest TTL among the answer / authority / additional records of a response (EDNS OPT excluded),
 * or null when there is no record or the packet cannot be parsed.
 */
export function minResponseTtl(raw: Uint8Array): number | null {
  if (raw.length < 12) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let pos = 12;
  for (let i = 0, qd = view.getUint16(4); i < qd; i++) {
    pos = skipName(raw, pos);
    if (pos < 0 || pos + 4 > raw.length) return null;
    pos += 4;
  }
  let min: number | null = null;
  const records = view.getUint16(6) + view.getUint16(8) + view.getUint16(10);
  for (let i = 0; i < records; i++) {
    pos = skipName(raw, pos);
    if (pos < 0 || pos + 10 > raw.length) return null;
    if (view.getUint16(pos) !== OPT_TYPE) {
      const ttl = view.getUint32(pos + 4);
      if (min === null || ttl < min) min = ttl;
    }
    pos += 10 + view.getUint16(pos + 8);
    if (pos > raw.length) return null;
  }
  return min;
}

/**
 * Returns a copy of `raw` in which no answer / authority / additional record has a TTL above `maxTtl`.
 * TTLs that are already lower are kept; the EDNS OPT pseudo record (its "TTL" holds flags) is left alone.
 * A packet that cannot be parsed is returned unchanged (as a copy).
 */
export function capResponseTtl(raw: Uint8Array, maxTtl: number): Uint8Array {
  const out = new Uint8Array(raw);
  if (out.length < 12) return out;
  const cap = Math.max(0, Math.min(0xffffffff, Math.floor(maxTtl)));
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  let pos = 12;
  const qd = view.getUint16(4);
  for (let i = 0; i < qd; i++) {
    pos = skipName(out, pos);
    if (pos < 0 || pos + 4 > out.length) return new Uint8Array(raw);
    pos += 4; // QTYPE + QCLASS
  }

  const records = view.getUint16(6) + view.getUint16(8) + view.getUint16(10);
  for (let i = 0; i < records; i++) {
    pos = skipName(out, pos);
    // TYPE(2) CLASS(2) TTL(4) RDLENGTH(2)
    if (pos < 0 || pos + 10 > out.length) return new Uint8Array(raw);
    const type = view.getUint16(pos);
    if (type !== OPT_TYPE && view.getUint32(pos + 4) > cap) view.setUint32(pos + 4, cap);
    const rdlen = view.getUint16(pos + 8);
    pos += 10 + rdlen;
    if (pos > out.length) return new Uint8Array(raw);
  }
  return out;
}
