/// <reference types="node" />
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { parseSyncStatus, limitWarningText } from "../web/src/views/FilteringView/syncStatus";
import { encodeLimitWarnings } from "../src/utils/sync/syncWarnings";

// fake i18next `t`: returns key + interpolated limit
const t: any = (key: string, opts: any) => `${key}|${opts?.limit}`;

assert.deepStrictEqual(parseSyncStatus(null), { warnings: [], error: null });
assert.deepStrictEqual(parseSyncStatus(""), { warnings: [], error: null });
assert.deepStrictEqual(parseSyncStatus("limit:domains=500000"), { warnings: [{ kind: "domains", limit: 500000 }], error: null });
assert.deepStrictEqual(
  parseSyncStatus("limit:bytes=26214400;limit:regex=1000"),
  { warnings: [{ kind: "bytes", limit: 26214400 }, { kind: "regex", limit: 1000 }], error: null }
);
// real errors (and legacy English messages stored by older syncs) stay raw errors
assert.deepStrictEqual(parseSyncStatus("HTTP error! Status: 404 Not Found"), { warnings: [], error: "HTTP error! Status: 404 Not Found" });
assert.deepStrictEqual(
  parseSyncStatus("List truncated at 25 MB: Maximum list size reached."),
  { warnings: [], error: "List truncated at 25 MB: Maximum list size reached." }
);
// a mix of valid code and garbage is treated as a raw error, never half-parsed
assert.strictEqual(parseSyncStatus("limit:domains=5;oops").error, "limit:domains=5;oops");
console.log("✓ parseSyncStatus: warnings vs real errors");

// backend encoder -> frontend parser round trip keeps env-provided numbers
const enc = encodeLimitWarnings({ bytes: 1048576, domains: 123, regex: 7 })!;
const parsed = parseSyncStatus(enc);
assert.deepStrictEqual(parsed.warnings.map((w) => w.limit), [1048576, 123, 7]);
console.log("✓ backend encode -> frontend parse round trip");

// message text: bytes shown in MB, counts as numbers; keys per kind
assert.strictEqual(limitWarningText(t, { kind: "bytes", limit: 25 * 1024 * 1024 }), "filtering.limitWarnBytes|25");
assert.strictEqual(limitWarningText(t, { kind: "domains", limit: 500 }), "filtering.limitWarnDomains|500");
assert.strictEqual(limitWarningText(t, { kind: "regex", limit: 1000 }), `filtering.limitWarnRegex|${(1000).toLocaleString()}`);
console.log("✓ limitWarningText: key per kind, limit interpolated");

// all locales define the 5 keys with {{limit}} where needed
const dir = path.join(process.cwd(), "web/src/i18n/locales");
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const f1 = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).filtering;
  for (const k of ["statusTruncated", "limitWarnTitle", "limitWarnBytes", "limitWarnDomains", "limitWarnRegex"]) {
    assert.ok(typeof f1[k] === "string" && f1[k].length > 0, `${f} missing filtering.${k}`);
  }
  for (const k of ["limitWarnBytes", "limitWarnDomains", "limitWarnRegex"]) {
    assert.ok(f1[k].includes("{{limit}}"), `${f} filtering.${k} must contain {{limit}}`);
  }
}
console.log("✓ all 10 locales have the 5 keys, {{limit}} placeholder present");
console.log("\nALL SYNC STATUS PARSER TESTS PASSED");
