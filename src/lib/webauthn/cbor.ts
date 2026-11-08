/**
 * Represents any valid decoded CBOR value type.
 */
export type CborValue =
  | number
  | bigint
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborValue[]
  | { [key: string | number]: CborValue };

/**
 * Result structure returned by decodeCbor.
 */
export interface CborDecodeResult {
  value: any;
  bytesRead: number;
}

/**
 * Minimal, robust CBOR decoder tailored for WebAuthn attestationObject and COSE key structures (RFC 8949).
 *
 * @param data - Raw byte array containing CBOR data.
 * @returns Object with parsed value and total bytes consumed.
 */
export function decodeCbor(data: Uint8Array): CborDecodeResult {
  let offset = 0;

  function readUint(info: number): number | bigint {
    if (info < 24) return info;
    if (info === 24) return data[offset++];
    if (info === 25) {
      const val = (data[offset] << 8) | data[offset + 1];
      offset += 2;
      return val;
    }
    if (info === 26) {
      const val =
        ((data[offset] << 24) >>> 0) +
        (data[offset + 1] << 16) +
        (data[offset + 2] << 8) +
        data[offset + 3];
      offset += 4;
      return val;
    }
    if (info === 27) {
      const hi = BigInt(
        ((data[offset] << 24) >>> 0) +
          (data[offset + 1] << 16) +
          (data[offset + 2] << 8) +
          data[offset + 3]
      );
      const lo = BigInt(
        ((data[offset + 4] << 24) >>> 0) +
          (data[offset + 5] << 16) +
          (data[offset + 6] << 8) +
          data[offset + 7]
      );
      offset += 8;
      return (hi << 32n) | lo;
    }
    throw new Error(`Unsupported CBOR uint info: ${info}`);
  }

  function parseItem(): any {
    if (offset >= data.length) throw new Error("Unexpected end of CBOR data");
    const initialByte = data[offset++];
    const majorType = initialByte >> 5;
    const info = initialByte & 0x1f;

    switch (majorType) {
      case 0: {
        // unsigned integer
        const val = readUint(info);
        return typeof val === "bigint" ? Number(val) : val;
      }
      case 1: {
        // negative integer (-1 - n)
        const val = readUint(info);
        return typeof val === "bigint" ? Number(-1n - val) : -1 - Number(val);
      }
      case 2: {
        // byte string
        const len = Number(readUint(info));
        const slice = data.subarray(offset, offset + len);
        offset += len;
        return slice;
      }
      case 3: {
        // text string
        const len = Number(readUint(info));
        const slice = data.subarray(offset, offset + len);
        offset += len;
        return new TextDecoder().decode(slice);
      }
      case 4: {
        // array
        const len = Number(readUint(info));
        const arr: any[] = [];
        for (let i = 0; i < len; i++) {
          arr.push(parseItem());
        }
        return arr;
      }
      case 5: {
        // map
        const len = Number(readUint(info));
        const map: Record<string | number, any> = {};
        for (let i = 0; i < len; i++) {
          const key = parseItem();
          const val = parseItem();
          map[key] = val;
        }
        return map;
      }
      case 7: {
        // simple values
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        return undefined;
      }
      default:
        throw new Error(`Unsupported CBOR major type: ${majorType}`);
    }
  }

  const value = parseItem();
  return { value, bytesRead: offset };
}
