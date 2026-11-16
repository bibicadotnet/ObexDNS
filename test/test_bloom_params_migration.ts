/// <reference types="node" />
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { initNodeGlobals } from "../src/serverfull/cache";
import { initServerfullDb } from "../src/serverfull/db";
import { ListFilterModel } from "../src/models/listFilter";
import { SystemSettingsModel } from "../src/models/systemSettings";
import { FingerprintSet, FingerprintSetBuilder, FPRT_MAGIC } from "../src/utils/fingerprintSet";
import {
  migrateFilterFormatIfLegacy,
  FILTER_FORMAT_SETTING_KEY,
  CURRENT_FILTER_FORMAT,
  resetFilterMigrationCheckForTesting
} from "../src/utils/sync/filterMigration";
import type { Env } from "../src/types";

// Startup-only handling of legacy BLMZ Bloom filters migrating to FingerprintSet (FPRT).

async function freshDb(name: string) {
  SystemSettingsModel.clearMemoryCache();
  resetFilterMigrationCheckForTesting();
  const dir = path.join(process.cwd(), "temp_test_data_filter_migration");
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

/** Inserts a fake legacy BLMZ buffer */
async function putLegacyBloomChunk(db: any, listId: number) {
  const legacyBuf = new Uint8Array(20);
  const view = new DataView(legacyBuf.buffer);
  view.setUint32(0, 0x5a4d4c42, true); // 'BLMZ'
  await db.prepare("INSERT INTO list_blooms (list_id, chunk_index, bloom_filter_chunk, updated_at) VALUES (?, ?, ?, ?)")
    .bind(listId, 0, legacyBuf.buffer as ArrayBuffer, 1)
    .run();
}

async function main() {
  initNodeGlobals();

  // 1. Existing install with legacy BLMZ data: startup detects it and triggers rebuild
  {
    const { db, listId } = await freshDb("case1");
    await putLegacyBloomChunk(db, listId);
    const env = { DB: db } as unknown as Env;
    const r = await migrateFilterFormatIfLegacy(env);
    assert.strictEqual(r.migrated, true);
    assert.strictEqual(r.outcome, "migrated");
    const s = await snapshot(db);
    assert.ok(isReset(s), `State must be reset: ${JSON.stringify(s)}`);
    assert.notStrictEqual(s.p2, null, "Profile without lists must be left intact");
    assert.strictEqual(await new SystemSettingsModel(db).get(FILTER_FORMAT_SETTING_KEY), CURRENT_FILTER_FORMAT);
    console.log("✓ Legacy BLMZ chunk detected: lists, system_lists, and profiles reset, filter_format saved");

    // 2. Next boot: setting matches, no-op even if lists were resynced
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("UPDATE lists SET etag = '\"e1\"', last_synced_at = ?").bind(now).run();
    await db.prepare("UPDATE system_lists SET etag = '\"s1\"', last_synced_at = ?").bind(now).run();
    await db.prepare("UPDATE profiles SET list_updated_at = ?").bind(now).run();
    resetFilterMigrationCheckForTesting();
    const r2 = await migrateFilterFormatIfLegacy(env);
    assert.strictEqual(r2.migrated, false);
    assert.strictEqual(r2.outcome, "unchanged");
    assert.ok(isIntact(await snapshot(db)), "Unchanged setting must not touch sync state");
    console.log("✓ Subsequent boot with current filter_format: unchanged, no reset");
    db.rawDb?.close();
  }

  // 3. Clean install with no legacy blooms: records format without reset
  {
    const { db } = await freshDb("case2");
    const env = { DB: db } as unknown as Env;
    const r = await migrateFilterFormatIfLegacy(env);
    assert.strictEqual(r.migrated, false);
    assert.strictEqual(r.outcome, "none_needed");
    assert.ok(isIntact(await snapshot(db)));
    assert.strictEqual(await new SystemSettingsModel(db).get(FILTER_FORMAT_SETTING_KEY), CURRENT_FILTER_FORMAT);
    console.log("✓ Clean install: recorded filter_format, no reset");
    db.rawDb?.close();
  }

  // 4. Header validation
  assert.strictEqual(FingerprintSet.isCurrentVersion(new Uint8Array(20)), false);
  assert.strictEqual(FingerprintSet.isCurrentVersion(null), false);
  const builder = new FingerprintSetBuilder();
  builder.add("example.com");
  const set = await builder.build();
  const bin = set.toUint8Array();
  assert.strictEqual(FingerprintSet.isCurrentVersion(bin), true);
  console.log("✓ FingerprintSet header validation verified");

  try {
    fs.rmSync(path.join(process.cwd(), "temp_test_data_filter_migration"), { recursive: true, force: true });
  } catch {}
  console.log("\nALL FILTER FORMAT MIGRATION TESTS PASSED!");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("FAILED:", e.message || e);
  process.exit(1);
});
