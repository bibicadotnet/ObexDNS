/// <reference types="node" />
import fs from "node:fs";
import path from "node:path";
import { initNodeGlobals } from "../src/serverfull/cache";
import { initServerfullDb } from "../src/serverfull/db";
import { ProfileBloomModel } from "../src/models/profileBloom";
import { SystemSettingsModel } from "../src/models/systemSettings";
import { BloomFilter } from "../src/utils/bloom";
import { migrateBloomParamsIfChanged } from "../src/utils/sync/bloomParams";
import {
  syncNextListForProfile, syncAllListsForProfile, syncSingleListForProfile, rebuildProfileBloom, _resetInFlightSyncsForTesting,
} from "../src/utils/sync";
import { syncSingleList } from "../src/utils/sync/singleListSync";
import { ListModel } from "../src/models/list";
import { ListBloomModel } from "../src/models/listBloom";
import type { Env } from "../src/types";

// A profile with 4 custom lists (d1..d4.example.com), all built with the OLD Bloom settings. The admin changes
// MAX_SYNC_DOMAINS (or BLOOM_FALSE_POSITIVE_RATE with PROBE_MODE=fpr). At EVERY step afterwards the profile Bloom must be
// exactly right: every enabled list blocked, removed/disabled lists not blocked, and once an action rebuilds the profile
// it must carry the new size (lists of other sizes cannot be OR-merged, so they have to be rebuilt first).
const MODE = process.env.PROBE_MODE || "max";
const OLD = { SYNC_TIMEOUT_MS: 5000 };
const NEW: any = MODE === "fpr" ? { SYNC_TIMEOUT_MS: 5000, BLOOM_FALSE_POSITIVE_RATE: 0.00001 } : { SYNC_TIMEOUT_MS: 5000, MAX_SYNC_DOMAINS: 2000000 };
const NEW_PARAMS = BloomFilter.computeParams(Number(NEW.MAX_SYNC_DOMAINS) || 1000000, Number(NEW.BLOOM_FALSE_POSITIVE_RATE) || 0.0001);
const ctx: any = { waitUntil: (p: Promise<any>) => { p.catch(() => {}); } };
const origFetch = globalThis.fetch;
let failUrls = new Set<string>();
let failures = 0;

