/**
 * @file test_block_mark_release.ts
 * @description
 *   - A BLOCK "already logged" mark must not outlive a log that never reached the database
 *     (full queue, failed write overflowing the queue).
 *   - REDIRECT CNAME: a NOERROR/NODATA upstream answer (e.g. AAAA for a target without IPv6) is a
 *     complete answer and is cached; upstream failures (SERVFAIL, FAIL) are not.
 *   - A static CNAME answer for non-A/AAAA types (HTTPS, TXT, ...) is complete and cached.
 */
import assert from "node:assert";
import { dnsCache, isBlockLogged, clearAllBlockLogMarks } from "../src/pipeline/cache";
import { pipeline } from "../src/pipeline";
import { handleBlockOrRedirect } from "../src/pipeline/resolver/block";
import { flushAllPending, enqueueLog, droppedLogCount, pendingLogCount } from "../src/pipeline/logBatcher";
import { buildDNSQuery, buildResponse } from "../src/utils/dns";

(globalThis as any).caches = { default: undefined };

let dbFail = false;
let onBatch: (() => void) | null = null;
const batches: any[][] = [];
const db: any = {
  prepare(sql: string) {
    return { bind: (...args: any[]) => ({ sql, args, first: async () => null, run: async () => ({ success: true, meta: { changes: 1 } }), all: async () => ({ results: [] }) }) };
  },
  async batch(stmts: any[]) {
    if (onBatch) { const f = onBatch; onBatch = null; f(); throw new Error("SQLITE_BUSY"); }
    if (dbFail) throw new Error("SQLITE_FULL: disk full");
    batches.push(stmts);
    return stmts.map(() => ({ meta: { changes: 1 } }));
  }
};
const env: any = { DB: db, LOG_QUEUE_MAX_ROWS: 100 };
const pending: Promise<any>[] = [];
const ctx: any = { waitUntil: (p: Promise<any>) => { pending.push(p); } };
const mkCtx = () => ({ profileId: "p1", accessPointId: "ap1", startTime: Date.now(), env, ctx }) as any;
const mkQ = (name: string, type = "A") => ({ name, type, raw: buildDNSQuery(name, type) }) as any;
const req = () => new Request("https://x/dns-query", { headers: { "CF-Connecting-IP": "10.0.0.2" } });
const settings: any = { log_retention_days: 7, block_mode: "NULL_IP" };
const rows = (d: string, action?: string) =>
  batches.flat().filter((r) => r.sql.includes("INSERT INTO logs") && r.args.includes(d) && (!action || r.args.includes(action))).length;
const hitCount = (action: string) =>
  batches.flat().filter((r) => r.sql.includes("hourly_rollups") && r.args[1] === "hit_action" && r.args[3] === action).reduce((n, r) => n + r.args[6], 0);
const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const settle = async () => { await Promise.all(pending.splice(0)); await flushAllPending(env); };
const pass = (name: string, i: number) =>
  ({ profile_id: "other", timestamp: 1, client_ip: "1.1.1.1", geo_country: "VN", domain: `${name}${i}.x`, record_type: "A", action: "PASS", answer: "", latency: 1 }) as any;
const block = (name: string, type = "A") => handleBlockOrRedirect(req(), mkQ(name, type), mkCtx(), settings, "BLOCK", "Blacklist: t");

