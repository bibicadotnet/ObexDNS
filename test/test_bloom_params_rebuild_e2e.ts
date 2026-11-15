/// <reference types="node" />
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { initNodeGlobals } from "../src/serverfull/cache";
import { initServerfullDb } from "../src/serverfull/db";
import { ListBloomModel } from "../src/models/listBloom";
import { ProfileBloomModel } from "../src/models/profileBloom";
import { SystemSettingsModel } from "../src/models/systemSettings";
import { ProfileModel } from "../src/models/profile";
import { BloomFilter } from "../src/utils/bloom";
import { migrateBloomParamsIfChanged } from "../src/utils/sync/bloomParams";
import { syncNextListForProfile } from "../src/utils/sync";
import type { Env } from "../src/types";

// After a Bloom parameter change: reset at startup -> cron picks the profile up -> the list is downloaded in full
// (no conditional headers, even though the upstream would answer 304) -> new-size Bloom -> profile Bloom promoted.
async function main() {
  initNodeGlobals();
  SystemSettingsModel.clearMemoryCache();
  const dir = path.join(process.cwd(), "temp_test_data_bloom_e2e");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const db: any = initServerfullDb(path.join(dir, "t.sqlite"));
  const now = Math.floor(Date.now() / 1000);

  await db.prepare("INSERT INTO users (id, username, hashed_password, role, created_at) VALUES (?, ?, ?, ?, ?)").bind("u1", "admin", "x", "admin", now).run();
  await db.prepare("INSERT INTO profiles (id, name, settings, owner_id, profile_key, created_at, updated_at, list_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind("p1", "P1", "{}", "u1", "k1", now, now, now).run();
  const url = "http://93.184.216.34/a.txt";
  const l = await db.prepare("INSERT INTO lists (profile_id, url, enabled, etag, last_synced_at) VALUES (?, ?, 1, ?, ?)").bind("p1", url, '"e1"', now).run();
  const listId = Number(l.meta.last_row_id);

  // State of an existing install: list + profile Bloom built with 1M capacity
  const oldBloom = BloomFilter.create(1000000, 0.0001);
  oldBloom.addPipePipe("old.example.com");
  await new ListBloomModel(db).upsertListBloom(listId, oldBloom.toUint8Array().buffer as ArrayBuffer, now);
  await new ProfileBloomModel(db).upsertProfileBloom("p1", oldBloom.toUint8Array().buffer as ArrayBuffer, now);

  // Admin raises the capacity and restarts
  const env = { DB: db, MAX_SYNC_DOMAINS: 2000000, SYNC_TIMEOUT_MS: 5000 } as unknown as Env;
  const r = await migrateBloomParamsIfChanged(env);
  assert.strictEqual(r.outcome, "reset");

  // Upstream would say 304 if asked conditionally; record what the sync actually sends
  const sent: Record<string, string>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init: any) => {
    const h: Record<string, string> = {};
    new Headers(init?.headers || {}).forEach((v, k) => (h[k] = v));
    sent.push(h);
    if (h["if-none-match"]) return new Response(null, { status: 304 });
    return new Response("||new.example.com^\n||other.example.org^\n", { status: 200, headers: { ETag: '"e2"', "Content-Type": "text/plain" } });
  }) as any;
  try {
    const ctx: any = { waitUntil: (p: Promise<any>) => { p.catch(() => {}); } };
    const targets = await new ProfileModel(db).getSyncTargets(now - 86400, 1);
    assert.deepStrictEqual(targets.map((t) => t.id), ["p1"], "cron must see the reset profile as stale");

    await syncNextListForProfile("p1", env, ctx);
  } finally { globalThis.fetch = original; }

  assert.strictEqual(sent.length, 1, "exactly one download");
  assert.ok(!sent[0]["if-none-match"] && !sent[0]["if-modified-since"], "full download: no conditional headers");

  const listHead = await db.prepare("SELECT substr(bloom_filter_chunk,1,20) AS head FROM list_blooms WHERE list_id = ? AND chunk_index = 0").bind(listId).first();
  const profHead = await db.prepare("SELECT substr(bloom_filter_chunk,1,20) AS head FROM profile_blooms WHERE profile_id = ? AND chunk_index = 0").bind("p1").first();
  const want = BloomFilter.computeParams(2000000, 0.0001);
  assert.deepStrictEqual(BloomFilter.readHeaderParams(new Uint8Array(listHead.head)), want, "list Bloom rebuilt with the new size");
  assert.deepStrictEqual(BloomFilter.readHeaderParams(new Uint8Array(profHead.head)), want, "profile Bloom re-promoted with the new size");

  const row: any = await db.prepare("SELECT etag, last_synced_at FROM lists WHERE id = ?").bind(listId).first();
  assert.strictEqual(row.etag, '"e2"');
  assert.ok(row.last_synced_at > 0);
  const prof: any = await db.prepare("SELECT list_updated_at FROM profiles WHERE id = 'p1'").first();
  assert.ok(prof.list_updated_at > 0, "cycle completed");
  console.log("✓ reset -> cron picks the profile -> full download -> new-size list Bloom -> profile Bloom promoted");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\nBLOOM PARAMS REBUILD E2E PASSED");
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message || e); process.exit(1); });