function installFetch() {
  globalThis.fetch = (async (u: any) => {
    const url = String(u);
    if (failUrls.has(url)) return new Response("boom", { status: 500 });
    const n = url.match(/\/(\d)\.txt/)![1];
    return new Response(`||d${n}.example.com^\n`, { status: 200, headers: { ETag: `"e-${n}"`, "Content-Type": "text/plain" } });
  }) as any;
}
async function freshDb(name: string) {
  SystemSettingsModel.clearMemoryCache(); _resetInFlightSyncsForTesting();
  const dir = path.join(process.cwd(), "temp_probe_mixed"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.sqlite`); for (const s of ["", "-wal", "-shm"]) fs.rmSync(file + s, { force: true });
  const db: any = initServerfullDb(file); const now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT INTO users (id, username, hashed_password, role, created_at) VALUES (?, ?, ?, ?, ?)").bind("u1", "admin", "x", "admin", now).run();
  await db.prepare("INSERT INTO profiles (id, name, settings, owner_id, profile_key, created_at, updated_at, list_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind("p1", "P1", "{}", "u1", "k1", now, now, 0).run();
  const ids: number[] = [];
  for (let i = 1; i <= 4; i++) { const r = await db.prepare("INSERT INTO lists (profile_id, url, enabled) VALUES (?, ?, 1)").bind("p1", `http://93.184.216.34/${i}.txt`).run(); ids.push(Number(r.meta.last_row_id)); }
  return { db, ids };
}
async function oldInstallThenMigrate(name: string) {
  const { db, ids } = await freshDb(name); installFetch();
  await syncAllListsForProfile("p1", { DB: db, ...OLD } as unknown as Env, ctx, true);
  const env = { DB: db, ...NEW } as unknown as Env;
  await migrateBloomParamsIfChanged(env);
  return { db, ids, env };
}
// params: "NEW" | "old" | "any"; blocked/not: domain numbers
async function expectState(db: any, label: string, params: "NEW" | "old" | "any", blocked: number[], not: number[] = []) {
  const buf = await new ProfileBloomModel(db).getProfileBloom("p1");
  const errs: string[] = [];
  let desc = "";
  if (!buf) { errs.push("profile has NO bloom"); desc = "(none)"; }
  else {
    const f = BloomFilter.fromUint8Array(new Uint8Array(buf));
    const p = BloomFilter.readHeaderParams(new Uint8Array(buf.slice(0, 20)))!;
    const kind = p.size === NEW_PARAMS.size && p.hashes === NEW_PARAMS.hashes ? "NEW" : "old";
    const has = (n: number) => f.test(`d${n}.example.com`) || f.testPipePipe(`d${n}.example.com`);
    if (params !== "any" && kind !== params) errs.push(`profile bloom is ${kind}, expected ${params}`);
    for (const n of blocked) if (!has(n)) errs.push(`d${n} NOT blocked`);
    for (const n of not) if (has(n)) errs.push(`d${n} still blocked`);
    desc = `[${kind}] blocked: ${[1, 2, 3, 4, 5].filter(has).map((n) => "d" + n).join(",")}`;
  }
  if (errs.length) failures++;
  console.log(`   ${errs.length ? "✗" : "✓"} ${label}: ${desc}${errs.length ? "   <-- " + errs.join("; ") : ""}`);
}

async function main() {
  initNodeGlobals();

  console.log("\n=== S1: cron path after restart: ONE tick sees the other 3 lists are stale, rebuilds all of them and promotes a correct profile Bloom");
  { const { db, env } = await oldInstallThenMigrate("s1");
    let n = 0; const f = globalThis.fetch; globalThis.fetch = (async (u: any, i: any) => { n++; return (f as any)(u, i); }) as any;
    await syncNextListForProfile("p1", env, ctx); await expectState(db, "cron tick 1", "NEW", [1, 2, 3, 4]);
    if (n !== 4) { failures++; console.log(`   ✗ expected 4 downloads in tick 1, got ${n}`); } else console.log("   ✓ 4 downloads in tick 1 (1 picked + 3 stale)");
    globalThis.fetch = f;
    for (let t = 2; t <= 4; t++) { await syncNextListForProfile("p1", env, ctx); await expectState(db, `cron tick ${t}`, "NEW", [1, 2, 3, 4]); } }

  console.log("\n=== S2: after restart the user syncs ONE list by hand (forced) -> the other 3 must be rebuilt too");
  { const { db, ids, env } = await oldInstallThenMigrate("s2");
    await syncSingleListForProfile("p1", ids[0], env, ctx, true); await expectState(db, "manual sync of list 1", "NEW", [1, 2, 3, 4]); }

  console.log("\n=== S3: same, not forced");
  { const { db, ids, env } = await oldInstallThenMigrate("s3");
    await syncSingleListForProfile("p1", ids[1], env, ctx, false); await expectState(db, "non-forced sync of list 2", "NEW", [1, 2, 3, 4]); }

  console.log("\n=== S4: user DISABLES a list (3 old lists remain enabled)");
  { const { db, ids, env } = await oldInstallThenMigrate("s4");
    await db.prepare("UPDATE lists SET enabled = 0 WHERE id = ?").bind(ids[3]).run();
    await rebuildProfileBloom("p1", env, ctx); await expectState(db, "after disabling list 4", "NEW", [1, 2, 3], [4]);
    await db.prepare("UPDATE lists SET enabled = 1 WHERE id = ?").bind(ids[3]).run();
    await rebuildProfileBloom("p1", env, ctx); await expectState(db, "after enabling list 4 again", "NEW", [1, 2, 3, 4]); }

  console.log("\n=== S5: user ADDS a 5th list");
  { const { db, env } = await oldInstallThenMigrate("s5");
    await db.prepare("INSERT INTO lists (profile_id, url, enabled) VALUES (?, ?, 1)").bind("p1", "http://93.184.216.34/5.txt").run();
    await rebuildProfileBloom("p1", env, ctx); await expectState(db, "after adding list 5", "NEW", [1, 2, 3, 4, 5]); }

  console.log("\n=== S6: user DELETES a list");
  { const { db, ids, env } = await oldInstallThenMigrate("s6");
    await db.prepare("DELETE FROM lists WHERE id = ?").bind(ids[3]).run();
    await rebuildProfileBloom("p1", env, ctx); await expectState(db, "after deleting list 4", "NEW", [1, 2, 3], [4]); }

  console.log("\n=== S7: user presses 'Sync all'");
  { const { db, env } = await oldInstallThenMigrate("s7");
    await syncAllListsForProfile("p1", env, ctx, true); await expectState(db, "after Sync all", "NEW", [1, 2, 3, 4]); }

  console.log("\n=== S8: cron cycle, list 3 cannot be downloaded: old profile Bloom keeps ALL 4 lists; once upstream is back the next action rebuilds");
  { const { db, ids, env } = await oldInstallThenMigrate("s8");
    failUrls = new Set(["http://93.184.216.34/3.txt"]);
    for (let t = 1; t <= 4; t++) { await syncNextListForProfile("p1", env, ctx); await expectState(db, `cron tick ${t} (list 3 failing)`, "old", [1, 2, 3, 4]); }
    failUrls = new Set();
    await syncSingleListForProfile("p1", ids[0], env, ctx, true); await expectState(db, "upstream back, manual sync", "NEW", [1, 2, 3, 4]); }

  console.log("\n=== S9: cron run in progress while the user disables list 4 / adds list 5 / deletes list 2 (calls serialize; end result must be exact)");
  { const { db, ids, env } = await oldInstallThenMigrate("s9");
    const cron = syncNextListForProfile("p1", env, ctx);
    await db.prepare("UPDATE lists SET enabled = 0 WHERE id = ?").bind(ids[3]).run();
    const r1 = rebuildProfileBloom("p1", env, ctx);
    await db.prepare("INSERT INTO lists (profile_id, url, enabled) VALUES (?, ?, 1)").bind("p1", "http://93.184.216.34/5.txt").run();
    await db.prepare("DELETE FROM lists WHERE id = ?").bind(ids[1]).run();
    const r2 = rebuildProfileBloom("p1", env, ctx);
    await Promise.all([cron, r1, r2]);
    await expectState(db, "after cron + disable 4 + add 5 + delete 2", "NEW", [1, 3, 5], [2, 4]); }

  console.log("\n=== S10: lists 1,2 already on the new size and still waiting in the cycle, lists 3,4 stale: cron promotes right away and keeps the cycle open");
  { const { db, ids, env } = await oldInstallThenMigrate("s10");
    const lm = new ListModel(db), lbm = new ListBloomModel(db);
    for (const id of [ids[0], ids[1]]) { const l = await lm.getListById(id, "p1"); await syncSingleList("p1", l!, env, lm, lbm, Math.floor(Date.now() / 1000), true); }
    await db.prepare("UPDATE lists SET last_synced_at = NULL WHERE id IN (?, ?)").bind(ids[0], ids[1]).run();
    await syncNextListForProfile("p1", env, ctx); await expectState(db, "cron tick 1", "NEW", [1, 2, 3, 4]);
    const prof: any = await db.prepare("SELECT list_updated_at FROM profiles WHERE id = ?").bind("p1").first();
    if (Number(prof.list_updated_at || 0) !== 0) { failures++; console.log(`   ✗ cycle was closed early (list_updated_at=${prof.list_updated_at})`); } else console.log("   ✓ cycle stays open for the remaining list");
    await syncNextListForProfile("p1", env, ctx); await expectState(db, "cron tick 2", "NEW", [1, 2, 3, 4]); }

  globalThis.fetch = origFetch;
  fs.rmSync(path.join(process.cwd(), "temp_probe_mixed"), { recursive: true, force: true });
}
main().then(() => { if (failures) { console.error(`\nFAILED: ${failures} step(s) wrong`); process.exit(1); } console.log("\nMIXED BLOOM PARAMS TESTS PASSED"); process.exit(0); })
  .catch((e) => { console.error("FAILED:", e); process.exit(1); });
