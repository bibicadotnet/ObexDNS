/// <reference types="node" />
import assert from "node:assert";
import { syncSingleSystemList } from "../src/utils/sync/systemListSync";
import type { Env } from "../src/types";

async function run(storedSyncError: string | null) {
  const original = globalThis.fetch;
  const runs: { sql: string; args: any[] }[] = [];
  const row = { id: 7, url: "http://93.184.216.34/sys.txt", etag: '"abc"', last_modified: null, sync_error: storedSyncError };
  const db: any = {
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        first: async () => {
          if (sql.includes("FROM system_lists WHERE id")) return row;
          if (sql.includes("system_list_adguard_rules")) return { present: 1 };
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => { runs.push({ sql, args }); return { success: true }; },
      }),
    }),
  };
  globalThis.fetch = (async () => new Response(null, { status: 304, headers: { ETag: '"abc"' } })) as any;
  try {
    const res = await syncSingleSystemList(7, { DB: db } as unknown as Env, false);
    return { res, runs };
  } finally { globalThis.fetch = original; }
}

async function main() {
  // 1. limit warning is kept on profile rows (and left on system_lists) after a 304
  let { res, runs } = await run("limit:domains=500000");
  assert.strictEqual(res.notModified, true);
  assert.strictEqual(res.syncError, "limit:domains=500000");
  const lists = runs.find((r) => r.sql.includes("UPDATE lists SET"))!;
  assert.strictEqual(lists.args[1], "limit:domains=500000", "profile rows must keep the warning");
  const meta = runs.find((r) => r.sql.includes("UPDATE system_lists SET"))!;
  const idx = meta.sql.includes("sync_error = ?") ? meta.args[meta.sql.match(/(\w+ = \?)/g)!.indexOf("sync_error = ?")] : "limit:domains=500000";
  assert.strictEqual(idx, "limit:domains=500000", "system_lists.sync_error must stay as the warning");
  console.log("✓ system list: limit warning kept on 304 (profile rows + system_lists)");

  // 2. a stale real error is cleared everywhere after a successful 304
  ({ res, runs } = await run("HTTP error! Status: 500"));
  const lists2 = runs.find((r) => r.sql.includes("UPDATE lists SET"))!;
  assert.strictEqual(lists2.args[1], null, "profile rows: real error cleared");
  const meta2 = runs.find((r) => r.sql.includes("UPDATE system_lists SET"))!;
  assert.ok(meta2.sql.includes("sync_error = ?"), "system_lists.sync_error must also be reset, else the next profile sync copies the stale error back");
  const pos = meta2.sql.match(/(\w+ = \?)/g)!.indexOf("sync_error = ?");
  assert.strictEqual(meta2.args[pos], null);
  console.log("✓ system list: stale real error cleared on 304 (profile rows + system_lists)");
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
