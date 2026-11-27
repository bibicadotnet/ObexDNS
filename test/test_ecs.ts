/// <reference types="node" />
import assert from "node:assert";
import { applyEcs, ecsCacheScope, normalizeClientIp, resolveEcsUpstreamUrl } from "../src/pipeline/resolver/ecs";
import { injectEcsIntoQuery, stripEcsFromQuery, stripEcsFromResponse, disableEcsInQuery, parseEcsCidr } from "../src/utils/dns";

// ECS option with source prefix 0 = "do not use / forward a client subnet" (RFC 7871 §7.1.2)
const OPT_OUT = "00010000";
import type { ProfileSettings, DNSQuery } from "../src/types";

// ── Independent wire helpers (do not reuse the code under test) ──────────────
const H = (hex: string) => new Uint8Array(Buffer.from(hex.replace(/\s/g, ""), "hex"));
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

/** Query "a.com A" (+ optional raw OPT RR hex). */
function makeQuery(optHex?: string): Uint8Array {
  const ar = optHex ? "0001" : "0000";
  return H(`1234 0100 0001 0000 0000 ${ar} 01 61 03 636f6d 00 0001 0001 ${optHex ?? ""}`);
}
const COOKIE = "000a 0008 1122334455667788";
const PADDING = "000c 0004 00000000";
const ECS_FROM_CLIENT = "0008 0007 0001 18 00 090909"; // client claims 9.9.9.0/24
// OPT: udp=1232, ext-rcode/version=0, flags DO=1
const optHex = (...opts: string[]) => {
  const body = opts.join("").replace(/\s/g, "");
  return `00 0029 04d0 00008000 ${(body.length / 2).toString(16).padStart(4, "0")} ${body}`;
};

interface Opt { udp: number; ttl: string; options: Record<number, string>; arCount: number; }
function readOpt(raw: Uint8Array): Opt | null {
  let off = 12;
  while (raw[off] !== 0) off += 1 + raw[off];
  off += 1 + 4;
  const arCount = (raw[10] << 8) | raw[11];
  // skip answer + authority records (names are either root, labels, or a 2-byte pointer)
  for (let i = 0; i < ((raw[6] << 8) | raw[7]) + ((raw[8] << 8) | raw[9]); i++) {
    while (raw[off] !== 0 && (raw[off] & 0xc0) !== 0xc0) off += 1 + raw[off];
    off += (raw[off] & 0xc0) === 0xc0 ? 2 : 1;
    off += 10 + ((raw[off + 8] << 8) | raw[off + 9]);
  }
  for (let i = 0; i < arCount; i++) {
    const type = (raw[off + 1] << 8) | raw[off + 2];
    const rdLen = (raw[off + 9] << 8) | raw[off + 10];
    if (type === 41) {
      const options: Record<number, string> = {};
      let p = off + 11;
      while (p < off + 11 + rdLen) {
        const code = (raw[p] << 8) | raw[p + 1];
        const len = (raw[p + 2] << 8) | raw[p + 3];
        assert.ok(!(code in options), `duplicate EDNS option ${code}`);
        options[code] = hex(raw.slice(p + 4, p + 4 + len));
        p += 4 + len;
      }
      assert.strictEqual(p, off + 11 + rdLen, "option list must exactly fill RDATA");
      return { udp: (raw[off + 3] << 8) | raw[off + 4], ttl: hex(raw.slice(off + 5, off + 9)), options, arCount };
    }
    off += 11 + rdLen;
  }
  return null;
}

const req = (ip?: string) =>
  new Request("http://x/dns-query", { headers: ip ? { "CF-Connecting-IP": ip } : {} });
const mkSettings = (ecs: Partial<ProfileSettings["ecs"]>): ProfileSettings =>
  ({ upstream: [], log_retention_days: 0, default_policy: "ALLOW", ecs: { enabled: true, use_client_ip: true, ...ecs } }) as ProfileSettings;
const mkQuery = (raw: Uint8Array, type = "A"): DNSQuery => ({ name: "a.com", type, raw });

