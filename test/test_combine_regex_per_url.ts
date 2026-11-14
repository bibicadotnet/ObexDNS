/// <reference types="node" />
import assert from "node:assert";
import { combineAndPromote } from "../src/utils/sync/combine";
import { initNodeGlobals } from "../src/serverfull/cache";
import type { Env } from "../src/types";

// MAX_REGEX_RULES is a per-URL limit (enforced at sync time). Merging several lists into a
// profile must keep every pattern and must not silently cut the total.
async function main() {
  initNodeGlobals();

  const listPatterns: Record<number, any[]> = {
    1: Array.from({ length: 8 }, (_, i) => ({ pattern: `^a${i}$`, apexIndex: "a.com", raw: `/a${i}/` })),
    2: Array.from({ length: 8 }, (_, i) => ({ pattern: `^b${i}$`, apexIndex: "b.com", raw: `/b${i}/` })),
  };
  let savedProfilePayload: any = null;

  const db: any = {
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        first: async () => {
          if (sql.includes("FROM list_adguard_rules")) {
            return { payload: JSON.stringify({ exceptions: [], rewrites: {}, patterns: listPatterns[args[0]] || [] }) };
          }
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => {
          if (sql.includes("INTO profile_adguard_rules")) savedProfilePayload = JSON.parse(args[1]);
          return { success: true };
        },
      }),
    }),
  };

  const env = { DB: db, MAX_REGEX_RULES: 10 } as unknown as Env; // per-URL limit 10, each list has 8
  const listModel: any = {
    getLists: async () => [
      { id: 1, url: "http://93.184.216.34/a.txt", enabled: 1 },
      { id: 2, url: "http://93.184.216.34/b.txt", enabled: 1 },
    ],
    updateListUpdatedAt: async () => true,
  };
  const listBloomModel: any = { getListBloom: async () => null };
  const profileBloomModel: any = { clearProfileBlooms: async () => true, upsertProfileBloom: async () => true };
  const profileModel: any = { updateListUpdatedAt: async () => true };
  const ctx: any = { waitUntil: (p: Promise<any>) => { p.catch(() => {}); } };

  await combineAndPromote("prof", listModel, listBloomModel, profileBloomModel, profileModel, ctx, 1, 1000, 0.0001, env);

  assert.ok(savedProfilePayload, "profile rules must be saved");
  assert.strictEqual(
    savedProfilePayload.patterns.length,
    16,
    `merge must keep all 16 patterns (got ${savedProfilePayload.patterns.length}); MAX_REGEX_RULES is per URL, not per profile`
  );
  console.log("✓ combineAndPromote keeps all patterns from 2 lists (16 > MAX_REGEX_RULES=10)");
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
