/**
 * @file test_log_events.ts
 * @description Query Logs record events (why a row exists), not cache misses.
 *   1. domainState decisions: new / unchanged / recheck / changed (set comparison) / rate limit / background rules.
 *   2. A cache clear (list update) with the same answer writes NO row, but the query is still counted (Analytics exact).
 *   3. A changed answer writes a 'changed' row with the previous answer.
 *   4. A lazy-cache refresh that finds a different answer writes a 'refreshed' row and takes the cache hit it was
 *      counted as back out, so the query is counted once.
 *   5. A failed refresh writes one rate-limited 'error' row that keeps the served action (PASS).
 *   6. BLOCK / REDIRECT follow the same rules; PASS -> BLOCK after a list update is a 'changed' event.
 *   7. Deleting logs forgets the domain state.
 *   8. Migration 0070 + LogCoreModel store and return event / prev_answer.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  observeAnswer,
  snapshotFromAnswer,
  snapshotFromSynthetic,
  allowRefreshError,
  domainStateKey,
  domainStateSize,
  resetDomainState,
  clearDomainStateFor
} from "../src/pipeline/domainState";
import { dnsCache } from "../src/pipeline/cache";
import { recordSuccessAndCache } from "../src/pipeline/resolver/observability";
import { handleBlockOrRedirect } from "../src/pipeline/resolver/block";
import { flushAllPending, recordCacheHit, discardPendingLogs } from "../src/pipeline/logBatcher";
import { LogCoreModel } from "../src/models/log/core";

// flushLogBatch reads the Workers Cache API; none exists under Node.
(globalThis as any).caches = { default: undefined };

// The log batcher defers its flush by 15s through ctx.waitUntil; let the test harness wait for it instantly.
const realSetTimeout = globalThis.setTimeout;
(globalThis as any).setTimeout = (fn: (...a: any[]) => void, ms?: number, ...rest: any[]) =>
  realSetTimeout(fn, ms !== undefined && ms >= 10_000 ? 0 : ms, ...rest);

interface Stmt { sql: string; args: any[] }

function makeHarness() {
  const batches: Stmt[][] = [];
  const pending: Promise<unknown>[] = [];
  const env: any = {
    DB: {
      prepare(sql: string) {
        return { bind: (...args: any[]) => ({ sql, args, first: async () => null }) };
      },
      async batch(stmts: Stmt[]) {
        batches.push(stmts);
        return stmts.map(() => ({ meta: { changes: 1 } }));
      }
    }
  };
  const ctx: any = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  const settle = async () => {
    await Promise.all(pending.splice(0));
    await flushAllPending(env, ctx);
    await Promise.all(pending.splice(0));
  };
  const rows = () => batches.flat().filter((s) => s.sql.startsWith("INSERT INTO logs")).map((s) => ({
    ts: s.args[1], domain: s.args[6], type: s.args[7], action: s.args[8], reason: s.args[9], answer: s.args[10],
    event: s.args[21], prev: s.args[22], latency: s.args[14]
  }));
  /** Sum of the `action` metric over every statement of the hourly rollups (log-derived and hit counters). */
  const actionTotal = (action: string) =>
    batches.flat().filter((s) => s.sql.includes("hourly_rollups") && s.args[1] === "action" && s.args[3] === action)
      .reduce((n, s) => n + Number(s.args[6]), 0);
  return { env, ctx, settle, rows, actionTotal };
}

const req = new Request("https://dns.example.com/dns-query", { headers: { "CF-Connecting-IP": "10.1.1.1" } });
const settings: any = { log_retention_days: 7, block_mode: "NULL_IP" };
const query = (name = "cdn.example.com", type = "A") => ({ name, type, raw: new Uint8Array([0, 0]) }) as any;
const recs = (...ips: string[]) => ips.map((data) => ({ name: "cdn.example.com", type: "A", data, ttl: 60 }));
const wire = (rcode = 0) => { const b = new Uint8Array(12); b[3] = rcode; return b; };
const mkCtx = (h: ReturnType<typeof makeHarness>, extra: any = {}): any => ({
  profileId: "pe", accessPointId: "ap1", startTime: Date.now(), env: h.env, ctx: h.ctx, ...extra
});