async function main() {
  console.log(">>> [TEST] block mark release + redirect NODATA cache");

  // 1. Queue full: the dropped BLOCK log releases its mark, so the domain is logged later.
  {
    dnsCache.clear(); clearAllBlockLogMarks(); batches.length = 0;
    dbFail = true;
    for (let i = 0; i < 400; i++) enqueueLog(pass("f", i), settings, env, ctx);
    await Promise.all(pending.splice(0));
    assert.strictEqual(pendingLogCount(), 100, "queue at the cap");
    const dropped = droppedLogCount();
    await block("full.example");
    await Promise.all(pending.splice(0));
    assert.strictEqual(droppedLogCount(), dropped + 1, "the block log was dropped");
    assert.strictEqual(isBlockLogged("p1", "full.example"), false, "mark released with the dropped log");
    dbFail = false;
    await settle();
    await block("full.example");
    await settle();
    assert.strictEqual(rows("full.example"), 1, "logged once the queue has room");
    assert.strictEqual(isBlockLogged("p1", "full.example"), true);
    console.log("  ok: queue-full drop releases the mark");
  }

  // 2. Failed write whose re-queue overflows (new logs filled the queue meanwhile).
  {
    dnsCache.clear(); clearAllBlockLogMarks(); batches.length = 0;
    await settle();
    onBatch = () => { for (let i = 0; i < 100; i++) enqueueLog(pass("fill", i), settings, env, ctx); };
    await block("overflow.example");
    // The block log is queued from a background task (after GeoIP): wait until it is in the queue
    // (or already taken by a flush), then add PASS rows so the batch it travels in is flushed.
    for (let t = 0; t < 300 && pendingLogCount() === 0 && onBatch; t++) await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 39; i++) enqueueLog(pass("o", i), settings, env, ctx);
    await drain();
    assert.strictEqual(onBatch, null, "the failing batch ran");
    assert.strictEqual(isBlockLogged("p1", "overflow.example"), false, "mark released when the failed batch could not be re-queued");
    await settle();
    await block("overflow.example");
    await drain();
    await flushAllPending(env);
    assert.strictEqual(rows("overflow.example"), 1, "logged on the next block");
    console.log("  ok: re-queue overflow releases the mark");
  }

  // 3. REDIRECT CNAME: NODATA is cached (one upstream lookup, one log row, hits counted).
  {
    dnsCache.clear(); clearAllBlockLogMarks(); batches.length = 0;
    let calls = 0;
    const nodata: any = async (_r: any, tq: any) => { calls++; return { answer: buildResponse(tq.raw, tq.type, "", 300, 0), ttl: 300, action: "PASS", reason: "x", latency: 1 }; };
    await handleBlockOrRedirect(req(), mkQ("r.example", "AAAA"), mkCtx(), settings, "REDIRECT", "Rule: r", "target.example", "CNAME", nodata);
    const e = dnsCache.get("p1:r.example:AAAA");
    assert.ok(e, "NODATA redirect cached");
    assert.strictEqual(e.action, "REDIRECT");
    for (let i = 0; i < 3; i++) {
      const hit = await pipeline.process(req(), mkQ("r.example", "AAAA"), mkCtx());
      assert.strictEqual(hit.action, "REDIRECT");
      assert.ok(hit.timings?.dns_cache_mem !== undefined, "served from RAM");
      assert.strictEqual(hit.answer[3] & 0x0f, 0, "NOERROR");
      assert.strictEqual(((hit.answer[6] << 8) | hit.answer[7]), 1, "CNAME only");
    }
    await settle();
    assert.strictEqual(calls, 1, "target resolved once");
    assert.strictEqual(rows("r.example", "REDIRECT"), 1, "one REDIRECT log row");
    assert.strictEqual(hitCount("REDIRECT"), 3, "hits counted");
    console.log("  ok: CNAME NODATA redirect cached and deduped");
  }

  // 4. Upstream failures are not cached.
  {
    dnsCache.clear();
    const servfail: any = async (_r: any, tq: any) => ({ answer: buildResponse(tq.raw, tq.type, "", 60, 2), ttl: 60, action: "PASS", reason: "x", latency: 1 });
    const nxdomain: any = async (_r: any, tq: any) => ({ answer: buildResponse(tq.raw, tq.type, "", 60, 3), ttl: 60, action: "PASS", reason: "x", latency: 1 });
    const failAct: any = async (_r: any, tq: any) => ({ answer: buildResponse(tq.raw, tq.type, "", 60, 0), ttl: 0, action: "FAIL", reason: "x", latency: 1 });
    const empty: any = async () => ({ answer: new Uint8Array(), ttl: 0, action: "FAIL", reason: "x", latency: 1 });
    let i = 0;
    for (const r of [servfail, nxdomain, failAct, empty]) {
      const name = `bad${i++}.example`;
      await handleBlockOrRedirect(req(), mkQ(name, "A"), mkCtx(), settings, "REDIRECT", "Rule", "target.example", "CNAME", r);
      assert.strictEqual(dnsCache.has(`p1:${name}:A`), false, `${name} not cached`);
    }
    console.log("  ok: SERVFAIL / NXDOMAIN / FAIL / empty answers not cached");
  }

  // 5. Static CNAME for HTTPS/TXT is a complete answer; A/AAAA without resolver stays degraded.
  {
    dnsCache.clear();
    await handleBlockOrRedirect(req(), mkQ("h.example", "HTTPS"), mkCtx(), settings, "REDIRECT", "Rule", "target.example", "CNAME");
    await handleBlockOrRedirect(req(), mkQ("t.example", "TXT"), mkCtx(), settings, "REDIRECT", "Rule", "target.example", "CNAME");
    await handleBlockOrRedirect(req(), mkQ("a.example", "A"), mkCtx(), settings, "REDIRECT", "Rule", "target.example", "CNAME");
    assert.ok(dnsCache.has("p1:h.example:HTTPS"));
    assert.ok(dnsCache.has("p1:t.example:TXT"));
    assert.strictEqual(dnsCache.has("p1:a.example:A"), false);
    console.log("  ok: static CNAME for non-A/AAAA cached");
  }

  console.log(">>> [PASS] block mark release + redirect NODATA cache");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