// ── 1. IPv4-mapped IPv6 ──────────────────────────────────────────────────────
function testMapped() {
  for (const ip of ["::ffff:1.2.3.4", "::FFFF:1.2.3.4", "::ffff:102:304", "[::ffff:1.2.3.4]", " ::ffff:1.2.3.4 "]) {
    assert.strictEqual(normalizeClientIp(ip), "1.2.3.4", ip);
    const r = applyEcs(req(ip), mkQuery(makeQuery()), mkSettings({}));
    assert.strictEqual(r.ecs, "1.2.3.0/24", `ecs for ${ip}`);
    assert.strictEqual(readOpt(r.queryRaw)!.options[8], "00011800010203", `wire for ${ip}`);
  }
  // injectEcs must reject (not mangle) a mapped address if one ever reaches it
  assert.strictEqual(parseEcsCidr("::ffff:1.2.3.4/48"), null);
  const bad = injectEcsIntoQuery(makeQuery(optHex(ECS_FROM_CLIENT)), "::ffff:1.2.3.4/48");
  assert.strictEqual(readOpt(bad)!.options[8], OPT_OUT, "invalid cidr must not leave client ECS behind");
}

// ── 2. No ECS leak when disabled ─────────────────────────────────────────────
function testDisabledStrips() {
  const q = makeQuery(optHex(ECS_FROM_CLIENT, COOKIE));
  for (const ecs of [{ enabled: false }, undefined]) {
    const s = ecs ? mkSettings(ecs) : ({ ...mkSettings({}), ecs: undefined } as unknown as ProfileSettings);
    const r = applyEcs(req("5.6.7.8"), mkQuery(q), s);
    const o = readOpt(r.queryRaw)!;
    assert.strictEqual(o.options[8], OPT_OUT, "client ECS must be replaced by the /0 opt-out when ECS is disabled");
    assert.strictEqual(o.options[10], "1122334455667788", "cookie kept");
    assert.strictEqual(o.ttl, "00008000", "DO bit kept");
    assert.strictEqual(r.ecs, undefined);
    assert.strictEqual(r.ecsScope, undefined);
  }
  // No ECS from client -> same bytes (no copy, no change)
  const plain = makeQuery(optHex(COOKIE));
  assert.strictEqual(stripEcsFromQuery(plain), plain);
  // ECS was the only option: OPT stays (DO preserved) with empty RDATA
  const only = readOpt(stripEcsFromQuery(makeQuery(optHex(ECS_FROM_CLIENT))))!;
  assert.deepStrictEqual(only.options, {});
  assert.strictEqual(only.ttl, "00008000");
  assert.strictEqual(only.udp, 1232);
}

// ── 3. Injection keeps other EDNS data ───────────────────────────────────────
function testPreserveEdns() {
  const q = makeQuery(optHex(COOKIE, ECS_FROM_CLIENT, PADDING));
  const out = injectEcsIntoQuery(q, "159.223.80.0/20");
  const o = readOpt(out)!;
  assert.strictEqual(o.arCount, 1);
  assert.strictEqual(o.udp, 1232, "UDP payload size kept");
  assert.strictEqual(o.ttl, "00008000", "DO bit kept");
  assert.strictEqual(o.options[10], "1122334455667788", "cookie kept");
  assert.strictEqual(o.options[12], "00000000", "padding kept");
  // family=1, source prefix=20 (0x14), scope=0, address 159.223.80.0 truncated to 3 bytes
  assert.strictEqual(o.options[8], "000114009fdf50", "ECS replaced, masked to /20");
}

function testAppendNoOpt() {
  const q = makeQuery();
  const out = injectEcsIntoQuery(q, "2001:db8:1234::/48");
  const o = readOpt(out)!;
  assert.strictEqual(o.arCount, 1);
  assert.strictEqual(o.ttl, "00000000");
  assert.strictEqual(o.options[8], "0002" + "30" + "00" + "20010db81234");
  // question section untouched
  assert.strictEqual(hex(out.slice(12, q.length)), hex(q.slice(12)));
  // idempotent: injecting twice never duplicates the option
  const twice = readOpt(injectEcsIntoQuery(out, "2001:db8:1234::/48"))!;
  assert.strictEqual(twice.arCount, 1);
  assert.strictEqual(twice.options[8], o.options[8]);
}