async function main(): Promise<void> {
  console.log(">>> [TEST] Query Log events\n");

  console.log("1. domainState decisions");
  {
    resetDomainState();
    const key = domainStateKey("p", "a.com", "A");
    const snap = (...ips: string[]) => snapshotFromAnswer("PASS", "A", 0, recs(...ips));
    const t0 = 1_000_000;
    assert.strictEqual(observeAnswer(key, snap("1.1.1.1", "2.2.2.2"), { background: false, now: t0 }).event, "new");
    assert.strictEqual(observeAnswer(key, snap("1.1.1.1", "2.2.2.2"), { background: false, now: t0 + 5_000 }).event, null, "same answer: no row");
    assert.strictEqual(observeAnswer(key, snap("2.2.2.2", "1.1.1.1"), { background: false, now: t0 + 6_000 }).event, null, "round-robin order is not a change");
    assert.strictEqual(observeAnswer(key, snap("1.1.1.1", "2.2.2.2"), { background: true, now: t0 + 7_000 }).event, null, "refresh with same answer: no row");

    const changed = observeAnswer(key, snap("3.3.3.3"), { background: false, now: t0 + 8_000 });
    assert.strictEqual(changed.event, "changed");
    assert.strictEqual(changed.prevAnswer, "1.1.1.1, 2.2.2.2");
    // Rate limit: a CDN that rotates constantly must not flood the log, but the newest answer is still remembered.
    assert.strictEqual(observeAnswer(key, snap("4.4.4.4"), { background: false, now: t0 + 20_000 }).event, null, "rate limited");
    const later = observeAnswer(key, snap("5.5.5.5"), { background: true, now: t0 + 8_000 + 601_000 });
    assert.strictEqual(later.event, "refreshed", "found by a background refresh");
    assert.strictEqual(later.prevAnswer, "4.4.4.4", "compared with the newest remembered answer, not the last logged one");

    // Same answer, logged long ago: re-logged once so the domain stays findable.
    const dayLater = t0 + 8_000 + 601_000 + 25 * 3600 * 1000;
    assert.strictEqual(observeAnswer(key, snap("5.5.5.5"), { background: false, now: dayLater }).event, "recheck");
    assert.strictEqual(observeAnswer(key, snap("5.5.5.5"), { background: false, now: dayLater + 1000 }).event, null);
    // ... but never later than half the log retention (1 day retention -> 12h).
    const k2 = domainStateKey("p", "b.com", "A");
    observeAnswer(k2, snap("1.1.1.1"), { background: false, now: t0 });
    assert.strictEqual(observeAnswer(k2, snap("1.1.1.1"), { background: false, now: t0 + 13 * 3600 * 1000, settings: { log_retention_days: 1 } }).event, "recheck");

    // A background refresh with no memory only remembers.
    const k3 = domainStateKey("p", "c.com", "A");
    assert.strictEqual(observeAnswer(k3, snap("1.1.1.1"), { background: true, now: t0 }).event, null);
    assert.strictEqual(observeAnswer(k3, snap("1.1.1.1"), { background: false, now: t0 + 1000 }).event, null, "already remembered");

    // Other record types only report presence/absence, not payload rotation (ECH configs, ...).
    const k4 = domainStateKey("p", "d.com", "HTTPS");
    const https = (data: string) => snapshotFromAnswer("PASS", "HTTPS", 0, [{ type: "HTTPS", data }]);
    observeAnswer(k4, https("ech=AAA"), { background: false, now: t0 });
    assert.strictEqual(observeAnswer(k4, https("ech=BBB"), { background: false, now: t0 + 1000 }).event, null);
    assert.strictEqual(observeAnswer(k4, snapshotFromAnswer("PASS", "HTTPS", 0, []), { background: false, now: t0 + 2000 }).event, "changed");

    // NOERROR -> NXDOMAIN is a change.
    const k5 = domainStateKey("p", "e.com", "A");
    observeAnswer(k5, snapshotFromAnswer("PASS", "A", 0, recs("1.1.1.1")), { background: false, now: t0 });
    assert.strictEqual(observeAnswer(k5, snapshotFromAnswer("PASS", "A", 3, []), { background: false, now: t0 + 1000 }).event, "changed");

    // Error rows are rate limited per key.
    const k6 = domainStateKey("p", "f.com", "A");
    assert.strictEqual(allowRefreshError(k6, undefined, t0), true);
    assert.strictEqual(allowRefreshError(k6, undefined, t0 + 1000), false);
    assert.strictEqual(allowRefreshError(k6, undefined, t0 + 901_000), true);
    assert.strictEqual(observeAnswer(k6, snap("1.1.1.1"), { background: false, now: t0 + 902_000 }).event, "new", "error placeholder is not an answer");

    // Profile-scoped clearing.
    clearDomainStateFor(["p"]);
    assert.strictEqual(domainStateSize(), 0);
    console.log("   ✓");
  }

  console.log("2. cache clear + same answer: no row, but the query is still counted");
  {
    resetDomainState(); dnsCache.clear();
    const h = makeHarness();
    const ctx = mkCtx(h);
    recordSuccessAndCache(req, query(), ctx, settings, "PASS", undefined, recs("10.0.0.1", "10.0.0.2"), wire(), 60, "https://u/dns-query");
    await h.settle();
    dnsCache.clear(); // what a list update does
    recordSuccessAndCache(req, query(), mkCtx(h), settings, "PASS", undefined, recs("10.0.0.2", "10.0.0.1"), wire(), 60, "https://u/dns-query");
    await h.settle();
    const rows = h.rows();
    assert.strictEqual(rows.length, 1, "second miss wrote no row");
    assert.strictEqual(rows[0].event, "new");
    assert.strictEqual(rows[0].answer, "10.0.0.1, 10.0.0.2");
    assert.strictEqual(rows[0].prev, null);
    assert.strictEqual(h.actionTotal("PASS"), 2, "both queries counted in Analytics");
    console.log("   ✓");
  }

  console.log("3. changed answer: row with the previous answer");
  {
    resetDomainState(); dnsCache.clear();
    const h = makeHarness();
    recordSuccessAndCache(req, query(), mkCtx(h), settings, "PASS", undefined, recs("10.3.0.1"), wire(), 60, "https://u/dns-query");
    dnsCache.clear();
    recordSuccessAndCache(req, query(), mkCtx(h), settings, "PASS", undefined, recs("10.2.2.2"), wire(), 60, "https://u/dns-query", undefined, "203.0.113.0/24");
    // second one used another ECS scope => its own memory => 'new', not 'changed'
    await h.settle();
    assert.deepStrictEqual(h.rows().map((r) => r.event), ["new", "new"], "different ECS scope is a different key");

    dnsCache.clear();
    recordSuccessAndCache(req, query(), mkCtx(h), settings, "PASS", undefined, recs("10.4.0.2"), wire(), 60, "https://u/dns-query");
    await h.settle();
    const last = h.rows().at(-1)!;
    assert.strictEqual(last.event, "changed");
    assert.strictEqual(last.prev, "10.3.0.1");
    assert.strictEqual(last.answer, "10.4.0.2");
    console.log("   ✓");
  }

  console.log("4. lazy refresh finds a different answer: 'refreshed' row, counted once");
  {
    resetDomainState(); dnsCache.clear();
    const h = makeHarness();
    const key = "pe:cdn.example.com:A";
    recordSuccessAndCache(req, query(), mkCtx(h), settings, "PASS", undefined, recs("10.0.0.1"), wire(), 60, "https://u/dns-query");
    await h.settle();
    assert.strictEqual(dnsCache.get(key)?.countHits, true);

    // The client's query is served stale and counted as a cache hit (what pipeline/index.ts does)...
    recordCacheHit({ profileId: "pe", accessPointId: "ap1", timestamp: Math.floor(Date.now() / 1000), action: "PASS", domain: "cdn.example.com", clientIp: "10.1.1.1", geoCountry: "LAN" }, h.env, h.ctx);
    // ...and the background refresh brings a different answer.
    recordSuccessAndCache(req, query(), mkCtx(h, { isBackgroundRefresh: true }), settings, "PASS", undefined, recs("10.9.9.9"), wire(), 60, "https://u/dns-query");
    await h.settle();
    const rows = h.rows();
    assert.deepStrictEqual(rows.map((r) => r.event), ["new", "refreshed"]);
    assert.strictEqual(rows[1].prev, "10.0.0.1");
    assert.strictEqual(rows[1].answer, "10.9.9.9");
    assert.strictEqual(h.actionTotal("PASS"), 2, "2 client queries: miss + stale hit; the refresh did not add one");

    // Refresh with the same answer: still silent.
    recordSuccessAndCache(req, query(), mkCtx(h, { isBackgroundRefresh: true }), settings, "PASS", undefined, recs("10.9.9.9"), wire(), 60, "https://u/dns-query");
    await h.settle();
    assert.strictEqual(h.rows().length, 2);

    // No row when the stale hit was not counted (policy off for that entry).
    dnsCache.get(key)!.countHits = false;
    recordSuccessAndCache(req, query(), mkCtx(h, { isBackgroundRefresh: true }), settings, "PASS", undefined, recs("10.7.7.7"), wire(), 60, "https://u/dns-query");
    await h.settle();
    assert.strictEqual(h.rows().length, 2);
    console.log("   ✓");
  }

  console.log("5. failed refresh: one 'error' row, action stays PASS");
  {
    resetDomainState(); dnsCache.clear();
    const h = makeHarness();
    recordSuccessAndCache(req, query(), mkCtx(h), settings, "PASS", undefined, recs("10.0.0.1"), wire(), 60, "https://u/dns-query");
    await h.settle();
    const old = dnsCache.get("pe:cdn.example.com:A");
    recordCacheHit({ profileId: "pe", accessPointId: "ap1", timestamp: Math.floor(Date.now() / 1000), action: "PASS", domain: "cdn.example.com", clientIp: "10.1.1.1", geoCountry: "LAN" }, h.env, h.ctx);
    recordSuccessAndCache(req, query(), mkCtx(h, { isBackgroundRefresh: true }), settings, "PASS", undefined, [], wire(2), 60, "https://u/dns-query");
    recordSuccessAndCache(req, query(), mkCtx(h, { isBackgroundRefresh: true }), settings, "PASS", undefined, [], wire(2), 60, "https://u/dns-query");
    await h.settle();
    assert.strictEqual(dnsCache.get("pe:cdn.example.com:A"), old, "good entry kept");
    const rows = h.rows();
    assert.deepStrictEqual(rows.map((r) => r.event), ["new", "error"], "second failure is rate limited");
    assert.strictEqual(rows[1].action, "PASS");
    assert.ok(String(rows[1].reason).startsWith("Refresh failed: SERVFAIL"));
    assert.strictEqual(h.actionTotal("PASS"), 2);
    assert.strictEqual(h.actionTotal("FAIL"), 0, "the client never saw a failure");
    console.log("   ✓");
  }

  console.log("6. BLOCK follows the same rules");
  {
    resetDomainState(); dnsCache.clear();
    const h = makeHarness();
    // PASS first, then a list update turns the domain into a BLOCK.
    recordSuccessAndCache(req, query("ads.example"), mkCtx(h), settings, "PASS", undefined, recs("10.5.5.5"), wire(), 60, "https://u/dns-query");
    await h.settle();
    dnsCache.clear();
    await handleBlockOrRedirect(req, query("ads.example"), mkCtx(h), settings, "BLOCK", "Ads list");
    await h.settle();
    dnsCache.clear();
    await handleBlockOrRedirect(req, query("ads.example"), mkCtx(h), settings, "BLOCK", "Ads list");
    await h.settle();
    const rows = h.rows();
    assert.deepStrictEqual(rows.map((r) => `${r.action}:${r.event}`), ["PASS:new", "BLOCK:changed"]);
    assert.strictEqual(rows[1].prev, "10.5.5.5");
    assert.strictEqual(rows[1].reason, "Ads list");
    assert.strictEqual(h.actionTotal("BLOCK"), 2, "both blocked queries counted");
    assert.strictEqual(h.actionTotal("PASS"), 1);
    console.log("   ✓");
  }

  console.log("7. deleting logs forgets the domain state");
  {
    resetDomainState(); dnsCache.clear();
    const h = makeHarness();
    recordSuccessAndCache(req, query(), mkCtx(h), settings, "PASS", undefined, recs("10.0.0.1"), wire(), 60, "https://u/dns-query");
    await h.settle();
    discardPendingLogs("pe");
    dnsCache.clear();
    recordSuccessAndCache(req, query(), mkCtx(h), settings, "PASS", undefined, recs("10.0.0.1"), wire(), 60, "https://u/dns-query");
    await h.settle();
    // The first row was already written before the "deletion" (this harness has no real table to delete from);
    // what matters is that the second miss is logged as 'new' again instead of being treated as "same as before".
    assert.deepStrictEqual(h.rows().map((r) => r.event), ["new", "new"], "after deleting logs the domain is new again");
    console.log("   ✓");
  }

  console.log("8. migration 0070 and LogCoreModel");
  {
    const db = new DatabaseSync(":memory:");
    const dir = path.join(process.cwd(), "migrations");
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    const adapter: any = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              sql, params,
              run: async () => { db.prepare(sql).run(...(params as never[])); return { success: true }; },
              all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
              first: async () => db.prepare(sql).get(...(params as never[])) ?? null
            };
          }
        };
      }
    };
    const model = new LogCoreModel(adapter, {} as never);
    await model.insert({ profile_id: "p", timestamp: 100, id: 1, client_ip: "1.1.1.1", geo_country: "VN", domain: "a.com", record_type: "A", action: "PASS", answer: "2.2.2.2", event: "changed", prev_answer: "1.1.1.1" });
    await model.insert({ profile_id: "p", timestamp: 101, id: 2, client_ip: "1.1.1.1", geo_country: "VN", domain: "a.com", record_type: "A", action: "PASS", answer: "2.2.2.2" });
    const list = await model.getLogs("p", { since: 0, until: 1000 } as never);
    const byId = new Map(list.map((r: any) => [Number(r.id), r]));
    assert.strictEqual(byId.get(1).event, "changed");
    assert.strictEqual(byId.get(1).prev_answer, "1.1.1.1");
    assert.strictEqual(byId.get(2).event, null, "old-style rows keep a NULL event");
    // getLog() selects l.* (and joins profiles, which this bare schema has no row for): check the stored columns directly.
    const stored: any = db.prepare("SELECT event, prev_answer FROM logs WHERE id = 1").get();
    assert.deepStrictEqual({ ...stored }, { event: "changed", prev_answer: "1.1.1.1" });
    const exported = await model.getLogs("p", { since: 0, until: 1000, export: true } as never);
    assert.ok(exported.some((r: any) => r.event === "changed" && r.prev_answer === "1.1.1.1"));
    console.log("   ✓");
  }

  console.log("\n  LOG EVENT TESTS PASSED\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
