/// <reference types="node" />
import assert from "node:assert";
import { combineAndPromote } from "../src/utils/sync/combine";
import { initNodeGlobals } from "../src/serverfull/cache";
import { BloomFilter } from "../src/utils/bloom";
import type { Env } from "../src/types";

// A list whose Bloom has another size (built before MAX_SYNC_DOMAINS / BLOOM_FALSE_POSITIVE_RATE changed) cannot be
// OR-merged. Only its Bloom may be left out: its whitelist exceptions, rewrites and regex patterns must still be merged.
async function main() {
  initNodeGlobals();
  const stale = BloomFilter.create(1000000, 0.0001); stale.addPipePipe("stale.example.com");
  const fresh = BloomFilter.create(2000000, 0.0001); fresh.addPipePipe("fresh.example.com");
  const blooms: Record<number, ArrayBuffer> = {
    1: stale.toUint8Array().buffer as ArrayBuffer,
    2: fresh.toUint8Array().buffer as ArrayBuffer,
  };
  const rules: Record<number, any> = {
    1: { exceptions: [{ domain: "allowed.example.com", includeSubdomains: true, raw: "@@||allowed.example.com^" }], rewrites: { "r.example.com": { type: "A", value: "1.2.3.4", includeSubdomains: false, raw: "r" } }, patterns: [{ pattern: "^a$", apexIndex: "a.com", raw: "/a/" }] },
    2: { exceptions: [], rewrites: {}, patterns: [{ pattern: "^b$", apexIndex: "b.com", raw: "/b/" }] },
  };
  let savedRules: any = null; let savedBloom: Uint8Array | null = null;
  const db: any = { prepare: (sql: string) => ({ bind: (...a: any[]) => ({
    first: async () => sql.includes("FROM list_adguard_rules") ? { payload: JSON.stringify(rules[a[0]]) } : null,
    all: async () => ({ results: [] }),
    run: async () => { if (sql.includes("INTO profile_adguard_rules")) savedRules = JSON.parse(a[1]); return { success: true }; },
  }) }) };
  const env = { DB: db } as unknown as Env;
  const listModel: any = { getLists: async () => [{ id: 1, url: "http://93.184.216.34/1.txt", enabled: 1 }, { id: 2, url: "http://93.184.216.34/2.txt", enabled: 1 }] };
  const listBloomModel: any = { getListBloom: async (id: number) => blooms[id] };
  const profileBloomModel: any = { clearProfileBlooms: async () => true, upsertProfileBloom: async (_p: string, buf: ArrayBuffer) => { savedBloom = new Uint8Array(buf); return true; } };
  const profileModel: any = { updateListUpdatedAt: async () => true };
  const ctx: any = { waitUntil: (p: Promise<any>) => { p.catch(() => {}); } };

  await combineAndPromote("prof", listModel, listBloomModel, profileBloomModel, profileModel, ctx, 1, 2000000, 0.0001, env);

  assert.ok(savedRules, "profile rules must be saved");
  assert.strictEqual(savedRules.exceptions.length, 1, "whitelist exception of the size-mismatched list must survive");
  assert.ok(savedRules.rewrites["r.example.com"], "rewrite of the size-mismatched list must survive");
  assert.strictEqual(savedRules.patterns.length, 2, "patterns of both lists must be merged");
  assert.ok(savedBloom, "profile Bloom must still be promoted from the lists that could be merged");
  const merged = BloomFilter.fromUint8Array(savedBloom!);
  assert.ok(merged.testPipePipe("fresh.example.com"), "compatible list is in the merged Bloom");
  assert.ok(!merged.testPipePipe("stale.example.com"), "the size-mismatched Bloom is left out");
  console.log("✓ size-mismatched list: only its Bloom is skipped; exceptions, rewrites and patterns are still merged");
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message || e); process.exit(1); });