// ── 4. Client-IP ECS: masking, private fallback ──────────────────────────────
function testClientIp() {
  let r = applyEcs(req("113.161.5.77"), mkQuery(makeQuery()), mkSettings({}));
  assert.strictEqual(r.ecs, "113.161.5.0/24");
  assert.strictEqual(r.ecsScope, "113.161.5.0/24");

  r = applyEcs(req("2405:4800:1234:5678::1"), mkQuery(makeQuery()), mkSettings({}));
  assert.strictEqual(r.ecs, "2405:4800:1234::/48");
  assert.strictEqual(readOpt(r.queryRaw)!.options[8], "000230" + "00" + "240548001234");

  // Loopback / private / missing / garbage: no ECS, client ECS removed, scope "none"
  for (const ip of [undefined, "127.0.0.1", "10.0.0.5", "192.168.1.9", "172.17.0.2", "::1", "fe80::1", "garbage", "1.2.3"]) {
    const r2 = applyEcs(req(ip), mkQuery(makeQuery(optHex(ECS_FROM_CLIENT))), mkSettings({}));
    assert.strictEqual(r2.ecs, undefined, `no ECS for ${ip}`);
    assert.strictEqual(readOpt(r2.queryRaw)!.options[8], OPT_OUT, `client ECS replaced by opt-out for ${ip}`);
    assert.strictEqual(r2.ecsScope, "none");
  }
}

// ── 5. Custom subnets ────────────────────────────────────────────────────────
function testCustom() {
  const s = mkSettings({ use_client_ip: false, ipv4_cidr: "113.160.0.0/16", ipv6_cidr: "2405:4800::/32" });
  assert.strictEqual(applyEcs(req("8.8.8.8"), mkQuery(makeQuery(), "A"), s).ecs, "113.160.0.0/16");
  assert.strictEqual(applyEcs(req("8.8.8.8"), mkQuery(makeQuery(), "AAAA"), s).ecs, "2405:4800::/32");
  // HTTPS/SVCB follow the client's family
  assert.strictEqual(applyEcs(req("8.8.8.8"), mkQuery(makeQuery(), "HTTPS"), s).ecs, "113.160.0.0/16");
  assert.strictEqual(applyEcs(req("2405:4800::1"), mkQuery(makeQuery(), "HTTPS"), s).ecs, "2405:4800::/32");
  // fallback to the only family configured
  assert.strictEqual(applyEcs(req("8.8.8.8"), mkQuery(makeQuery(), "AAAA"), mkSettings({ use_client_ip: false, ipv4_cidr: "1.2.3.0/24" })).ecs, "1.2.3.0/24");
  // custom answers do not depend on the client -> no cache scope
  assert.strictEqual(applyEcs(req("8.8.8.8"), mkQuery(makeQuery()), s).ecsScope, undefined);
  // corrupted custom value: nothing injected, client ECS still removed
  const bad = applyEcs(req("8.8.8.8"), mkQuery(makeQuery(optHex(ECS_FROM_CLIENT))), mkSettings({ use_client_ip: false, ipv4_cidr: "nonsense" }));
  assert.strictEqual(bad.ecs, undefined);
  assert.strictEqual(readOpt(bad.queryRaw)!.options[8], OPT_OUT);
}

// ── 6. Cache scope ───────────────────────────────────────────────────────────
function testCacheScope() {
  assert.strictEqual(ecsCacheScope(req("113.161.5.10")), ecsCacheScope(req("113.161.5.200")), "same /24 shares a cache entry");
  assert.notStrictEqual(ecsCacheScope(req("113.161.5.10")), ecsCacheScope(req("1.2.3.4")), "different subnets must not share");
  assert.strictEqual(ecsCacheScope(req("::ffff:113.161.5.10")), ecsCacheScope(req("113.161.5.10")));
  assert.strictEqual(ecsCacheScope(req("2405:4800:1:2::1")), ecsCacheScope(req("2405:4800:1:ffff::9")));
  assert.strictEqual(ecsCacheScope(req("10.0.0.1")), "none");
}

// ── 7. Robustness against malformed packets ──────────────────────────────────
function testMalformed() {
  const good = makeQuery(optHex(COOKIE));
  for (let n = 0; n < good.length; n++) {
    const cut = good.slice(0, n);
    assert.doesNotThrow(() => injectEcsIntoQuery(cut, "1.2.3.0/24"), `truncated at ${n}`);
    assert.doesNotThrow(() => stripEcsFromQuery(cut), `truncated at ${n}`);
  }
  // garbled option list (length overruns RDATA): the broken tail is dropped, ECS still injected cleanly
  const garbled = makeQuery(optHex("0008 00ff 0001"));
  const o = readOpt(injectEcsIntoQuery(garbled, "1.2.3.0/24"))!;
  assert.strictEqual(o.options[8], "00011800010203");
}

