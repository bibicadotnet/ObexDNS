/// <reference types="node" />
import assert from "node:assert";
import { syncSingleList } from "../src/utils/sync/singleListSync";
import type { Env } from "../src/types";

// A list truncated by MAX_LIST_DOMAINS stores its ETag. The next (non-forced) sync gets 304 Not Modified.
// The "limit:..." warning must survive that 304, otherwise the user only sees it until the next cron tick.
async function main() {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(null, { status: 304, headers: { ETag: '"abc"' } })) as any;
    let savedErr: string | null | undefined = "unset";
    const listModel: any = {
      updateListSyncStatus: async (_i: any, _n: any, _e: any, err: string | null) => { savedErr = err; return true; },
    };
    const listFilterModel: any = { getListFilterHeader: async () => null };
    // hasListRules is true -> cache headers are used
    const dbObj = { first: async () => ({ x: 1 }), all: async () => ({ results: [] }), run: async () => ({ success: true }) };
    const db: any = { prepare: () => ({ bind: () => dbObj, ...dbObj }) };
    const env = { DB: db } as unknown as Env;
    const res = await syncSingleList(
      "prof",
      { id: 1, url: "http://93.184.216.34/l.txt", etag: '"abc"', last_modified: null, sync_error: "limit:domains=500000" } as any,
      env, listModel, listFilterModel, 1, false
    );
    assert.strictEqual(res.notModified, true, "expected the 304 path");
    assert.strictEqual(savedErr, "limit:domains=500000", `warning wiped by 304 (saved: ${savedErr})`);
    console.log("✓ limit warning survives 304 Not Modified");
  } finally { globalThis.fetch = original; }
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
