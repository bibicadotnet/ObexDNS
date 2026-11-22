/**
 * @file test_analytics_edges_exact.ts
 * @description A >=24h window must count EXACTLY [since, until]: the partial first hour (head) and, for a
 * window that ended in the past, the partial last hour (tail) come from raw logs + hit minute buckets —
 * never dropped, never double counted, nothing outside the window.
 */
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { NodeD1Database } from "../src/serverfull/db";
import { LogAggregationModel, planRollupQuery, alignRangeToMinutes, minuteDataFloor } from "../src/models/log/aggregation";
import { LogAnalyticsModel } from "../src/models/log/analytics";
import { analyticsCachePolicy } from "../src/utils/analyticsCache";

const rawDb = new DatabaseSync(":memory:");
const db = new NodeD1Database(rawDb);
const aggregation = new LogAggregationModel(db);
const model = new LogAnalyticsModel(db, aggregation);
const H = 3600;
const P = "p1";
const total = (rows: { count: number }[]) => rows.reduce((a, r) => a + Number(r.count), 0);

let logId = 1;
const insRollup = { run: (...a: any[]) => rawDb.prepare("INSERT INTO hourly_rollups (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id, count) VALUES (?,?,?,?,?,?,?)").run(...a) };
const insLog = { run: (...a: any[]) => rawDb.prepare("INSERT INTO logs (profile_id, timestamp, id, domain, record_type, action, access_point_id) VALUES (?,?,?,?,?,?,?)").run(...a) };
const log = (ts: number, n = 1) => { for (let i = 0; i < n; i++) insLog.run(P, ts, logId++, "a.com", "A", "PASS", ""); };
const hit = (ts: number, n: number) => insRollup.run(P, "hit_action", Math.floor(ts / 60) * 60, "PASS", "", "", n);