// ── 8. Opt-out on plain queries and ECS removal from responses ───────────────
function testOptOutAndResponse() {
  // Client without EDNS + ECS disabled: an OPT with the /0 opt-out is added (upstream must not add its own ECS)
  const plain = makeQuery();
  const r = applyEcs(req("5.6.7.8"), mkQuery(plain), mkSettings({ enabled: false }));
  const o = readOpt(r.queryRaw)!;
  assert.strictEqual(o.arCount, 1);
  assert.strictEqual(o.options[8], OPT_OUT);
  assert.strictEqual(hex(r.queryRaw.slice(12, plain.length)), hex(plain.slice(12)), "question untouched");
  // Idempotent
  assert.strictEqual(hex(disableEcsInQuery(r.queryRaw)), hex(r.queryRaw));

  // Response: an upstream (e.g. Google) returns ECS with scope -> removed, rest of OPT intact.
  // Response = header(QR,AN=1,AR=1) + question + answer(a.com A 1.2.3.4 via pointer) + OPT[ECS scope 24, cookie]
  const resp = H(`1234 8180 0001 0001 0000 0001 01 61 03 636f6d 00 0001 0001
    c00c 0001 0001 0000003c 0004 01020304
    ${optHex("0008 0007 0001 18 18 010203", COOKIE)}`);
  const stripped = stripEcsFromResponse(resp);
  const so = readOpt(stripped)!;
  assert.strictEqual(so.options[8], undefined, "ECS removed from response");
  assert.strictEqual(so.options[10], "1122334455667788", "other options kept");
  assert.strictEqual(so.ttl, "00008000");
  // Answer section byte-identical
  assert.strictEqual(hex(stripped.slice(0, resp.length - 11 - 4 - 7 - 4 - 12)), hex(resp.slice(0, resp.length - 11 - 4 - 7 - 4 - 12)));
  // Response without ECS is returned as-is
  const clean = H(`1234 8180 0001 0000 0000 0000 01 61 03 636f6d 00 0001 0001`);
  assert.strictEqual(stripEcsFromResponse(clean), clean);
}

// ── 9. Cloudflare Gateway: no-ECS endpoint while Send ECS is off ─────────────
function testGatewayUpstream() {
  const off = (u: string) => resolveEcsUpstreamUrl(u, false);
  assert.strictEqual(off("https://bu0eg1tdzu.cloudflare-gateway.com/dns-query"), "https://no-ecs.cloudflare-gateway.com/dns-query");
  assert.strictEqual(off("tls://bu0eg1tdzu.cloudflare-gateway.com"), "tls://no-ecs.cloudflare-gateway.com");
  assert.strictEqual(off("tls://BU0EG1TDZU.cloudflare-gateway.com:853"), "tls://no-ecs.cloudflare-gateway.com:853");
  assert.strictEqual(off("https://no-ecs.cloudflare-gateway.com/dns-query"), "https://no-ecs.cloudflare-gateway.com/dns-query");
  // ECS on -> the user's own location is used untouched
  assert.strictEqual(resolveEcsUpstreamUrl("https://bu0eg1tdzu.cloudflare-gateway.com/dns-query", true), "https://bu0eg1tdzu.cloudflare-gateway.com/dns-query");
  // Anything else is never rewritten
  for (const u of [
    "https://dns.google/dns-query",
    "tls://dns.adguard-dns.com",
    "https://cloudflare-gateway.com/dns-query",
    "https://a.b.cloudflare-gateway.com/dns-query",
    "https://evilcloudflare-gateway.com/dns-query",
    "https://bu0eg1tdzu.cloudflare-gateway.com.evil.test/dns-query",
    "https://x@bu0eg1tdzu.cloudflare-gateway.com/dns-query",
    "sdns://AgcAAAAAAAAA",
    "tcp://9.9.9.11:9953"
  ]) assert.strictEqual(off(u), u, u);
}

const tests = { testMapped, testDisabledStrips, testPreserveEdns, testAppendNoOpt, testClientIp, testCustom, testCacheScope, testMalformed, testOptOutAndResponse, testGatewayUpstream };
for (const [name, fn] of Object.entries(tests)) {
  fn();
  console.log(`✓ ${name}`);
}
console.log("ECS tests passed");
