import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { handleProfileRulesRequest } from "../src/api/profiles/rules";

// Minimal D1 emulation on top of node:sqlite
function makeD1(sqlite: DatabaseSync): any {
  const stmt = (sql: string, args: any[] = []) => ({
    bind: (...a: any[]) => stmt(sql, a),
    run: async () => { const r: any = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    __exec: () => { const r: any = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (list: any[]) => list.map((s) => s.__exec()) };
}

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`
  CREATE TABLE rules (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL, type TEXT NOT NULL, pattern TEXT NOT NULL,
    v_a TEXT, v_aaaa TEXT, v_txt TEXT, v_cname TEXT, created_at INTEGER, include_subdomains INTEGER DEFAULT 0);
`);
const env: any = { DB: makeD1(sqlite) };
const pending: Promise<any>[] = [];
const ctx: any = { waitUntil: (p: Promise<any>) => { pending.push(Promise.resolve(p)); }, passThroughOnException() {} };
const user: any = { id: "u1" };

const call = (method: string, body?: any) =>
  handleProfileRulesRequest(new Request("http://x/api/profiles/p1/rules", { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    env, user, "p1", [], ctx);
const rows = () => sqlite.prepare("SELECT * FROM rules ORDER BY id").all() as any[];

const COCCOC = "/^((update|afl|afdk|metrics|new-tab|qc-static|qc|s\\.qc)\\.coccoc\\.com|coccoc\\.telemetry\\.eyeo\\.com|qccoccocmedia\\.vn|video\\.comedia\\.coccoc\\.com)$/";

async function main() {
  // POST single: regex stored verbatim, domain lowercased
  let r = await call("POST", { type: "BLOCK", pattern: COCCOC });
  assert.strictEqual(r.status, 201);
  r = await call("POST", { type: "BLOCK", pattern: "  ||ADS*.Example.COM^  " });
  assert.strictEqual(r.status, 201);
  r = await call("POST", { type: "ALLOW", pattern: "/^\\S+\\.GOOD\\.com$/" });
  assert.strictEqual(r.status, 201);
  const stored = rows().map((x) => x.pattern);
  assert.deepStrictEqual(stored, [COCCOC, "||ads*.example.com^", "/^\\S+\\.GOOD\\.com$/"]);
  console.log("✓ POST: regex stored verbatim (case kept), domain pattern trimmed+lowercased");

  // validation -> 400
  for (const bad of ["/[/", "/(a+)+$/", "", "   ", "||", "/" + "a".repeat(600) + "/"]) {
    r = await call("POST", { type: "BLOCK", pattern: bad });
    assert.strictEqual(r.status, 400, `POST ${JSON.stringify(bad.slice(0, 15))} should be 400, got ${r.status}`);
  }
  assert.strictEqual(rows().length, 3);
  console.log("✓ POST: invalid / unsafe / empty patterns -> 400, nothing inserted");

  // duplicates (case-insensitive) -> 400
  r = await call("POST", { type: "BLOCK", pattern: "||ADS*.EXAMPLE.COM^" });
  assert.strictEqual(r.status, 400);
  r = await call("POST", { type: "BLOCK", pattern: COCCOC });
  assert.strictEqual(r.status, 400);
  console.log("✓ POST: duplicate detection (domain + regex)");

  // PUT update: valid, invalid, duplicate
  const id2 = rows()[1].id;
  r = await call("PUT", { id: id2, type: "BLOCK", pattern: "||ads*.example.org^" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(rows()[1].pattern, "||ads*.example.org^");
  r = await call("PUT", { id: id2, type: "BLOCK", pattern: "/[/" });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(rows()[1].pattern, "||ads*.example.org^");
  r = await call("PUT", { id: id2, type: "BLOCK", pattern: COCCOC });
  assert.strictEqual(r.status, 400);
  r = await call("PUT", { id: rows()[0].id, type: "ALLOW", pattern: COCCOC }); // same rule, changing type only
  assert.strictEqual(r.status, 200);
  assert.strictEqual(rows()[0].type, "ALLOW");
  console.log("✓ PUT: update ok, invalid -> 400 (row unchanged), duplicate -> 400, type change ok");

  // Bulk: mix of valid / invalid / dupes / existing
  r = await call("POST", [
    { type: "BLOCK", pattern: "/^bulk\\d+\\.net$/" },
    { type: "BLOCK", pattern: "||bulk*.com^" },
    { type: "BLOCK", pattern: "/[/" },                 // invalid regex -> skipped
    { type: "BLOCK", pattern: "/(a+)+$/" },            // unsafe -> skipped
    { type: "BLOCK", pattern: "||BULK*.COM^" },        // dup of earlier (case-insens.) -> skipped
    { type: "BLOCK", pattern: "||ads*.example.org^" }, // already in DB -> skipped
    { type: "NOPE", pattern: "x.com" },                // bad type -> skipped
    { type: "REDIRECT", pattern: "*.redir.test", v_a: "1.2.3.4" },
  ]);
  assert.strictEqual(r.status, 201);
  const body: any = await r.json();
  assert.strictEqual(body.count, 3, `bulk inserted ${body.count}`);
  assert.deepStrictEqual(rows().slice(3).map((x) => x.pattern), ["/^bulk\\d+\\.net$/", "||bulk*.com^", "*.redir.test"]);
  console.log("✓ Bulk: 3 valid inserted; invalid/unsafe/duplicate/bad-type skipped");

  // GET + DELETE
  r = await call("GET");
  assert.strictEqual(((await r.json()) as any[]).length, 6);
  r = await call("DELETE", { id: rows()[5].id });
  assert.strictEqual(r.status, 204);
  assert.strictEqual(rows().length, 5);
  console.log("✓ GET / DELETE");

  // Cache clear hook fired without throwing
  const settled = await Promise.allSettled(pending);
  const failed = settled.filter((s) => s.status === "rejected");
  assert.strictEqual(failed.length, 0, "clearCache rejected: " + JSON.stringify(failed.map((f: any) => String(f.reason))));
  console.log(`✓ cache clear hook ran ${pending.length}x without error`);

  console.log("\nALL CUSTOM RULE API TESTS PASSED");
}
main().catch((e) => { console.error("TEST FAILED:", e); process.exit(1); });
