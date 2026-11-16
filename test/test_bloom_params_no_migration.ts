/// <reference types="node" />
import fs from "node:fs";
import path from "node:path";
import { initNodeGlobals } from "../src/serverfull/cache";
import { initServerfullDb } from "../src/serverfull/db";
import { ProfileFilterModel } from "../src/models/profileFilter";
import { SystemSettingsModel } from "../src/models/systemSettings";
import { FingerprintSet } from "../src/utils/fingerprintSet";
import { syncNextListForProfile, syncAllListsForProfile, _resetInFlightSyncsForTesting } from "../src/utils/sync";
import type { Env } from "../src/types";

let failures = 0;
// Regression test. Workers-like path: MAX_SYNC_DOMAINS changed, migrateBloomParamsIfChanged is NEVER called (it is only wired into serverfull/index.ts).
const OLD = { SYNC_TIMEOUT_MS: 5000 };
const NEW = { SYNC_TIMEOUT_MS: 5000, MAX_SYNC_DOMAINS: 2000000 };
const ctx: any = { waitUntil: (p: Promise<any>) => { p.catch(() => {}); } };
let list1Changed = false;
const sent: string[] = [];

function installFetch() {
  globalThis.fetch = (async (u: any, init: any) => {
    const url = String(u); const n = url.match(/\/(\d)\.txt/)![1];
    const h = new Headers(init?.headers || {});
    const cond = h.get("if-none-match");
    sent.push(`list${n}:${cond ? "conditional" : "full"}`);
    if (cond && !(n === "1" && list1Changed)) return new Response(null, { status: 304 });
    const body = n === "1" && list1Changed ? `||d1.example.com^\n||d1b.example.com^\n` : `||d${n}.example.com^\n`;
    return new Response(body, { status: 200, headers: { ETag: `"e-${n}-${n === "1" && list1Changed ? 2 : 1}"` } });
  }) as any;
}
const dbs: any[] = [];

async function setup(name: string) {
  SystemSettingsModel.clearMemoryCache(); _resetInFlightSyncsForTesting();
  const dir = path.join(process.cwd(), "temp_probe_nomig"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.sqlite`); for (const s of ["", "-wal", "-shm"]) fs.rmSync(file + s, { force: true });
  const db: any = initServerfullDb(file); const now = Math.floor(Date.now() / 1000);
  dbs.push(db);
  await db.prepare("INSERT INTO users (id, username, hashed_password, role, created_at) VALUES (?, ?, ?, ?, ?)").bind("u1", "admin", "x", "admin", now).run();
  await db.prepare("INSERT INTO profiles (id, name, settings, owner_id, profile_key, created_at, updated_at, list_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind("p1", "P1", "{}", "u1", "k1", now, now, 0).run();
  for (let i = 1; i <= 4; i++) await db.prepare("INSERT INTO lists (profile_id, url, enabled) VALUES (?, ?, 1)").bind("p1", `http://93.184.216.34/${i}.txt`).run();
  installFetch();
  await syncAllListsForProfile("p1", { DB: db, ...OLD } as unknown as Env, ctx, true);
  // one day later: profile is due again
  await db.prepare("UPDATE lists SET last_synced_at = last_synced_at - 86401").run();
  await db.prepare("UPDATE profiles SET list_updated_at = list_updated_at - 86401").run();
  sent.length = 0;
  return db;
}
async function report(db: any, label: string) {
  const buf = await new ProfileFilterModel(db).getProfileFilter("p1");
  let s = `   ${label}: `;
  if (!buf) { failures++; s += "!! LOST FILTERING !! (NONE - profile has no bloom)"; }
  else {
    const f = FingerprintSet.fromUint8Array(new Uint8Array(buf));
    const blocked = [1, 2, 3, 4].map((i) => f.test(`d${i}.example.com`) || f.testPipePipe(`d${i}.example.com`));
    if (blocked.some((b) => !b)) { failures++; s += "!! LOST FILTERING !! "; }
    s += `[FPRT] ` + blocked.map((b, i) => `d${i + 1}=${b ? "BLOCKED" : "not-blocked"}`).join(" ");
  }
  console.log(s);
}
async function main() {
  initNodeGlobals();
  try {
    for (const changed of [false, true]) {
      list1Changed = changed;
      console.log(`\n=== no migration; daily cron cycle; upstream: list 1 ${changed ? "CHANGED (200)" : "unchanged (304)"}, lists 2-4 unchanged (304)`);
      const db = await setup(changed ? "chg" : "unchg");
      await report(db, "before cron cycle (old install)");
      const env = { DB: db, ...NEW } as unknown as Env;
      for (let t = 1; t <= 4; t++) { await syncNextListForProfile("p1", env, ctx); await report(db, `after cron tick ${t}`); }
      console.log(`   requests: ${sent.join(", ")}`);
    }
  } finally {
    for (const db of dbs) {
      try { db.close(); } catch {}
    }
    try {
      fs.rmSync(path.join(process.cwd(), "temp_probe_nomig"), { recursive: true, force: true });
    } catch {}
  }
}
main().then(() => { if (failures) { console.error(`\nFAILED: ${failures} step(s) lost filtering`); process.exit(1); } console.log("\nNO-MIGRATION BLOOM PARAMS TEST PASSED"); process.exit(0); }).catch((e) => { console.error("FAILED:", e); process.exit(1); });
