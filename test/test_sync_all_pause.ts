import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { syncAllListsForProfile, _resetInFlightSyncsForTesting } from "../src/utils/sync/orchestrator";

// D1 emulation on node:sqlite with the project's real migrations
const sqlite = new DatabaseSync(":memory:");
for (const f of readdirSync("migrations").filter((x) => x.endsWith(".sql")).sort()) {
  try { sqlite.exec(readFileSync(`migrations/${f}`, "utf8")); } catch (e: any) { /* a few migrations are libsql-specific; ignore */ }
}
const toArg = (v: any) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
const fromRow = (r: any) => { const o: any = {}; for (const k of Object.keys(r)) { const v = r[k]; o[k] = v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v; } return o; };
const stmt = (sql: string, args: any[] = []): any => ({
  bind: (...a: any[]) => stmt(sql, a),
  run: async () => { const r: any = sqlite.prepare(sql).run(...args.map(toArg)); return { success: true, meta: { changes: Number(r.changes) } }; },
  all: async () => ({ results: sqlite.prepare(sql).all(...args.map(toArg)).map(fromRow) }),
  first: async () => { const r: any = sqlite.prepare(sql).get(...args.map(toArg)); return r ? fromRow(r) : null; },
  raw: async () => sqlite.prepare(sql).all(...args.map(toArg)).map((r: any) => Object.values(fromRow(r))),
  __exec: () => { const r: any = sqlite.prepare(sql).run(...args.map(toArg)); return { success: true, meta: { changes: Number(r.changes) } }; },
});
const DB: any = { prepare: (s: string) => stmt(s), batch: async (l: any[]) => l.map((x) => x.__exec()), exec: async (s: string) => sqlite.exec(s) };
const env: any = { DB, MAX_SYNC_DOMAINS: 10000, BLOOM_FALSE_POSITIVE_RATE: 0.001, MAX_LIST_DOMAINS: 10000, SYNC_YIELD_SLEEP_MS: 1, LIST_FETCH_MAX_RETRIES: 0 };
const ctx: any = { waitUntil: (p: any) => p?.catch?.(() => {}), passThroughOnException() {} };

const tables = (sqlite.prepare("select name from sqlite_master where type='table'").all() as any[]).map((t) => t.name);
console.log("tables:", tables.filter((t) => /list|profile|bloom|adguard/.test(t)).join(", "));

const PID = "prof_pause";
const cols = (t: string) => (sqlite.prepare(`pragma table_info(${t})`).all() as any[]).map((c) => c.name);
function seed(urls: string[]) {
  sqlite.exec("delete from lists; delete from profiles;");
  const pc = cols("profiles");
  const pvals: Record<string, any> = { id: PID, name: "t", settings: "{}", created_at: 1, updated_at: 1, list_updated_at: 0, user_id: "u1" };
  const use = pc.filter((c) => c in pvals);
  sqlite.prepare(`insert into profiles (${use.join(",")}) values (${use.map(() => "?").join(",")})`).run(...use.map((c) => pvals[c]));
  const lc = cols("lists");
  urls.forEach((url, i) => {
    const v: Record<string, any> = { profile_id: PID, name: `L${i}`, url, enabled: 1, last_synced_at: 0, etag: '"abc"', last_modified: null, description: "", created_at: 1, updated_at: 1 };
    const u = lc.filter((c) => c in v);
    sqlite.prepare(`insert into lists (${u.join(",")}) values (${u.map(() => "?").join(",")})`).run(...u.map((c) => v[c]));
  });
}

const urls = ["http://93.184.216.34/a.txt", "http://93.184.216.35/b.txt", "http://93.184.216.36/c.txt"];
const realFetch = globalThis.fetch;
const body = "||ads.example.com^\n||track.example.net^\n";

async function timed(label: string, handler: (url: string, init: any) => Response, reseed = true) {
  _resetInFlightSyncsForTesting();
  if (reseed) seed(urls);
  let inflight = 0, maxInflight = 0;
  (globalThis as any).fetch = async (input: any, init: any) => {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 20));
    inflight--;
    return handler(String(input), init);
  };
  const t0 = performance.now();
  await syncAllListsForProfile(PID, env, ctx, false);
  const ms = performance.now() - t0;
  console.log(`${label}: ${ms.toFixed(0)} ms, max concurrent downloads = ${maxInflight}`);
  return { ms, maxInflight };
}

async function main() {
  // First sync: real downloads (no etag usage because there is no stored Bloom yet) -> pause expected between lists
  const dl = await timed("3 lists, all REAL downloads", () => new Response(body, { status: 200, headers: { etag: '"v1"' } }));
  // Second sync: etag now stored + Bloom present -> conditional requests -> 304
  const nm = await timed("3 lists, all 304 Not Modified", (_u, init) => {
    const inm = init?.headers?.["If-None-Match"];
    return inm ? new Response(null, { status: 304, headers: { etag: inm } }) : new Response(body, { status: 200, headers: { etag: '"v1"' } });
  }, false);
  assert.strictEqual(dl.maxInflight, 1, "lists must be downloaded one at a time");
  assert.strictEqual(nm.maxInflight, 1, "lists must be checked one at a time");
  assert.ok(dl.ms >= 2000, `real downloads must still keep the 1s pause between lists (2 gaps) — got ${dl.ms.toFixed(0)} ms`);
  assert.ok(nm.ms < 1000, `304 lists must not sleep — got ${nm.ms.toFixed(0)} ms`);
  console.log("\n✓ real downloads: sequential + 1s pause kept;  ✓ 304: sequential, no pause");
  (globalThis as any).fetch = realFetch;
  process.exit(0);
}
main().catch((e) => { console.error("TEST FAILED:", e); process.exit(1); });
