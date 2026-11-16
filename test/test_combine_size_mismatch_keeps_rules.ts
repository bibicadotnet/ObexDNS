/// <reference types="node" />
import assert from "node:assert";
import { combineAndPromote } from "../src/utils/sync/combine";
import { initNodeGlobals } from "../src/serverfull/cache";
import { FingerprintSetBuilder, FingerprintSet } from "../src/utils/fingerprintSet";
import type { Env } from "../src/types";

async function main() {
  initNodeGlobals();
  const b1 = new FingerprintSetBuilder(); b1.addPipePipe("list1.example.com");
  const s1 = await b1.build();

  const b2 = new FingerprintSetBuilder(); b2.addPipePipe("list2.example.com");
  const s2 = await b2.build();

  const filters: Record<number, ArrayBuffer> = {
    1: s1.toUint8Array().buffer as ArrayBuffer,
    2: s2.toUint8Array().buffer as ArrayBuffer,
  };
  const rules: Record<number, any> = {
    1: { exceptions: [{ domain: "allowed.example.com", includeSubdomains: true, raw: "@@||allowed.example.com^" }], rewrites: { "r.example.com": { type: "A", value: "1.2.3.4", includeSubdomains: false, raw: "r" } }, patterns: [{ pattern: "^a$", apexIndex: "a.com", raw: "/a/" }] },
    2: { exceptions: [], rewrites: {}, patterns: [{ pattern: "^b$", apexIndex: "b.com", raw: "/b/" }] },
  };
  let savedRules: any = null; let savedFilter: Uint8Array | null = null; let cleared = false;
  const db: any = { prepare: (sql: string) => {
    const stmt = {
      first: async (...a: any[]) => sql.includes("FROM list_adguard_rules") ? { payload: JSON.stringify(rules[a[0]]) } : null,
      all: async () => ({ results: [] }),
      run: async (...a: any[]) => { if (sql.includes("INTO profile_adguard_rules")) savedRules = JSON.parse(a[1]); return { success: true }; },
    };
    return { bind: (...a: any[]) => ({
      first: async () => stmt.first(...a),
      all: stmt.all,
      run: async () => stmt.run(...a),
    }), ...stmt };
  } };
  const env = { DB: db } as unknown as Env;
  const listModel: any = { getLists: async () => [{ id: 1, url: "http://93.184.216.34/1.txt", enabled: 1 }, { id: 2, url: "http://93.184.216.34/2.txt", enabled: 1 }] };
  const listFilterModel: any = { getListFilter: async (id: number) => filters[id], getListFilterHeader: async (id: number) => new Uint8Array(filters[id]).slice(0, 16) };
  const profileFilterModel: any = { clearProfileFilters: async () => { cleared = true; return true; }, upsertProfileFilter: async (_p: string, buf: ArrayBuffer) => { savedFilter = new Uint8Array(buf); return true; } };
  const profileModel: any = { updateListUpdatedAt: async () => true };
  const ctx: any = { waitUntil: (p: Promise<any>) => { p.catch(() => {}); } };

  await combineAndPromote("prof", listModel, listFilterModel, profileFilterModel, profileModel, ctx, 1, undefined, undefined, env);

  assert.ok(savedRules, "profile rules must be saved");
  assert.strictEqual(savedRules.exceptions.length, 1, "whitelist exception must survive");
  assert.ok(savedRules.rewrites["r.example.com"], "rewrite must survive");
  assert.strictEqual(savedRules.patterns.length, 2, "patterns of both lists must be merged");
  assert.ok(savedFilter, "profile filter must be created from merged sets");
  const merged = FingerprintSet.fromUint8Array(savedFilter!);
  assert.strictEqual(merged.testPipePipe("list1.example.com"), true);
  assert.strictEqual(merged.testPipePipe("list2.example.com"), true);
  console.log("✓ All lists regardless of size are merged cleanly with FingerprintSet");
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message || e); process.exit(1); });
