/**
 * Encodes a buffer or byte array into a Base64URL string (RFC 4648 §5).
 *
 * @param buffer - Raw bytes or ArrayBuffer to encode.
 * @returns Base64URL encoded string.
 */
export function base64UrlEncode(buffer: Uint8Array | ArrayBuffer): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decodes a Base64URL string into a Uint8Array.
 *
 * @param str - Base64URL string to decode.
 * @returns Decoded byte array.
 */
export function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Generates a high-entropy random challenge for WebAuthn ceremony.
 *
 * @returns 32-byte Base64URL challenge string.
 */
export function generateWebAuthnChallenge(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Converts an ASN.1 DER-encoded ECDSA signature to raw IEEE P1363 (r || s) format
 * expected by Web Crypto API `subtle.verify`.
 *
 * @param der - ASN.1 DER-encoded signature bytes.
 * @returns 64-byte raw IEEE P1363 signature (32 bytes r + 32 bytes s).
 */
export function derToP1363(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) {
    if (der.length === 64) return der;
    throw new Error("Invalid ECDSA signature: expected ASN.1 SEQUENCE");
  }

  let offset = 2;
  if (der[1] & 0x80) {
    offset = 2 + (der[1] & 0x7f);
  }

  // Read r
  if (der[offset++] !== 0x02) throw new Error("Expected INTEGER for r in signature");
  const rLen = der[offset++];
  let r = der.subarray(offset, offset + rLen);
  offset += rLen;

  // Read s
  if (der[offset++] !== 0x02) throw new Error("Expected INTEGER for s in signature");
  const sLen = der[offset++];
  let s = der.subarray(offset, offset + sLen);

  // Strip leading zero padding if added to keep value positive in two's complement
  while (r.length > 32 && r[0] === 0x00) r = r.subarray(1);
  while (s.length > 32 && s[0] === 0x00) s = s.subarray(1);

  const p1363 = new Uint8Array(64);
  p1363.set(r, 32 - r.length);
  p1363.set(s, 64 - s.length);
  return p1363;
}
