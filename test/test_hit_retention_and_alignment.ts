/**
 * @file test_hit_retention_and_alignment.ts
 * @description Minute buckets of cache hits (`hit_*`) are kept for HIT_RETENTION_SEC only, and a window that
 * reaches into the zone where they are gone is aligned to whole hours instead of returning a partial count:
 *   1. retention: hit_* rows follow their own (short) cutoff, never outlive the profile's retention, and the
 *      hourly rollups are untouched;
 *   2. the cutoff is long enough for everything the planner still reads minute by minute;
 *   3. head/tail edges below `minuteDataFloor` are dropped, short old windows come from the hourly rollups,
 *      a window without a full hour inside is empty, and the zone boundary is exact on both sides.
 * Runs on a frozen clock so no case depends on the minute or hour the test is started in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { initServerfullDb } from "../src/serverfull/db";
import { LogRetentionModel } from "../src/models/log/retention";
import {
  LogAggregationModel,
  HIT_RETENTION_SEC,
  hitRetentionCutoff,
  minuteDataFloor,
  planRollupQuery,
  planHitRange,
  describeAnalyticsWindow
} from "../src/models/log/aggregation";
import { LogAnalyticsModel } from "../src/models/log/analytics";

const ROOT = path.resolve(__dirname, "..");
const H = 3600;
const DAY = 86400;
// 12:20:33 on day 200: neither a minute nor an hour boundary.
const NOW = 200 * DAY + 12 * H + 1233;
const CUR_HOUR = Math.floor(NOW / H) * H;
const total = (rows: { count: number }[]) => rows.reduce((a, r) => a + Number(r.count), 0);

const realNow = Date.now;
Date.now = () => NOW * 1000;

function addProfile(db: any, id: string, retentionDays: number): void {
  db.rawDb
    .prepare("INSERT INTO profiles (id, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, id, JSON.stringify({ log_retention_days: retentionDays }), NOW, NOW);
}

function rollup(db: any, p: string, metric: string, ts: number, key: string, sub: string, count: number): void {
  db.rawDb
    .prepare(
      "INSERT INTO hourly_rollups (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id, count) VALUES (?,?,?,?,?,?,?)"
    )
    .run(p, metric, ts, key, sub, "", count);
}

let logId = 1;
function logRows(db: any, p: string, ts: number, n: number): void {
  const ins = db.rawDb.prepare(
    "INSERT INTO logs (profile_id, timestamp, id, client_ip, domain, record_type, action) VALUES (?, ?, ?, '1.2.3.4', 'a.com', 'A', 'PASS')"
  );
  for (let i = 0; i < n; i++) ins.run(p, ts, logId++);
}

const hitMetrics = ["hit_action", "hit_client", "hit_dest", "hit_domain"];
const hitCount = (db: any, p: string, metric: string, ts: number): number =>
  (db.rawDb
    .prepare("SELECT COALESCE(SUM(count),0) AS c FROM hourly_rollups WHERE profile_id = ? AND metric_type = ? AND hour_timestamp = ?")
    .get(p, metric, ts) as { c: number }).c;

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obex-hit-retention-"));
  const db: any = initServerfullDb(path.join(dir, "t.sqlite"), ROOT);
  try {
    const aggregation = new LogAggregationModel(db);
    await aggregation.ensureRollupTables();
    const analytics = new LogAnalyticsModel(db, aggregation);
    const cutoff = hitRetentionCutoff(NOW);
    const floor = minuteDataFloor(NOW);

    // ── 1. constants ────────────────────────────────────────────────────────
    assert.strictEqual(HIT_RETENTION_SEC, 26 * H);
    assert.strictEqual(cutoff % H, 0, "cutoff is hour-aligned");
    assert.ok(cutoff <= NOW - HIT_RETENTION_SEC && cutoff > NOW - HIT_RETENTION_SEC - H);
    assert.strictEqual(floor, cutoff + H, "queries trust minutes one hour above the deletion cutoff");
    // The oldest minute any 24h range needs (now - 24h - 59s) is above the floor at every second of the hour.
    for (let t = 0; t < H; t += 7) {
      const now = CUR_HOUR + t;
      const oldestNeeded = Math.floor(now / 60) * 60 - DAY;
      assert.ok(oldestNeeded - 1800 >= minuteDataFloor(now), `24h(+30min of head) stays exact at +${t}s`);
    }
    console.log("  ok: cutoff/floor constants cover the 24h range at every second of the hour");

    // ── 2. retention ────────────────────────────────────────────────────────
    addProfile(db, "r7", 7);
    addProfile(db, "r1", 1);
    for (const p of ["r7", "r1"]) {
      for (const m of hitMetrics) {
        for (const ts of [NOW - 3 * DAY, NOW - 30 * H, cutoff - 60, cutoff, floor + 120, NOW - H]) {
          rollup(db, p, m, Math.floor(ts / 60) * 60, "k", "", 1);
        }
      }
      for (const m of ["action", "client", "dest", "domain"]) {
        rollup(db, p, m, CUR_HOUR - 3 * DAY, "k", "", 1);
        rollup(db, p, m, CUR_HOUR - 30 * H, "k", "", 1);
      }
    }
    // old hourly rows beyond the 7-day retention
    rollup(db, "r7", "action", CUR_HOUR - 8 * DAY, "k", "", 1);

    const retention = new LogRetentionModel(db);
    await retention.cleanupGlobal(30, 0, 0, {}, { chunkSize: 100, yieldSleepMs: 0 });

    for (const m of hitMetrics) {
      assert.strictEqual(hitCount(db, "r7", m, NOW - 3 * DAY - ((NOW - 3 * DAY) % 60)), 0, `${m}: 3 days old is gone (7d profile)`);
      assert.strictEqual(hitCount(db, "r7", m, Math.floor((NOW - 30 * H) / 60) * 60), 0, `${m}: 30h old is gone`);
      assert.strictEqual(hitCount(db, "r7", m, cutoff - 60), 0, `${m}: one minute below the cutoff is gone`);
      assert.strictEqual(hitCount(db, "r7", m, cutoff), 1, `${m}: the cutoff hour itself is kept`);
      assert.strictEqual(hitCount(db, "r7", m, Math.floor((floor + 120) / 60) * 60), 1, `${m}: above the floor is kept`);
      assert.strictEqual(hitCount(db, "r7", m, Math.floor((NOW - H) / 60) * 60), 1, `${m}: recent is kept`);
    }
    // hourly rollups still follow the 7-day retention (unchanged behaviour)
    const hourly = (p: string, ts: number) =>
      (db.rawDb
        .prepare("SELECT COALESCE(SUM(count),0) AS c FROM hourly_rollups WHERE profile_id = ? AND metric_type = 'action' AND hour_timestamp = ?")
        .get(p, ts) as { c: number }).c;
    assert.strictEqual(hourly("r7", CUR_HOUR - 3 * DAY), 1, "3-day-old hourly rollup survives for a 7d profile");
    assert.strictEqual(hourly("r7", CUR_HOUR - 30 * H), 1);
    assert.strictEqual(hourly("r7", CUR_HOUR - 8 * DAY), 0, "8-day-old hourly rollup is purged");
    console.log("  ok: hit_* use their own cutoff; hourly rollups keep the profile retention");

    // a 1-day profile: the profile retention (24h) is shorter than the hit retention, so it wins
    for (const m of hitMetrics) {
      assert.strictEqual(hitCount(db, "r1", m, Math.floor((NOW - 30 * H) / 60) * 60), 0);
      assert.strictEqual(hitCount(db, "r1", m, Math.floor((NOW - H) / 60) * 60), 1);
    }
    // floor + 120 is ~25h old: older than the 24h profile retention
    const f120 = Math.floor((floor + 120) / 60) * 60;
    assert.strictEqual(floor + 120 < NOW - DAY, true);
    for (const m of hitMetrics) assert.strictEqual(hitCount(db, "r1", m, f120), 0, "never outlives the profile retention");
    console.log("  ok: hit_* never outlive the profile's own retention");

    // ── 3. planner ─────────────────────────────────────────────────────────
    const latest = CUR_HOUR;
    // start above the floor: head is kept (24h range)
    const above = Math.floor(NOW / 60) * 60 - DAY;
    const pAbove = planRollupQuery(above, NOW, latest, NOW)!;
    assert.deepStrictEqual(pAbove.head, { from: above, to: Math.ceil(above / H) * H - 1 });
    // start below the floor: no head, window starts at the next full hour
    const below = floor - 3000;
    const pBelow = planRollupQuery(below, NOW, latest, NOW)!;
    assert.strictEqual(pBelow.head, null);
    assert.strictEqual(pBelow.rollupFrom, floor);
    // an end below the floor: no tail
    const endOld = CUR_HOUR - 3 * DAY + 1210;
    const pOld = planRollupQuery(endOld - 5 * H, endOld, latest, NOW)!;
    assert.strictEqual(pOld.tail, null);
    assert.strictEqual(pOld.head, null);
    assert.strictEqual(pOld.rollupTo, Math.floor((endOld + 1) / H) * H);
    // an end above the floor keeps its tail
    const endRecent = CUR_HOUR - 6 * H + 1210;
    assert.deepStrictEqual(
      planRollupQuery(endRecent - 26 * H, endRecent, latest, NOW)!.tail,
      { from: Math.floor((endRecent + 1) / H) * H, to: endRecent }
    );
    // short range below the floor: hourly rollups, whole hours only; no full hour -> empty plan
    assert.ok(planRollupQuery(endOld - 5 * H, endOld, latest, NOW) !== null);
    const empty = planRollupQuery(CUR_HOUR - 3 * DAY + 600, CUR_HOUR - 3 * DAY + 2400, latest, NOW)!;
    assert.deepStrictEqual(empty, { rollupFrom: 0, rollupTo: 0, head: null, tail: null, raw: null });
    // short range above the floor is still answered from raw rows + minute buckets
    assert.strictEqual(planRollupQuery(NOW - 3600, NOW, latest, NOW), null);
    // hit minute buckets are only added while they exist
    assert.deepStrictEqual(planHitRange(NOW - 600, NOW, NOW), { from: Math.ceil((NOW - 600) / 60) * 60, to: NOW });
    assert.strictEqual(planHitRange(floor - 600, floor + 600, NOW), null);
    assert.ok(planHitRange(floor, floor + 600, NOW) !== null, "exactly at the floor still counts as kept");
    console.log("  ok: planner aligns to hours below the floor, stays exact above it");

    // ── 4. queries ─────────────────────────────────────────────────────────
    const P = "a";
    for (let h = CUR_HOUR - 8 * DAY; h <= CUR_HOUR; h += H) {
      rollup(db, P, "action", h, "PASS", "", 100);
      rollup(db, P, "domain", h, "a.com", "PASS", 100);
    }
    const hit = (ts: number, n: number) => {
      rollup(db, P, "hit_action", Math.floor(ts / 60) * 60, "PASS", "", n);
      rollup(db, P, "hit_domain", Math.floor(ts / 60) * 60, "a.com", "PASS", n);
    };
    const wholeHours = (from: number, to: number) => (to - from) / H; // hours in [from, to)

    // 4a. live 7-day range: start is below the floor -> aligned up, partial first hour is not counted
    {
      const since = Math.floor(NOW / 60) * 60 - 7 * DAY;
      const first = Math.ceil(since / H) * H;
      logRows(db, P, since + 5, 6); // raw rows exist, their cache hits do not: must NOT be counted
      hit(since + 130, 4);          // a minute bucket that retention would already have removed
      const expected = (wholeHours(first, CUR_HOUR) + 1) * 100;
      assert.strictEqual(total(await analytics.getSummary(P, since, NOW)), expected, "7d summary = whole hours");
      assert.strictEqual(total(await analytics.getTrend(P, since, NOW, "(timestamp/3600)*3600")), expected, "7d trend");
      assert.strictEqual(Number((await analytics.getTopAllowed(P, since, NOW))[0].count), expected, "7d top domains");
      console.log("  ok: 7d range = whole hours from the next full hour (no partial first hour)");
    }

    // 4b. the zone boundary, live window: just above keeps an exact head, just below drops it
    {
      logRows(db, P, floor + 60, 5);   // before `sAbove`: ignored
      hit(floor + 60, 1);
      const sAbove = floor + 120;
      logRows(db, P, sAbove + 5, 3);   // head, counted
      hit(floor + 180, 2);             // head, counted
      const firstAbove = floor + H;
      const expAbove = (wholeHours(firstAbove, CUR_HOUR) + 1) * 100 + 3 + 2;
      assert.strictEqual(total(await analytics.getSummary(P, sAbove, NOW)), expAbove, "just above the floor: exact head");
      assert.strictEqual(Number((await analytics.getTopAllowed(P, sAbove, NOW))[0].count), expAbove);

      logRows(db, P, floor - 2000, 7); // in the deleted zone: ignored
      const sBelow = floor - 3000;
      const expBelow = (wholeHours(floor, CUR_HOUR) + 1) * 100;
      assert.strictEqual(total(await analytics.getSummary(P, sBelow, NOW)), expBelow, "just below the floor: aligned to the hour");
      console.log("  ok: boundary — above the floor the head is exact, below it the window is hour-aligned");
    }

    // 4c. old, short window (< 24h): whole hours from the rollups, both partial edges dropped
    {
      const base = CUR_HOUR - 3 * DAY;
      const since = base - 4 * H + 1200;
      const until = base + 1210;
      logRows(db, P, since + 5, 3);
      logRows(db, P, base + 60, 4);
      hit(since + 130, 2);
      hit(base + 120, 2);
      assert.strictEqual(total(await analytics.getSummary(P, since, until)), 3 * 100, "3 whole hours inside the window");
      assert.strictEqual(total(await analytics.getTrend(P, since, until, "(timestamp/3600)*3600")), 3 * 100);
      assert.strictEqual(Number((await analytics.getTopAllowed(P, since, until))[0].count), 3 * 100);
      console.log("  ok: old short window = whole hours only (head and tail dropped)");

      // 4d. no full hour inside -> empty, not a partial raw count
      const s2 = base + 600;
      const u2 = base + 2400;
      logRows(db, P, base + 700, 9);
      assert.strictEqual(total(await analytics.getSummary(P, s2, u2)), 0);
      assert.strictEqual(total(await analytics.getTrend(P, s2, u2, "(timestamp/3600)*3600")), 0);
      assert.strictEqual((await analytics.getTopAllowed(P, s2, u2)).length, 0);
      console.log("  ok: old window without a full hour is empty");
    }

    // 4e. no rollups at all for the profile: raw rows are the only data, so they are answered exactly
    {
      const base = CUR_HOUR - 3 * DAY;
      logRows(db, "norollup", base + 700, 9);
      assert.strictEqual(total(await analytics.getSummary("norollup", base + 600, base + 2400)), 9);
      console.log("  ok: profile without rollups still answers from raw rows");
    }

    // 4g. a window in the past that sits entirely inside the minute-data zone keeps BOTH edges exact
    {
      const until = CUR_HOUR - H + 1210;     // xx:20:10, one hour ago
      const since = until - DAY - 30;        // ~24h before: just above the floor (floor + 1180s)
      assert.ok(since >= floor && since - floor < H);
      const bodyFrom = Math.ceil(since / H) * H;
      const bodyEnd = Math.floor((until + 1) / H) * H;
      logRows(db, P, since + 5, 3);          // head, counted
      hit(since + 130, 2);                   // head, counted
      logRows(db, P, bodyEnd + 60, 5);       // tail, counted
      hit(bodyEnd + 180, 4);                 // tail, counted
      logRows(db, P, until + 30, 8);         // after until: ignored
      hit(until + 120, 8);
      const expected = wholeHours(bodyFrom, bodyEnd) * 100 + 3 + 2 + 5 + 4;
      assert.strictEqual(total(await analytics.getSummary(P, since, until)), expected, "head and tail exact inside the zone");
      assert.strictEqual(total(await analytics.getTrend(P, since, until, "(timestamp/3600)*3600")), expected);
      console.log("  ok: a past window inside the minute-data zone keeps an exact head and tail");
    }

    // 4f. the retention job does not remove anything a 24h range still reads
    {
      const since = Math.floor(NOW / 60) * 60 - DAY;
      const headMinute = Math.ceil(since / 60) * 60 + 60;
      rollup(db, "keep", "action", CUR_HOUR, "PASS", "", 100);
      rollup(db, "keep", "hit_action", headMinute, "PASS", "", 5);
      addProfile(db, "keep", 7);
      await retention.cleanupGlobal(30, 0, 0, {}, { chunkSize: 100, yieldSleepMs: 0 });
      assert.strictEqual(hitCount(db, "keep", "hit_action", headMinute), 5, "24h head minute survives the cleanup");
      assert.strictEqual(total(await analytics.getSummary("keep", since, NOW)), 105);
      console.log("  ok: cleanup keeps every minute bucket a 24h range reads");
    }

    // 4g. a custom end shortly BEFORE now is a real boundary: events after it must not be added (the live
    //     hour is only owned by a window whose end is now; a relative end may lag now by a few seconds).
    {
      const since = CUR_HOUR - 30 * H;
      const customEnd = Math.floor((NOW - 90) / 60) * 60 + 59; // :59 of a minute that already ended
      const p1 = planRollupQuery(since, customEnd, CUR_HOUR, NOW)!;
      assert.strictEqual(p1.rollupTo, CUR_HOUR, "custom end 90s ago: the current hour is not taken whole");
      assert.deepStrictEqual(p1.tail, { from: CUR_HOUR, to: customEnd }, "its tail is read exactly");
      const p2 = planRollupQuery(since, NOW - 3, CUR_HOUR, NOW)!;
      assert.strictEqual(p2.rollupTo, CUR_HOUR + H, "relative end 3s behind the planner clock is still live");
      assert.strictEqual(p2.tail, null);
      const p3 = planRollupQuery(since, Math.floor(NOW / 60) * 60 + 59, CUR_HOUR, NOW)!;
      assert.strictEqual(p3.rollupTo, CUR_HOUR + H, "custom end in the current minute (still in the future) is live");
      console.log("  ok: a custom end before now is not treated as live");
    }

    // 4h. the API tells the client which window the numbers really cover
    {
      const floor = minuteDataFloor(NOW);
      // exact: above the floor
      const e = describeAnalyticsWindow(floor + 120, NOW, NOW);
      assert.deepStrictEqual(e, { aligned: false, tooOld: false, alignedSince: floor + 120, alignedUntil: NOW });
      // live 7d: start moves up to the next full hour, end stays "now"
      const since7 = Math.floor(NOW / 60) * 60 - 7 * DAY;
      const d7 = describeAnalyticsWindow(since7, NOW, NOW);
      assert.strictEqual(d7.aligned, true);
      assert.strictEqual(d7.alignedSince, Math.ceil(since7 / H) * H);
      assert.strictEqual(d7.alignedUntil, NOW);
      // hour-aligned start and live end: nothing to report
      assert.strictEqual(describeAnalyticsWindow(CUR_HOUR - 7 * DAY, NOW, NOW).aligned, false);
      // old window with whole hours inside: both edges move inwards
      const oldSince = CUR_HOUR - 3 * DAY + 1200; // xx:20
      const oldUntil = CUR_HOUR - 3 * DAY + 4 * H + 600 + 59; // xx:10:59, four hours later
      const dOld = describeAnalyticsWindow(oldSince, oldUntil, NOW);
      assert.deepStrictEqual(dOld, {
        aligned: true,
        tooOld: false,
        alignedSince: CUR_HOUR - 3 * DAY + H,
        alignedUntil: CUR_HOUR - 3 * DAY + 4 * H - 1
      });
      // old window without a full hour inside: no exact answer, and the planner agrees (zero rows)
      const tSince = CUR_HOUR - 3 * DAY + 1200;
      const tUntil = CUR_HOUR - 3 * DAY + 4200 + 59; // 10:20 -> 11:10:59
      const dTo = describeAnalyticsWindow(tSince, tUntil, NOW);
      assert.deepStrictEqual(dTo, { aligned: true, tooOld: true, alignedSince: null, alignedUntil: null });
      const pl = planRollupQuery(tSince, tUntil, CUR_HOUR, NOW)!;
      assert.deepStrictEqual([pl.rollupFrom, pl.rollupTo, pl.head, pl.tail, pl.raw], [0, 0, null, null, null]);
      console.log("  ok: describeAnalyticsWindow reports the window the planner really answers");
    }
  } finally {
    Date.now = realNow;
    db.rawDb?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log("OK"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