async function run() {
  rawDb.exec(`CREATE TABLE logs (
    profile_id TEXT NOT NULL, timestamp INTEGER NOT NULL, id INTEGER NOT NULL DEFAULT 1,
    client_ip TEXT, geo_country TEXT, domain TEXT NOT NULL, record_type TEXT NOT NULL,
    action TEXT NOT NULL, reason TEXT, answer TEXT, dest_geoip TEXT, dest_country_code TEXT,
    dest_country TEXT, ecs TEXT, upstream TEXT, latency INTEGER, access_point_id TEXT,
    PRIMARY KEY (profile_id, timestamp, id)) WITHOUT ROWID;`);
  await aggregation.ensureRollupTables();

  const now = Math.floor(Date.now() / 1000);
  const curHour = Math.floor(now / H) * H;

  // A. live window [now-24h, now]: head = partial first hour
  let since = now - 86400;
  while (Math.ceil(since / H) * H - since < 1500) since -= 1800; // head >= 25 minutes
  const firstHour = Math.ceil(since / H) * H;
  let hours = 0;
  for (let h = firstHour; h <= curHour; h += H) { insRollup.run(P, "action", h, "PASS", "", "", 100); hours++; }
  insRollup.run(P, "action", firstHour - H, "PASS", "", "", 100); // hour containing since: must NOT be summed whole
  for (let h = firstHour; h <= curHour; h += H) insRollup.run(P, "domain", h, "a.com", "PASS", "", 100);
  insRollup.run(P, "domain", firstHour - H, "a.com", "PASS", "", 100);
  insRollup.run(P, "hit_domain", Math.floor((since + 130) / 60) * 60, "a.com", "PASS", "", 4);
  log(since + 5, 6); hit(since + 130, 4);   // inside the head
  log(since - 600, 5); hit(since - 600, 2); // before since: ignored

  const live = await model.getSummary(P, since, now);
  assert.strictEqual(total(live), hours * 100 + 6 + 4, "live window = whole hours + exact head");
  console.log(`  PASS: live window = ${hours} whole hours + 10 head events`);

  // every other analytics view must agree with the summary on the same window
  const trend = await model.getTrend(P, since, now, "(timestamp/3600)*3600");
  assert.strictEqual(total(trend), total(live), "trend = summary (head included)");
  const top = await model.getTopAllowed(P, since, now);
  assert.strictEqual(Number(top[0].count), hours * 100 + 6 + 4, "top domains include the head");
  console.log("  PASS: trend and top domains include the head");

  // B. window that ended in the past: tail = partial last hour. Its start (~32h ago) is older than the minute
  // buckets of cache hits are kept (see minuteDataFloor), so the head is NOT counted: the window starts at the
  // next full hour. The end (6h ago) is still inside the zone, so the tail stays exact.
  const until = curHour - 6 * H + 1200 + 10; // xx:20:10, six hours ago
  const since2 = until - 26 * H;
  assert.ok(since2 < minuteDataFloor(now) && until >= minuteDataFloor(now), "case B straddles the minute-data floor");
  const bodyFrom = Math.ceil(since2 / H) * H;
  const bodyEnd = Math.floor((until + 1) / H) * H;
  rawDb.exec("DELETE FROM logs; DELETE FROM hourly_rollups;");
  let hoursB = 0;
  for (let h = bodyFrom - H; h <= bodyEnd + H; h += H) {
    insRollup.run(P, "action", h, "PASS", "", "", 100);
    if (h >= bodyFrom && h < bodyEnd) hoursB++;
  }
  insRollup.run(P, "action", curHour, "PASS", "", "", 100); // keeps the newest rollup hour recent
  log(since2 + 1, 3); hit(since2 + 70, 1);   // head, in the deleted zone: must NOT be counted
  log(bodyEnd + 60, 7); hit(bodyEnd + 120, 2); // tail, inside
  log(until + 5, 9); hit(until + 120, 9);      // after until: ignored
  const past = await model.getSummary(P, since2, until);
  const expected = hoursB * 100 + 7 + 2;
  assert.strictEqual(total(past), expected, "past window = whole hours + exact tail (head aligned away)");
  console.log(`  PASS: past window = ${hoursB} whole hours + tail (head aligned to the hour)`);

  // D. minute alignment makes cache hits at the window edge exact
  const m = 100 * 86400 + 7 * 60 + 41; // 41 s into a minute
  assert.deepStrictEqual(alignRangeToMinutes(m - 86400, m, false), { since: m - 41 - 86400, until: m });
  assert.deepStrictEqual(alignRangeToMinutes(m - 600, m, true), { since: m - 41 - 600, until: m - 41 + 59 });
  rawDb.exec("DELETE FROM logs; DELETE FROM hourly_rollups;");
  let sA = Math.floor(now / 60) * 60 - 86400 - 3000;                // minute aligned, span >= 24h
  if (sA % H === 0) sA -= 60;                                       // keep a non-empty head
  const first = Math.ceil(sA / H) * H;
  for (let h = first; h <= curHour; h += H) insRollup.run(P, "action", h, "PASS", "", "", 100);
  insRollup.run(P, "hit_action", sA, "PASS", "", "", 3);            // the very first minute of the window
  insRollup.run(P, "hit_action", sA - 60, "PASS", "", "", 5);       // the minute before: must be ignored
  const hoursD = (curHour - first) / H + 1;
  const aligned = await model.getSummary(P, sA, now);
  assert.strictEqual(total(aligned), hoursD * 100 + 3, "first-minute hits are counted exactly");
  console.log("  PASS: minute-aligned window counts first-minute hits exactly");

  // E. cache policy: bucket (= TTL) grows with the window, past windows are cached longer
  const N = 100 * 86400 + 12 * H + 33;
  const pol = (r: string, span: number, endAgo = 0) => analyticsCachePolicy(r, N - endAgo - span, N - endAgo, false, N);
  assert.strictEqual(pol("1h", 3600).bucketSec, 60);
  assert.strictEqual(pol("24h", 86400 + 20).bucketSec, 60);
  assert.strictEqual(pol("7d", 604800 + 20).bucketSec, 300);
  assert.strictEqual(pol("30d", 2592000 + 20).bucketSec, 900);
  assert.strictEqual(analyticsCachePolicy(null, N - 7200 - 5 * H, N - 5 * H, true, N).bucketSec, 3600);
  assert.strictEqual(pol("30d", 2592000).windowKey, pol("30d", 2592000 + 37).windowKey, "same bucket -> same key");
  assert.notStrictEqual(pol("30d", 2592000).windowKey, analyticsCachePolicy("30d", 0, N + 900, false, N + 900).windowKey);
  console.log("  PASS: cache policy tiers");

  // C. planner tiles the window with no gap / overlap
  const p = planRollupQuery(since, now, curHour, now)!;
  assert.deepStrictEqual(p.head, { from: since, to: firstHour - 1 });
  assert.strictEqual(p.tail, null);
  assert.strictEqual(p.rollupFrom, firstHour);
  assert.strictEqual(p.rollupTo, curHour + H);
  console.log("  PASS: planner tiles the window");
}
run().then(() => console.log("OK")).catch((e) => { console.error(e); process.exit(1); });
