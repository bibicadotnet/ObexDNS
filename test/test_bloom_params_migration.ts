/// <reference types="node" />
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { initNodeGlobals } from "../src/serverfull/cache";
import { initServerfullDb } from "../src/serverfull/db";
import { ListBloomModel } from "../src/models/listBloom";
import { SystemSettingsModel } from "../src/models/systemSettings";
import { BloomFilter } from "../src/utils/bloom";
import { migrateBloomParamsIfChanged, currentBloomFingerprint, BLOOM_PARAMS_SETTING_KEY } from "../src/utils/sync/bloomParams";
import type { Env } from "../src/types";

// Startup-only handling of a changed MAX_SYNC_DOMAINS / BLOOM_FALSE_POSITIVE_RATE, on a real SQLite DB.

async function freshDb(name: string) {
  // SystemSettingsModel keeps a process-wide cache keyed by setting name; each case here uses its own DB
  SystemSettingsModel.clearMemoryCache();
  const dir = path.join(process.cwd(), "temp_test_data_bloom_params");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.sqlite`);
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  const db = initServerfullDb(file);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT INTO users (id, username, hashed_password, role, created_at) VALUES (?, ?, ?, ?, ?)").bind("u1", "admin", "x", "admin", now).run();
  await db.prepare("INSERT INTO profiles (id, name, settings, owner_id, profile_key, created_at, updated_at, list_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind("p1", "P1", "{}", "u1", "k1", now, now, now).run();
  await db.prepare("INSERT INTO profiles (id, name, settings, owner_id, profile_key, created_at, updated_at, list_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind("p2", "NoLists", "{}", "u1", "k2", now, now, now).run();
  const l = await db.prepare("INSERT INTO lists (profile_id, url, enabled, etag, last_modified, last_synced_at) VALUES (?, ?, 1, ?, ?, ?)")
    .bind("p1", "https://example.test/a.txt", '"e1"', "Mon, 01 Jan 2026 00:00:00 GMT", now).run();
  await db.prepare("INSERT INTO system_lists (url, etag, last_modified, last_synced_at) VALUES (?, ?, ?, ?)")
    .bind("https://example.test/sys.txt", '"s1"', "Mon, 01 Jan 2026 00:00:00 GMT", now).run();
  return { db, listId: Number(l.meta.last_row_id), now };
}

async function snapshot(db: any) {
  const list: any = await db.prepare("SELECT etag, last_modified, last_synced_at FROM lists WHERE url = ?").bind("https://example.test/a.txt").first();
  const sys: any = await db.prepare("SELECT etag, last_modified, last_synced_at FROM system_lists WHERE url = ?").bind("https://example.test/sys.txt").first();
  const p1: any = await db.prepare("SELECT list_updated_at FROM profiles WHERE id = 'p1'").first();
  const p2: any = await db.prepare("SELECT list_updated_at FROM profiles WHERE id = 'p2'").first();
  return { list, sys, p1: p1.list_updated_at, p2: p2.list_updated_at };
}

const isReset = (s: any) =>
  s.list.etag === null && s.list.last_modified === null && s.list.last_synced_at === null &&
  s.sys.etag === null && s.sys.last_modified === null && s.sys.last_synced_at === null && s.p1 === null;
const isIntact = (s: any) =>
  s.list.etag === '"e1"' && s.list.last_synced_at !== null && s.sys.etag === '"s1"' && s.p1 !== null;

async function putListBloom(db: any, listId: number, n: number, p: number) {
  const b = BloomFilter.create(n, p);
  b.addPipePipe("example.com");
  await new ListBloomModel(db).upsertListBloom(listId, b.toUint8Array().buffer as ArrayBuffer, 1);
}

async function main() {
  initNodeGlobals();

  // helper math: same numbers the docs/analysis used
  const f1m = currentBloomFingerprint({ MAX_SYNC_DOMAINS: 1000000 } as Env);
  const f2m = currentBloomFingerprint({ MAX_SYNC_DOMAINS: 2000000 } as Env);
  assert.strictEqual(f1m, "m=19170117;k=13");
  assert.notStrictEqual(f1m, f2m);
  assert.strictEqual(currentBloomFingerprint({} as Env), f1m, "defaults (1M, 0.0001) when the variables are absent");
  console.log("✓ fingerprint follows MAX_SYNC_DOMAINS / BLOOM_FALSE_POSITIVE_RATE, defaults match the sync code");

  // 1. existing install built with 1M, admin now sets 2M, no fingerprint remembered yet -> detected from stored header
  {
    const { db, listId } = await freshDb("case1");
    await putListBloom(db, listId, 1000000, 0.0001);
    const env = { DB: db, MAX_SYNC_DOMAINS: 2000000 } as unknown as Env;
    const r = await migrateBloomParamsIfChanged(env);
    assert.strictEqual(r.outcome, "reset");
    const s = await snapshot(db);
    assert.ok(isReset(s), `state must be reset: ${JSON.stringify(s)}`);
    assert.strictEqual(s.p2, (await snapshot(db)).p2);
    assert.notStrictEqual(s.p2, null, "profile without lists must be left alone");
    assert.strictEqual(await new SystemSettingsModel(db).get(BLOOM_PARAMS_SETTING_KEY), f2m);
    console.log("✓ 1M -> 2M detected from stored Bloom headers: system lists, profile lists and profiles reset, fingerprint saved");

    // 2. next boot with the same settings: nothing happens, even if state was refilled in the meantime
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("UPDATE lists SET etag = '\"e1\"', last_synced_at = ?").bind(now).run();
    await db.prepare("UPDATE system_lists SET etag = '\"s1\"', last_synced_at = ?").bind(now).run();
    await db.prepare("UPDATE profiles SET list_updated_at = ?").bind(now).run();
    const r2 = await migrateBloomParamsIfChanged(env);
    assert.strictEqual(r2.outcome, "unchanged");
    assert.ok(isIntact(await snapshot(db)), "unchanged settings must not touch the sync state");
    console.log("✓ same settings on the next start: no reset (cost = one settings read)");

    // 3. changing only the false positive rate resets again
    const env3 = { DB: db, MAX_SYNC_DOMAINS: 2000000, BLOOM_FALSE_POSITIVE_RATE: 0.0000001 } as unknown as Env;
    const r3 = await migrateBloomParamsIfChanged(env3);
    assert.strictEqual(r3.outcome, "reset");
    assert.ok(isReset(await snapshot(db)));
    assert.strictEqual(await new SystemSettingsModel(db).get(BLOOM_PARAMS_SETTING_KEY), currentBloomFingerprint(env3));
    console.log("✓ changing BLOOM_FALSE_POSITIVE_RATE alone resets again");
  }

  // 4. first start of a brand new install (no Blooms stored): just remember, do not reset
  {
    const { db } = await freshDb("case4");
    const r = await migrateBloomParamsIfChanged({ DB: db, MAX_SYNC_DOMAINS: 2000000 } as unknown as Env);
    assert.strictEqual(r.outcome, "initialized");
    assert.ok(isIntact(await snapshot(db)));
    console.log("✓ nothing stored yet: fingerprint recorded, no reset");
  }

  // 5. upgrading an install whose stored Blooms already match the current settings: no pointless rebuild
  {
    const { db, listId } = await freshDb("case5");
    await putListBloom(db, listId, 2000000, 0.0001);
    const r = await migrateBloomParamsIfChanged({ DB: db, MAX_SYNC_DOMAINS: 2000000 } as unknown as Env);
    assert.strictEqual(r.outcome, "initialized");
    assert.ok(isIntact(await snapshot(db)));
    console.log("✓ stored Blooms already match: recorded, no reset");
  }

  // 6. header parsing never mistakes unknown formats for a mismatch
  assert.strictEqual(BloomFilter.readHeaderParams(new Uint8Array(20)), null);
  assert.strictEqual(BloomFilter.readHeaderParams(null), null);
  const b = BloomFilter.create(2000000, 0.0001);
  assert.deepStrictEqual(BloomFilter.readHeaderParams(b.toUint8Array().slice(0, 20)), BloomFilter.computeParams(2000000, 0.0001));
  console.log("✓ readHeaderParams: round trip, null for unknown formats");

  fs.rmSync(path.join(process.cwd(), "temp_test_data_bloom_params"), { recursive: true, force: true });
  console.log("\nALL BLOOM PARAMS MIGRATION TESTS PASSED");
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message || e); process.exit(1); });
