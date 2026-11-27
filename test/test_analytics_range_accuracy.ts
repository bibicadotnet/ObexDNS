/**
 * @file test_analytics_range_accuracy.ts
 * @description Analytics must honour the requested range exactly: 10M / 1H must not return a whole
 * hour of rollup data, and a per-device view must come from the same source as the total view.
 */
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { NodeD1Database } from "../src/serverfull/db";
import { LogAggregationModel, planRollupQuery } from "../src/models/log/aggregation";
import { LogAnalyticsModel } from "../src/models/log/analytics";

const rawDb = new DatabaseSync(":memory:");
const db = new NodeD1Database(rawDb);
const aggregation = new LogAggregationModel(db);
const logModel = new LogAnalyticsModel(db, aggregation);

const H = 3600;
const sum = (rows: { action: string; count: number }[], action?: string) =>
  rows.filter((r) => !action || r.action === action).reduce((a, r) => a + Number(r.count), 0);

async function run() {
  rawDb.exec(`
    CREATE TABLE logs (
      profile_id TEXT NOT NULL, timestamp INTEGER NOT NULL, id INTEGER NOT NULL DEFAULT 1,
      client_ip TEXT, geo_country TEXT, domain TEXT NOT NULL, record_type TEXT NOT NULL,
      action TEXT NOT NULL, reason TEXT, answer TEXT, dest_geoip TEXT, dest_country_code TEXT,
      dest_country TEXT, ecs TEXT, upstream TEXT, latency INTEGER, access_point_id TEXT,
      PRIMARY KEY (profile_id, timestamp, id)
    ) WITHOUT ROWID;
  `);
  await aggregation.ensureRollupTables();

  const now = Math.floor(Date.now() / 1000);
  const curHour = Math.floor(now / H) * H;
  const P = "p1";

  // Rollups: the last 30 hours, every hour holds 100 PASS (60 pc + 40 phone) and 10 BLOCK (pc).
  const ins = rawDb.prepare(
    "INSERT INTO hourly_rollups (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id, count) VALUES (?,?,?,?,?,?,?)"
  );
  for (let i = 0; i < 30; i++) {
    const h = curHour - i * H;
    ins.run(P, "action", h, "PASS", "", "pc", 60);
    ins.run(P, "action", h, "PASS", "", "phone", 40);
    ins.run(P, "action", h, "BLOCK", "", "pc", 10);
    ins.run(P, "domain", h, "a.com", "PASS", "pc", 60);
    ins.run(P, "domain", h, "a.com", "PASS", "phone", 40);
    ins.run(P, "domain", h, "ads.com", "BLOCK", "pc", 10);
  }

  // Raw logs (cache misses only): 7 PASS + 2 BLOCK in the last 5 minutes, 3 PASS 30 minutes ago.
  const insLog = rawDb.prepare(
    "INSERT INTO logs (profile_id, timestamp, id, domain, record_type, action, access_point_id, client_ip) VALUES (?,?,?,?,?,?,?,?)"
  );
  let id = 1;
  for (let i = 0; i < 7; i++) insLog.run(P, now - 60 - i, id++, "a.com", "A", "PASS", "pc", "1.1.1.1");
  for (let i = 0; i < 2; i++) insLog.run(P, now - 120 - i, id++, "ads.com", "A", "BLOCK", "phone", "1.1.1.2");
  for (let i = 0; i < 3; i++) insLog.run(P, now - 1800 - i, id++, "b.com", "A", "PASS", "pc", "1.1.1.1");

  // Cache hits (no log row): minute buckets. 5 PASS pc + 3 PASS phone ~3 min ago, 4 PASS pc ~30 min ago.
  const m3 = Math.floor((now - 200) / 60) * 60;
  const m30 = Math.floor((now - 1830) / 60) * 60;
  ins.run(P, "hit_action", m3, "PASS", "", "pc", 5);
  ins.run(P, "hit_action", m3, "PASS", "", "phone", 3);
  ins.run(P, "hit_action", m30, "PASS", "", "pc", 4);
  ins.run(P, "hit_domain", m3, "a.com", "PASS", "pc", 5);

  // Head-slice entries (23h50m ago, between since24 and firstHour)
  const since24 = now - 86400;
  const firstHour = Math.ceil(since24 / H) * H;
  let headCount = 0;
  if (since24 < firstHour - 120) {
    const headLogTs = since24 + 10;
    const headHitMin = Math.ceil(since24 / 60) * 60 + 10;
    insLog.run(P, headLogTs, id++, "head.com", "A", "PASS", "pc", "1.1.1.1");
    ins.run(P, "hit_action", Math.floor(headHitMin / 60) * 60, "PASS", "", "pc", 1);
    ins.run(P, "hit_domain", Math.floor(headHitMin / 60) * 60, "head.com", "PASS", "pc", 1);
    headCount = 2; // 1 logged + 1 hit
  }

  // 1. 10M and 1H are exact (log rows + minute hit buckets) and different
  const m10 = await logModel.getSummary(P, now - 600, now);
  const h1 = await logModel.getSummary(P, now - 3600, now);
  assert.strictEqual(sum(m10), 17, "10M = 9 logged + 8 cache hits");
  assert.strictEqual(sum(h1), 24, "1H = 12 logged + 12 cache hits");
  assert.notStrictEqual(sum(m10), sum(h1));
  console.log("  PASS: 10M/1H summaries are exact (17 vs 24)");

  // 2. per-device summary for short ranges
  const m10phone = await logModel.getSummary(P, now - 600, now, undefined, "phone");
  assert.strictEqual(sum(m10phone), 5);
  console.log("  PASS: per-device summary on short range");

  // 3. 24H: rollups for full hours + head slice for uncovered minutes at the start
  const buckets = (curHour - firstHour) / H + 1;
  const d24 = await logModel.getSummary(P, since24, now);
  assert.strictEqual(sum(d24, "PASS"), buckets * 100 + headCount);
  assert.strictEqual(sum(d24, "BLOCK"), buckets * 10);
  console.log(`  PASS: 24H summary uses ${buckets} whole hours + ${headCount} head entries`);

  // 4. 24H with an access point: same source as "all", so totals add up
  const d24pc = await logModel.getSummary(P, since24, now, undefined, "pc");
  const d24phone = await logModel.getSummary(P, since24, now, undefined, "phone");
  assert.strictEqual(sum(d24pc) + sum(d24phone), sum(d24), "devices must add up to the total");
  assert.strictEqual(sum(d24phone), buckets * 40);
  assert.strictEqual(sum(d24pc), buckets * 70 + headCount);
  console.log("  PASS: per-device 24H totals add up to the overall total");

  // 5. trend per device and overall agree
  const tAll = await logModel.getTrend(P, since24, now, "(timestamp/3600)*3600");
  const tPhone = await logModel.getTrend(P, since24, now, "(timestamp/3600)*3600", "phone");
  assert.strictEqual(sum(tAll), sum(d24));
  assert.strictEqual(sum(tPhone), buckets * 40);
  console.log("  PASS: trend matches summary, with and without access point");

  // 6. top domains
  const top = await logModel.getTopAllowed(P, since24, now);
  assert.strictEqual(top[0].domain, "a.com");
  assert.strictEqual(Number(top[0].count), buckets * 100);
  if (headCount > 0) {
    const headDomain = top.find((t) => t.domain === "head.com");
    assert.strictEqual(Number(headDomain?.count), headCount);
  }
  const topPhone = await logModel.getTopAllowed(P, since24, now, "phone");
  assert.strictEqual(Number(topPhone[0].count), buckets * 40);
  const shortTop = await logModel.getTopAllowed(P, now - 600, now);
  assert.strictEqual(Number(shortTop[0].count), 12);
  console.log("  PASS: top domains per range and per device (including head slice)");

  // 6b. short-range trend adds the hit buckets too
  const tShort = await logModel.getTrend(P, now - 3600, now, "(timestamp/60)*60");
  assert.strictEqual(sum(tShort), 24);

  // 7. planner edges
  assert.strictEqual(planRollupQuery(1000, 1000 + 3600, 5000, 9000), null, "1H never uses rollups");
  // A 24h range ending "now": its start (now - 24h) is inside the zone where minute buckets of hits still exist.
  const plan = planRollupQuery(12 * H + 100, 36 * H + 100, 40 * H, 36 * H + 102)!; // planner clock is 2s after `until`
  assert.strictEqual(plan.rollupFrom, 13 * H);
  assert.strictEqual(plan.rollupTo, 37 * H);
  assert.deepStrictEqual(plan.head, { from: 12 * H + 100, to: 13 * H - 1 });
  assert.strictEqual(plan.raw, null);
  const stale = planRollupQuery(10 * H, 36 * H, 20 * H, 36 * H + 200)!;
  assert.strictEqual(stale.rollupTo, 21 * H);
  assert.strictEqual(stale.head, null);
  assert.deepStrictEqual(stale.raw, { from: 21 * H, to: 36 * H - 1 });
  assert.deepStrictEqual(stale.tail, { from: 36 * H, to: 36 * H }, "tail of a window that ended in the past");
  console.log("  PASS: rollup planner boundaries");
}

run().then(() => console.log("OK")).catch((e) => { console.error(e); process.exit(1); });
