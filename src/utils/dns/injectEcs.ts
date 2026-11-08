/**
 * injectEcs.ts — RFC 7871 EDNS Client Subnet 注入工具
 *
 * 将 ECS OPT 记录直接写入 DNS 查询的线格式（wire format），确保所有
 * 支持 EDNS0 的上游（包括 ControlD、NextDNS 等非 Google DoH 服务）
 * 均能正确读取到 ECS 信息。
 *
 * OPT RR 结构（RFC 6891 §6.1）:
 *   NAME     : 0x00               (root)
 *   TYPE     : 0x0029             (OPT = 41)
 *   CLASS    : 0x1000             (UDP payload size = 4096)
 *   TTL      : 0x00000000         (extended RCODE + flags)
 *   RDLENGTH : variable
 *   RDATA    : option list
 *
 * ECS Option（RFC 7871 §6）:
 *   OPTION-CODE   : 0x0008        (ECS = 8)
 *   OPTION-LENGTH : variable
 *   FAMILY        : 0x0001 (IPv4) | 0x0002 (IPv6)
 *   SOURCE PREFIX : prefix length (e.g. 24)
 *   SCOPE PREFIX  : 0x00          (client must send 0)
 *   ADDRESS       : network address, truncated to ⌈SOURCE_PREFIX/8⌉ bytes
 */

/** EDNS0 OPT 记录类型码 */
const OPT_TYPE = 41;

/** ECS OPTION-CODE（RFC 7871） */
const ECS_OPTION_CODE = 8;

/**
 * 解析 CIDR 字符串，返回地址族、前缀长度和网络字节。
 * 对地址按前缀长度截断，保证不发送超出前缀的主机位。
 *
 * @param cidr - 形如 "159.223.80.0/20" 或 "2400:6180::/48" 的字符串
 * @returns 解析结果，或 null（格式非法时）
 */
function parseCidr(cidr: string): { family: 1 | 2; prefixLen: number; addrBytes: Uint8Array } | null {
  const slashIdx = cidr.lastIndexOf('/');
  if (slashIdx === -1) return null;

  const addr = cidr.slice(0, slashIdx);
  const prefixLen = parseInt(cidr.slice(slashIdx + 1), 10);
  if (isNaN(prefixLen)) return null;

  if (addr.includes(':')) {
    // IPv6
    const bytes = ipv6ToBytes(addr);
    if (!bytes) return null;
    if (prefixLen < 0 || prefixLen > 128) return null;
    const addrBytes = maskBytes(bytes, prefixLen);
    return { family: 2, prefixLen, addrBytes };
  } else {
    // IPv4
    const parts = addr.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
    if (prefixLen < 0 || prefixLen > 32) return null;
    const bytes = new Uint8Array(parts);
    const addrBytes = maskBytes(bytes, prefixLen);
    return { family: 1, prefixLen, addrBytes };
  }
}

/** 将字节数组截断到 ⌈prefixLen/8⌉ 字节，余量主机位清零。 */
function maskBytes(bytes: Uint8Array, prefixLen: number): Uint8Array {
  const byteLen = Math.ceil(prefixLen / 8);
  const masked = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) {
    masked[i] = bytes[i] ?? 0;
  }
  // 最后一个字节中，超出 prefixLen 的位清零
  const lastByteBits = prefixLen % 8;
  if (lastByteBits !== 0 && byteLen > 0) {
    masked[byteLen - 1] &= (0xff << (8 - lastByteBits)) & 0xff;
  }
  return masked;
}

