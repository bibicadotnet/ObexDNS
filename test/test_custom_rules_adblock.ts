import assert from "node:assert";
import { DNSFilter } from "../src/lib/filtering";
import { pipelineFilter } from "../src/pipeline/filter";
import { Context, DNSQuery, ProfileSettings, Rule } from "../src/types";

const COCCOC = "/^((update|afl|afdk|metrics|new-tab|qc-static|qc|s\\.qc)\\.coccoc\\.com|coccoc\\.telemetry\\.eyeo\\.com|qccoccocmedia\\.vn|video\\.comedia\\.coccoc\\.com)$/";

let id = 0;
const rule = (type: Rule["type"], pattern: string, extra: Partial<Rule> = {}): Rule =>
  ({ id: ++id, profile_id: "p1", type, pattern: DNSFilter.normalizePattern(pattern), ...extra } as Rule);

const ctx: Context = {
  profileId: "p1", startTime: Date.now(), env: {} as any,
  ctx: { waitUntil: () => {}, passThroughOnException: () => {} } as any,
};
const settings: ProfileSettings = {
  upstream: ["https://cloudflare-dns.com/dns-query"], ecs: { enabled: false, use_client_ip: false },
  default_policy: "ALLOW", log_retention_days: 0,
};
const req = new Request("http://127.0.0.1/dns-query");
const run = (rules: Rule[], name: string, type: any = "A") =>
  pipelineFilter.match(req, { name, type, raw: new Uint8Array() } as DNSQuery, ctx, settings, rules, undefined, () => {});

