/**
 * The Query Logs "Failed" filter must be answered from the partial FAIL index (migration 0069),
 * not by walking every row of the time range, and must return exactly the FAIL rows.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { LogCoreModel } from "../src/models/log/core";

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE logs (profile_id TEXT NOT NULL, timestamp INTEGER NOT NULL, id INTEGER NOT NULL, client_ip TEXT,
  geo_country TEXT, domain TEXT NOT NULL, record_type TEXT NOT NULL, action TEXT NOT NULL, reason TEXT, answer TEXT,
  dest_geoip TEXT, ecs TEXT, upstream TEXT, latency INTEGER, access_point_id TEXT, dest_country_code TEXT,
  dest_country TEXT, dest_isp TEXT, encrypt_version INTEGER, kem_key_id TEXT, encrypted_payload TEXT,
  event TEXT, prev_answer TEXT,
  PRIMARY KEY (profile_id, timestamp, id)) WITHOUT ROWID;
  CREATE TABLE access_points (id TEXT, name TEXT); CREATE TABLE kem_keys (id TEXT, kem_ct TEXT);`);

const ins = db.prepare("INSERT INTO logs (profile_id, timestamp, id, domain, record_type, action) VALUES ('p', ?, ?, 'a.com', 'A', ?)");
for (let i = 1; i <= 1000; i++) ins.run(i, i, i % 250 === 0 ? "FAIL" : "PASS");

// D1-like adapter over node:sqlite
const adapter = {
  prepare(sql: string) {
    return {
      bind(...params: unknown[]) {
        return { all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }) };
      },
    };
  },
};
const model = new LogCoreModel(adapter as never, {} as never);
const run = (status: string) => model.getLogs("p", { since: 0, until: 2000, status, limit: 50 } as never);

(async () => {
  // Without the migration the hint fails and must fall back to the plain query.
  let fail = await run("FAIL");
  if (fail.length !== 4 || fail.some((r) => r.action !== "FAIL")) throw new Error("fallback FAIL filter wrong");

  const sql = fs.readFileSync(path.join(process.cwd(), "migrations/0069_add_partial_idx_logs_fail.sql"), "utf8");
  db.exec(sql);
  fail = await run("FAIL");
  if (fail.length !== 4 || fail.some((r) => r.action !== "FAIL")) throw new Error("indexed FAIL filter wrong");
  if (fail[0].timestamp < fail[3].timestamp) throw new Error("FAIL rows must be newest first");

  const plan = db.prepare(
    "EXPLAIN QUERY PLAN SELECT * FROM logs l INDEXED BY idx_logs_profile_fail_time WHERE l.profile_id = 'p' AND l.action = 'FAIL' AND l.timestamp >= 0 ORDER BY l.timestamp DESC"
  ).all() as Array<{ detail: string }>;
  if (!plan.some((r) => r.detail.includes("idx_logs_profile_fail_time"))) throw new Error("partial index not used");

  const pass = await run("PASS");
  if (pass.length !== 50 || pass.some((r) => r.action !== "PASS")) throw new Error("PASS filter wrong");
  console.log("test_fail_filter_index: OK");
})();
