/// <reference types="node" />
import assert from "node:assert";
import { syncSingleList } from "../src/utils/sync/singleListSync";
import { encodeLimitWarnings } from "../src/utils/sync/syncWarnings";
import type { Env } from "../src/types";

/** Builds a fake list with `domains` blocking rules and `regex` regex rules. */
function buildList(domains: number, regex: number): string {
  const lines: string[] = ["! Title: Limit Test List"];
  for (let i = 0; i < domains; i++) lines.push(`||d${i}.example.com^`);
  for (let i = 0; i < regex; i++) lines.push(`/^ad${i}[0-9]+\\.google\\.com$/`);
  return lines.join("\n") + "\n";
}

async function run(payload: string, envOverrides: Partial<Env>) {
  const saved: { syncError: string | null; title: string | null | undefined } = { syncError: "unset", title: undefined };
  const listModel: any = {
    updateListSyncStatus: async (_id: number, _now: any, _en: any, syncError: string | null, _e: any, _l: any, title: any) => {
      saved.syncError = syncError ?? null;
      saved.title = title;
      return true;
    },
  };
  const listBloomModel: any = {
    getListBloomHeader: async () => null,
    upsertListBloom: async () => true,
    deleteListBloom: async () => true,
  };
  // Stream in small chunks like a real download (the fetcher drops a whole chunk that crosses MAX_LIST_BYTES)
  globalThis.fetch = (async () => {
    const bytes = new TextEncoder().encode(payload);
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 200) controller.enqueue(bytes.slice(i, i + 200));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/plain" } });
  }) as any;
  const env = { ...envOverrides } as Env; // no DB: skips system-list fast path and rule persistence
  const res = await syncSingleList("prof", { id: 1, url: "http://93.184.216.34/l.txt" }, env, listModel, listBloomModel, 1, true);
  return { res, saved };
}

async function main() {
  const originalFetch = globalThis.fetch;
  try {
    // encoder
    assert.strictEqual(encodeLimitWarnings({}), null);
    assert.strictEqual(encodeLimitWarnings({ regex: 5, bytes: 9, domains: 7 }), "limit:bytes=9;limit:domains=7;limit:regex=5");
    console.log("✓ encodeLimitWarnings: empty -> null, fixed order, values embedded");

    // 1. within all limits -> no warning, title kept
    let r = await run(buildList(50, 5), { MAX_LIST_DOMAINS: 100, MAX_REGEX_RULES: 10 });
    assert.strictEqual(r.res.syncError, null);
    assert.strictEqual(r.saved.syncError, null);
    assert.strictEqual(r.saved.title, "Limit Test List");
    console.log("✓ within limits: no warning");

    // 2. exactly at MAX_LIST_DOMAINS -> nothing dropped -> no warning
    r = await run(buildList(100, 0), { MAX_LIST_DOMAINS: 100 });
    assert.strictEqual(r.res.syncError, null);
    console.log("✓ exactly at MAX_LIST_DOMAINS: no false warning");

    // 3. over MAX_LIST_DOMAINS -> warning with the env value
    r = await run(buildList(101, 0), { MAX_LIST_DOMAINS: 100 });
    assert.strictEqual(r.res.syncError, "limit:domains=100");
    assert.strictEqual(r.saved.syncError, "limit:domains=100");
    assert.strictEqual(r.saved.title, "Limit Test List", "title must be kept when only a warning exists");
    console.log("✓ over MAX_LIST_DOMAINS: limit:domains=100 saved, title kept");

    // 3b. limit value follows env, not a hard-coded number
    r = await run(buildList(30, 0), { MAX_LIST_DOMAINS: 20 });
    assert.strictEqual(r.res.syncError, "limit:domains=20");
    console.log("✓ limit value follows env (20)");

    // 4. over MAX_REGEX_RULES (per URL) -> regex warning only
    r = await run(buildList(0, 12), { MAX_REGEX_RULES: 10 });
    assert.strictEqual(r.res.syncError, "limit:regex=10");
    console.log("✓ over MAX_REGEX_RULES: limit:regex=10");

    // 5. exactly at MAX_REGEX_RULES -> no warning
    r = await run(buildList(0, 10), { MAX_REGEX_RULES: 10 });
    assert.strictEqual(r.res.syncError, null);
    console.log("✓ exactly at MAX_REGEX_RULES: no false warning");

    // 6. over MAX_LIST_BYTES -> bytes warning with env value
    r = await run(buildList(500, 0), { MAX_LIST_BYTES: 600 });
    assert.strictEqual(r.res.syncError, "limit:bytes=600");
    console.log("✓ over MAX_LIST_BYTES: limit:bytes=600");

    // 7. bytes + domains together
    r = await run(buildList(500, 0), { MAX_LIST_BYTES: 4000, MAX_LIST_DOMAINS: 10 });
    assert.strictEqual(r.res.syncError, "limit:bytes=4000;limit:domains=10");
    console.log("✓ bytes + domains combined, stable order");

    // 8. fetch failure -> real error stays raw, title not touched
    globalThis.fetch = (async () => new Response("x", { status: 404, statusText: "Not Found" })) as any;
    const saved: any = {};
    await syncSingleList(
      "prof", { id: 1, url: "http://93.184.216.34/l.txt" }, {} as Env,
      { updateListSyncStatus: async (_a: any, _b: any, _c: any, e: any, _d: any, _f: any, t: any) => { saved.e = e; saved.t = t; return true; } } as any,
      { getListBloomHeader: async () => null } as any, 1, true
    );
    assert.ok(String(saved.e).startsWith("HTTP error"), "real error is not turned into a limit code");
    assert.ok(!saved.t);
    console.log("✓ fetch failure: raw error preserved");

    console.log("\nALL LIMIT WARNING TESTS PASSED");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