async function main() {
  // --- BLOCK with the user's regex
  const block = [rule("BLOCK", COCCOC)];
  for (const d of ["update.coccoc.com", "s.qc.coccoc.com", "video.comedia.coccoc.com", "qccoccocmedia.vn", "coccoc.telemetry.eyeo.com", "UPDATE.COCCOC.COM."]) {
    const r = await run(block, d);
    assert.strictEqual(r?.action, "BLOCK", `${d} should be blocked`);
  }
  for (const d of ["coccoc.com", "x.update.coccoc.com", "example.com", "google.com"]) {
    assert.strictEqual(await run(block, d), null, `${d} should NOT be blocked`);
  }
  console.log("✓ BLOCK + user regex (pipeline path)");

  // --- BLOCK: wildcard / || / exact semantics through the pipeline
  const mixed = [
    rule("BLOCK", "||q3ei4f.rophim*^"), rule("BLOCK", "||ads*.example.com^"), rule("BLOCK", "*-ad.net"),
    rule("BLOCK", "exact.com"), rule("BLOCK", "||sub.com^"), rule("BLOCK", "*.star.com"), rule("BLOCK", "legacy.org", { include_subdomains: true }),
  ];
  const expectBlock: Record<string, boolean> = {
    "q3ei4f.rophim123.net": true, "a.q3ei4f.rophimx.com": true, "rophim.com": false,
    "ads7.example.com": true, "example.com": false, "x-ad.net": true, "x-ad.net.vn": false,
    "exact.com": true, "a.exact.com": false, "sub.com": true, "deep.a.sub.com": true, "notsub.com": false,
    "star.com": true, "a.star.com": true, "legacy.org": true, "a.legacy.org": true,
  };
  for (const [d, exp] of Object.entries(expectBlock)) {
    const r = await run(mixed, d);
    assert.strictEqual(r?.action === "BLOCK", exp, `${d} expected block=${exp}, got ${r?.action}`);
  }
  console.log("✓ wildcard / || / exact / *. / include_subdomains semantics (pipeline path)");

  // --- Precedence: ALLOW beats BLOCK (regex block, regex allow narrows it)
  const allowRule = rule("ALLOW", "/^update\\.coccoc\\.com$/");
  const both = [rule("BLOCK", COCCOC), allowRule];
  const allowed = await run(both, "update.coccoc.com");
  assert.ok(allowed && allowed.action !== "BLOCK", "ALLOW regex must override BLOCK regex");
  assert.strictEqual((await run(both, "afl.coccoc.com"))?.action, "BLOCK");
  console.log("✓ ALLOW regex overrides BLOCK regex, others still blocked");

  // --- REDIRECT with wildcard
  const redirect = [rule("REDIRECT", "||redir*.test.com^", { v_a: "10.0.0.1" })];
  const rr = await run(redirect, "redir9.test.com", "A");
  assert.strictEqual(rr?.action, "REDIRECT");
  assert.strictEqual(await run(redirect, "other.test.com"), null);
  console.log("✓ REDIRECT with wildcard");

  // --- Compile cache: same array reused, rules mutated copy gets fresh compile
  const arr = [rule("BLOCK", "||cache.com^")];
  assert.strictEqual((await run(arr, "a.cache.com"))?.action, "BLOCK");
  assert.strictEqual((await run(arr, "a.cache.com"))?.action, "BLOCK");
  assert.strictEqual(await run([rule("BLOCK", "other.com")], "a.cache.com"), null);
  console.log("✓ compile cache stable across calls; new arrays compile independently");

  // --- Invalid / unsafe patterns never match and never throw
  for (const bad of ["/[/", "/(a+)+$/", "/" + "a".repeat(600) + "/", "||", "^", "$important"]) {
    assert.strictEqual(await run([rule("BLOCK", bad)], "aaaa.com"), null, `bad pattern ${bad.slice(0, 20)} must not match`);
    assert.ok(DNSFilter.validatePattern(bad) !== null, `validate should reject ${bad.slice(0, 20)}`);
  }
  assert.strictEqual(DNSFilter.validatePattern(COCCOC), null);
  console.log("✓ invalid / unsafe patterns rejected, harmless at match time");

  // --- Regex case must survive normalization (\S \D \W \B)
  assert.strictEqual(DNSFilter.normalizePattern("/^\\S+\\.COM$/"), "/^\\S+\\.COM$/");
  assert.strictEqual(DNSFilter.normalizePattern("  ||ADS.Com^ "), "||ads.com^");
  assert.strictEqual((await run([rule("BLOCK", "/^\\D+\\.net$/")], "abc.net"))?.action, "BLOCK");
  assert.strictEqual(await run([rule("BLOCK", "/^\\D+\\.net$/")], "123.net"), null);
  console.log("✓ regex escapes preserved (no lowercasing of \\D \\S \\W)");

  // --- Backward compatibility with the old DNSFilter.isMatch contract
  const legacy = (p: string, inc = false) => ({ type: "BLOCK", pattern: p, include_subdomains: inc } as Rule);
  assert.ok(DNSFilter.isMatch("example.com", legacy("example.com")));
  assert.ok(!DNSFilter.isMatch("a.example.com", legacy("example.com")));
  assert.ok(DNSFilter.isMatch("a.b.example.com", legacy("example.com", true)));
  assert.ok(DNSFilter.isMatch("sub.adguard-syntax.com", legacy("||adguard-syntax.com^")));
  assert.ok(DNSFilter.isMatch("deep.sub.wildcard.com", legacy("*.wildcard.com")));
  assert.ok(!DNSFilter.isMatch("notwildcard.com", legacy("*.wildcard.com")));
  console.log("✓ backward compatible with previous matching behaviour");

  // --- Performance sanity: 2000 rules (100 regex), 200k queries
  const big: Rule[] = [];
  for (let i = 0; i < 1500; i++) big.push(rule("BLOCK", `||blk${i}.example.com^`));
  for (let i = 0; i < 400; i++) big.push(rule("BLOCK", `exact${i}.test.com`));
  for (let i = 0; i < 100; i++) big.push(rule("BLOCK", `/^r${i}-[a-z]+\\.cdn\\.net$/`));
  const t0 = performance.now();
  for (let i = 0; i < 200000; i++) DNSFilter.findByType(big, "BLOCK", `www.site${i % 977}.org`);
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `too slow: ${ms}ms`);
  assert.ok(DNSFilter.findByType(big, "BLOCK", "r42-abc.cdn.net"));
  assert.ok(DNSFilter.findByType(big, "BLOCK", "x.blk1499.example.com"));
  console.log(`✓ performance: 200k lookups over 2000 rules in ${ms.toFixed(0)} ms`);

  console.log("\nALL CUSTOM RULE TESTS PASSED");
}
main().catch((e) => { console.error("TEST FAILED:", e); process.exit(1); });