/** 将 IPv6 地址（含 ::）展开为 16 字节 Uint8Array。 */
function ipv6ToBytes(addr: string): Uint8Array | null {
  try {
    // 处理 :: 展开
    const parts = addr.split('::');
    if (parts.length > 2) return null;

    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    const groups = [...left, ...Array(missing).fill('0'), ...right];

    if (groups.length !== 8) return null;

    const bytes = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      const val = parseInt(groups[i], 16);
      if (isNaN(val)) return null;
      bytes[i * 2]     = (val >> 8) & 0xff;
      bytes[i * 2 + 1] = val & 0xff;
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * 构建包含单个 ECS option 的 OPT RR 字节序列。
 *
 * @param cidr - 要注入的 CIDR 字符串
 * @returns OPT RR 的 Uint8Array，或 null（cidr 非法时）
 */
function buildEcsOptRr(cidr: string): Uint8Array | null {
  const parsed = parseCidr(cidr);
  if (!parsed) return null;

  const { family, prefixLen, addrBytes } = parsed;

  // ECS option 内容: OPTION-CODE(2) + OPTION-LEN(2) + FAMILY(2) + SRC-PREFIX(1) + SCOPE-PREFIX(1) + ADDRESS(N)
  const ecsDataLen = 4 + addrBytes.length;
  const ecsOption = new Uint8Array(4 + ecsDataLen);
  let o = 0;
  // OPTION-CODE = 8
  ecsOption[o++] = 0x00;
  ecsOption[o++] = ECS_OPTION_CODE;
  // OPTION-LENGTH
  ecsOption[o++] = (ecsDataLen >> 8) & 0xff;
  ecsOption[o++] = ecsDataLen & 0xff;
  // ADDRESS FAMILY
  ecsOption[o++] = (family >> 8) & 0xff;
  ecsOption[o++] = family & 0xff;
  // SOURCE PREFIX-LENGTH
  ecsOption[o++] = prefixLen;
  // SCOPE PREFIX-LENGTH (always 0 in queries)
  ecsOption[o++] = 0x00;
  // ADDRESS (truncated)
  ecsOption.set(addrBytes, o);

  // OPT RR: NAME(1) + TYPE(2) + CLASS(2) + TTL(4) + RDLENGTH(2) + RDATA(N)
  const rdLen = ecsOption.length;
  const optRr = new Uint8Array(11 + rdLen);
  let p = 0;
  optRr[p++] = 0x00;              // NAME = root
  optRr[p++] = 0x00;              // TYPE high
  optRr[p++] = OPT_TYPE;          // TYPE low = 41
  optRr[p++] = 0x10;              // CLASS (UDP payload) high = 4096
  optRr[p++] = 0x00;              // CLASS low
  optRr[p++] = 0x00;              // TTL (extended RCODE)
  optRr[p++] = 0x00;
  optRr[p++] = 0x00;
  optRr[p++] = 0x00;
  optRr[p++] = (rdLen >> 8) & 0xff; // RDLENGTH high
  optRr[p++] = rdLen & 0xff;        // RDLENGTH low
  optRr.set(ecsOption, p);

  return optRr;
}

/**
 * 将 ECS OPT RR 注入到现有的 DNS 查询报文中，返回修改后的新报文。
 *
 * 策略：
 * - 若报文已包含 OPT RR（ARCOUNT > 0 且存在 TYPE=41 记录），用新 ECS 替换其中的
 *   ECS option（其他 EDNS option 保留），以避免重复注入。
 * - 若报文没有 OPT RR，在 Additional 区末尾附加一个新的 OPT RR 并将 ARCOUNT +1。
 *
 * @param raw - 原始 DNS 查询的线格式字节
 * @param cidr - 要注入的 ECS 网络前缀，格式 "a.b.c.d/N" 或 "::x/N"
 * @returns 注入 ECS 后的新 DNS 查询字节，或原始字节（cidr 非法时回退）
 */
export function injectEcsIntoQuery(raw: Uint8Array, cidr: string): Uint8Array {
  const optRr = buildEcsOptRr(cidr);
  if (!optRr) {
    console.warn(`[ECS] Invalid CIDR "${cidr}", skipping injection.`);
    return raw;
  }

  if (raw.length < 12) return raw;

  // 读取当前 ARCOUNT
  const arCount = (raw[10] << 8) | raw[11];

  // 找到 Additional 区的起始偏移（跳过 Header + Question + Answer + Authority）
  let offset = 12;

  // 跳过 Question 区
  const qdCount = (raw[4] << 8) | raw[5];
  for (let i = 0; i < qdCount && offset < raw.length; i++) {
    // 跳过 QNAME
    while (offset < raw.length) {
      const len = raw[offset];
      if (len === 0) { offset++; break; }
      if ((len & 0xc0) === 0xc0) { offset += 2; break; } // compression pointer
      offset += 1 + len;
    }
    offset += 4; // QTYPE + QCLASS
  }

  // 跳过 Answer 和 Authority 区（共 ANCOUNT + NSCOUNT 条 RR）
  const rrToSkip = ((raw[6] << 8) | raw[7]) + ((raw[8] << 8) | raw[9]);
  for (let i = 0; i < rrToSkip && offset < raw.length; i++) {
    offset = skipRR(raw, offset);
  }

  // Additional 区起始
  const additionalStart = offset;

  // 在 Additional 区中查找已有的 OPT RR，若找到则剥离它
  let existingOptStart = -1;
  let existingOptEnd = -1;
  let pos = additionalStart;
  for (let i = 0; i < arCount && pos < raw.length; i++) {
    const rrStart = pos;
    // OPT RR 的 NAME 固定为 0x00（单字节），TYPE 紧随其后
    if (pos < raw.length && raw[pos] === 0x00) {
      const rrType = pos + 1 < raw.length ? ((raw[pos + 1] << 8) | raw[pos + 2]) : -1;
      if (rrType === OPT_TYPE) {
        existingOptStart = rrStart;
        pos = skipRR(raw, pos);
        existingOptEnd = pos;
        break;
      }
    }
    pos = skipRR(raw, pos);
  }

  // 重新组装报文：原始内容（不含旧 OPT） + 新 OPT RR
  let newRaw: Uint8Array;

  if (existingOptStart !== -1) {
    // 替换已有 OPT RR
    const before = raw.slice(0, existingOptStart);
    const after  = raw.slice(existingOptEnd);
    newRaw = new Uint8Array(before.length + optRr.length + after.length);
    newRaw.set(before, 0);
    newRaw.set(optRr, before.length);
    newRaw.set(after, before.length + optRr.length);
    // ARCOUNT 不变（替换，不增加）
  } else {
    // 追加新 OPT RR
    newRaw = new Uint8Array(raw.length + optRr.length);
    newRaw.set(raw, 0);
    newRaw.set(optRr, raw.length);
    // ARCOUNT + 1
    const newArCount = arCount + 1;
    newRaw[10] = (newArCount >> 8) & 0xff;
    newRaw[11] = newArCount & 0xff;
  }

  return newRaw;
}

/** 跳过一条 RR，返回下一条 RR 的偏移量。 */
function skipRR(raw: Uint8Array, offset: number): number {
  if (offset >= raw.length) return offset;

  // 跳过 NAME（可能含压缩指针）
  while (offset < raw.length) {
    const len = raw[offset];
    if (len === 0) { offset++; break; }
    if ((len & 0xc0) === 0xc0) { offset += 2; break; }
    offset += 1 + len;
  }

  if (offset + 10 > raw.length) return raw.length;

  // TYPE(2) + CLASS(2) + TTL(4) + RDLENGTH(2)
  const rdLength = (raw[offset + 8] << 8) | raw[offset + 9];
  offset += 10 + rdLength;

  return Math.min(offset, raw.length);
}
