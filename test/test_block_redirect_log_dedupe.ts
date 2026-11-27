/**
 * @file test_block_redirect_log_dedupe.ts
 * @description
 *   - BLOCK: first blocked query of a profile+domain is logged and marked in RAM; repeats write no
 *     log row but are still counted in the rollups (hit_action BLOCK).
 *   - Marks are dropped with dnsCache (config change) and when logs are deleted.
 *   - REDIRECT: complete answers go into dnsCache (hits counted, not logged); degraded CNAME
 *     fallbacks are never cached; CNAME TTL follows the target records; ECS scope is honoured.
 */
import assert from "node:assert";
import {
  dnsCache,
  blockLogMarks,
  isBlockLogged,
  markBlockLogged,
  clearDnsCacheFor,
  clearAllBlockLogMarks,
  bumpProfileGeneration,
  getProfileGeneration
} from "../src/pipeline/cache";
import { pipeline } from "../src/pipeline";
import { handleBlockOrRedirect } from "../src/pipeline/resolver/block";
import { flushAllPending } from "../src/pipeline/logBatcher";
import { LogCoreModel } from "../src/models/log/core";
import { buildDNSQuery, buildResponse } from "../src/utils/dns";

(globalThis as any).caches = { default: undefined };

interface Row { sql: string; args: any[] }

function makeEnv(deleteChanges = 1) {
  const batches: Row[][] = [];
  const db: any = {
    prepare(sql: string) {
      return {
        bind: (...args: any[]) => ({
          sql, args,
          first: async () => null,
          run: async () => ({ success: true, meta: { changes: deleteChanges } }),
          all: async () => ({ results: [] })
        })
      };
    },
    async batch(stmts: Row[]) {
      batches.push(stmts);
      return stmts.map(() => ({ meta: { changes: 1 } }));
    }
  };
  return { env: { DB: db } as any, batches };
}

function makeCtx() {
  const pending: Promise<any>[] = [];
  return { ctx: { waitUntil: (p: Promise<any>) => { pending.push(p); } } as any, pending };
}

function mkContext(env: any, ctx: any, over: Record<string, any> = {}): any {
  return { profileId: "p1", accessPointId: "ap1", startTime: Date.now(), env, ctx, ...over };
}

function mkQuery(name: string, type = "A"): any {
  return { name, type, raw: buildDNSQuery(name, type) };
}

const req = (ip?: string) =>
  new Request("https://dns.example/dns-query", ip ? { headers: { "CF-Connecting-IP": ip } } : {});

const settings: any = { log_retention_days: 7, block_mode: "NULL_IP" };

async function settle(pending: Promise<any>[], env: any) {
  await Promise.all(pending.splice(0));
  await flushAllPending(env);
}

const logRows = (batches: Row[][], domain?: string) =>
  batches.flat().filter((r) => r.sql.includes("INSERT INTO logs") && (!domain || r.args.includes(domain)));

const hitCount = (batches: Row[][], action: string): number =>
  batches
    .flat()
    .filter((r) => r.sql.includes("hourly_rollups") && r.args[1] === "hit_action" && r.args[3] === action)
    .reduce((n, r) => n + r.args[6], 0);

async function block(env: any, ctx: any, name: string, type = "A", over: Record<string, any> = {}, s = settings) {
  return handleBlockOrRedirect(req("10.0.0.2"), mkQuery(name, type), mkContext(env, ctx, over), s, "BLOCK", "Blacklist: test");
}

async function main() {
  console.log(">>> [TEST] block/redirect log dedupe + redirect cache");

  // 1. BLOCK dedupe: one log row per profile+domain, repeats counted not logged.
  {
    dnsCache.clear(); clearAllBlockLogMarks();
    const { env, batches } = makeEnv();
    const { ctx, pending } = makeCtx();
    const r1 = await block(env, ctx, "ads.example", "A");
    const r2 = await block(env, ctx, "ads.example", "AAAA");                       // other type
    const r3 = await block(env, ctx, "ads.example", "A", { accessPointId: "ap2" }); // other access point
    await block(env, ctx, "Ads.Example", "A");                                      // case-insensitive
    // the DNS answer itself never changes
    assert.ok(r1.answer.length > 0 && r2.answer.length > 0 && r3.answer.length > 0);
    assert.strictEqual(r1.action, "BLOCK");
    await settle(pending, env);
    assert.strictEqual(logRows(batches, "ads.example").length, 1, "only the first block is logged");
    assert.strictEqual(hitCount(batches, "BLOCK"), 3, "the 3 repeats are counted in rollups");
    // per-device stats: repeat from ap2 counted under ap2
    const ap2 = batches.flat().filter((r) => r.args[1] === "hit_action" && r.args[5] === "ap2");
    assert.strictEqual(ap2.length, 1);
    // other domain / other profile are independent
    await block(env, ctx, "tracker.example", "A");
    await block(env, ctx, "ads.example", "A", { profileId: "p2" });
    await settle(pending, env);
    assert.strictEqual(logRows(batches, "tracker.example").length, 1);
    assert.strictEqual(logRows(batches, "ads.example").length, 2, "profile p2 logs its own first block");
    // block answers are never put in dnsCache
    assert.strictEqual(dnsCache.size, 0);
    console.log("  ok: block logged once per profile+domain, repeats counted");
  }

  // 2. Marks are dropped with dnsCache, only for the profile concerned.
  {
    dnsCache.clear(); clearAllBlockLogMarks();
    markBlockLogged("p1", "a.example"); markBlockLogged("p2", "a.example");
    clearDnsCacheFor(["p1"]);
    assert.strictEqual(isBlockLogged("p1", "a.example"), false);
    assert.strictEqual(isBlockLogged("p2", "a.example"), true);
    const { env, batches } = makeEnv();
    const { ctx, pending } = makeCtx();
    await block(env, ctx, "a.example");
    await settle(pending, env);
    assert.strictEqual(logRows(batches, "a.example").length, 1, "re-logged after config change");
    console.log("  ok: clearDnsCacheFor drops marks of that profile only");
  }

  // 3. Log deletion: full delete clears cache + marks, partial delete clears marks, 0 rows keeps them.
  {
    dnsCache.clear(); clearAllBlockLogMarks();
    dnsCache.set("p1:x.example:A", { answer: new Uint8Array([1]), expiresAt: Date.now() + 60000 });
    dnsCache.set("p2:x.example:A", { answer: new Uint8Array([1]), expiresAt: Date.now() + 60000 });
    markBlockLogged("p1", "x.example"); markBlockLogged("p2", "x.example");
    const gen = getProfileGeneration("p1");
    const { env } = makeEnv(1);
    await new LogCoreModel(env.DB, env).deleteByProfile("p1");
    assert.strictEqual(dnsCache.has("p1:x.example:A"), false, "dnsCache of p1 cleared");
    assert.strictEqual(isBlockLogged("p1", "x.example"), false, "marks of p1 cleared");
    assert.strictEqual(dnsCache.has("p2:x.example:A"), true, "p2 untouched");
    assert.strictEqual(isBlockLogged("p2", "x.example"), true);
    assert.ok(getProfileGeneration("p1") > gen, "in-flight resolutions invalidated");

    const future = Math.floor(Date.now() / 1000) + 100;
    markBlockLogged("p1", "y.example");
    // Cutoff older than the mark: the row the mark stands for is still there, so the mark stays.
    await new LogCoreModel(makeEnv(1).env.DB).deleteLogsChunked("p1", 12345);
    assert.strictEqual(isBlockLogged("p1", "y.example"), true, "rows deleted older than the mark keep it");
    await new LogCoreModel(makeEnv(1).env.DB).deleteLogsChunked("p1", future);
    assert.strictEqual(isBlockLogged("p1", "y.example"), false, "retention-style delete clears marks of deleted rows");
    dnsCache.set("p1:z.example:A", { answer: new Uint8Array([1]), expiresAt: Date.now() + 60000 });
    markBlockLogged("p1", "y.example");
    await new LogCoreModel(makeEnv(1).env.DB).cleanup("p1", future);
    assert.strictEqual(isBlockLogged("p1", "y.example"), false, "cleanup() clears marks");
    assert.strictEqual(dnsCache.has("p1:z.example:A"), true, "partial delete keeps DNS cache");

    markBlockLogged("p1", "y.example");
    await new LogCoreModel(makeEnv(0).env.DB).deleteLogsChunked("p1", 12345);
    assert.strictEqual(isBlockLogged("p1", "y.example"), true, "nothing deleted -> marks kept");
    console.log("  ok: log deletion clears cache/marks");
  }

  // 4. No marks when the log would be discarded, or when the config changed mid-resolution.
  {
    dnsCache.clear(); clearAllBlockLogMarks();
    const { env, batches } = makeEnv();
    const { ctx, pending } = makeCtx();
    await block(env, ctx, "off.example", "A", {}, { ...settings, log_retention_days: 0 });
    await block(env, ctx, "nolog.example", "A", { noLog: true });
    assert.strictEqual(isBlockLogged("p1", "off.example"), false);
    assert.strictEqual(isBlockLogged("p1", "nolog.example"), false);
    const stale = getProfileGeneration("p1");
    bumpProfileGeneration("p1");
    await block(env, ctx, "stale.example", "A", { profileGeneration: stale });
    assert.strictEqual(isBlockLogged("p1", "stale.example"), false, "stale generation never marks");
    await settle(pending, env);
    assert.strictEqual(logRows(batches, "off.example").length, 0);
    assert.strictEqual(logRows(batches, "stale.example").length, 1, "still logged, just not marked");
    console.log("  ok: no marks for discarded logs / stale generation");
  }

  // 5. Mark map is capped (LRU).
  {
    clearAllBlockLogMarks();
    const max = blockLogMarks.getMaxEntries();
    blockLogMarks.setMaxEntries(3);
    for (let i = 0; i < 10; i++) markBlockLogged("p1", `d${i}.example`);
    assert.strictEqual(blockLogMarks.size, 3);
    blockLogMarks.setMaxEntries(max);
    clearAllBlockLogMarks();
    console.log("  ok: marks are size capped");
  }

  // 6. REDIRECT static answer: cached, hit counted not logged.
  {
    dnsCache.clear(); clearAllBlockLogMarks();
    const { env, batches } = makeEnv();
    const { ctx, pending } = makeCtx();
    const q = mkQuery("redir.example", "A");
    const r1 = await handleBlockOrRedirect(req("10.0.0.2"), q, mkContext(env, ctx), settings, "REDIRECT", "Rule: redir", "1.2.3.4", "A");
    assert.strictEqual(r1.action, "REDIRECT");
    const entry = dnsCache.get("p1:redir.example:A");
    assert.ok(entry, "redirect stored in dnsCache");
    assert.strictEqual(entry.action, "REDIRECT");
    assert.ok(entry.ttl >= 30 * 24 * 3600, "static redirect: cached until cleared, rule changes clear it");
    assert.strictEqual(entry.countHits, true);
    assert.strictEqual(dnsCache.has("p1:redir.example:AAAA"), false, "key includes record type");

    const hit = await pipeline.process(req("10.0.0.3"), mkQuery("redir.example", "A"), mkContext(env, ctx));
    assert.strictEqual(hit.action, "REDIRECT");
    assert.strictEqual(hit.reason, "Rule: redir");
    assert.ok(hit.ttl <= 3600, "reply TTL stays capped");
    assert.ok(hit.timings?.dns_cache_mem !== undefined, "served from RAM");
    await pipeline.process(req("10.0.0.3"), mkQuery("redir.example", "A"), mkContext(env, ctx));
    await settle(pending, env);
    assert.strictEqual(logRows(batches, "redir.example").length, 1, "only the miss is logged");
    assert.strictEqual(hitCount(batches, "REDIRECT"), 2, "hits counted");

    // config change clears it
    clearDnsCacheFor(["p1"]);
    assert.strictEqual(dnsCache.has("p1:redir.example:A"), false);
    // retention 0 -> cached but hits not counted
    await handleBlockOrRedirect(req(), mkQuery("quiet.example", "A"), mkContext(env, ctx), { ...settings, log_retention_days: 0 }, "REDIRECT", "Rule", "1.2.3.4", "A");
    assert.strictEqual(dnsCache.get("p1:quiet.example:A").countHits, false);
    console.log("  ok: static redirect cached, hits counted");
  }

  // 7. REDIRECT CNAME: TTL from target records, degraded answers uncached, ECS scope.
  {
    dnsCache.clear(); clearAllBlockLogMarks();
    const { env } = makeEnv();
    const { ctx } = makeCtx();
    const okResolver: any = async (_r: any, tq: any) => ({
      answer: buildResponse(tq.raw, tq.type, "9.9.9.9", 30), ttl: 30, action: "PASS", reason: "x", latency: 1
    });
    const emptyResolver: any = async () => ({ answer: new Uint8Array(), ttl: 0, action: "FAIL", reason: "x", latency: 1 });
    const throwResolver: any = async () => { throw new Error("boom"); };

    await handleBlockOrRedirect(req("1.1.1.1"), mkQuery("c1.example", "A"), mkContext(env, ctx), settings, "REDIRECT", "Rule", "target.example", "CNAME", okResolver);
    const e1 = dnsCache.get("p1:c1.example:A");
    assert.ok(e1, "CNAME + resolved address cached");
    assert.strictEqual(e1.ttl, 30, "TTL = smallest TTL of the target records (30)");

    // Target TTL longer than the rule's fixed 60s CNAME: the cache follows the target, not the 60s
    const longResolver: any = async (_r: any, tq: any) => ({
      answer: buildResponse(tq.raw, tq.type, "9.9.9.9", 300), ttl: 300, action: "PASS", reason: "x", latency: 1
    });
    await handleBlockOrRedirect(req("1.1.1.1"), mkQuery("c7.example", "A"), mkContext(env, ctx), settings, "REDIRECT", "Rule", "target.example", "CNAME", longResolver);
    const e7 = dnsCache.get("p1:c7.example:A");
    assert.ok(e7, "cached");
    assert.strictEqual(e7.ttl, 300, "redirect cache is not capped by the rule's 60s CNAME");

    await handleBlockOrRedirect(req("1.1.1.1"), mkQuery("c2.example", "A"), mkContext(env, ctx), settings, "REDIRECT", "Rule", "target.example", "CNAME", emptyResolver);
    await handleBlockOrRedirect(req("1.1.1.1"), mkQuery("c3.example", "A"), mkContext(env, ctx), settings, "REDIRECT", "Rule", "target.example", "CNAME", throwResolver);
    await handleBlockOrRedirect(req("1.1.1.1"), mkQuery("c4.example", "A"), mkContext(env, ctx), settings, "REDIRECT", "Rule", "target.example", "CNAME");
    for (const d of ["c2", "c3", "c4"]) assert.strictEqual(dnsCache.has(`p1:${d}.example:A`), false, `${d}: degraded answer not cached`);

    // A CNAME query for a CNAME rule is a complete static answer
    await handleBlockOrRedirect(req(), mkQuery("c5.example", "CNAME"), mkContext(env, ctx), settings, "REDIRECT", "Rule", "target.example", "CNAME");
    assert.ok(dnsCache.has("p1:c5.example:CNAME"));

    // ECS use_client_ip: stored under the client's subnet scope, never unscoped
    const ecsSettings: any = { ...settings, ecs: { enabled: true, use_client_ip: true } };
    await handleBlockOrRedirect(req("8.8.8.8"), mkQuery("c6.example", "A"), mkContext(env, ctx), ecsSettings, "REDIRECT", "Rule", "target.example", "CNAME", okResolver);
    assert.strictEqual(dnsCache.has("p1:c6.example:A"), false);
    assert.ok([...dnsCache.keys()].some((k) => k.startsWith("p1:c6.example:A|") && !k.endsWith("|none")), "scoped by subnet");
    const hit = await pipeline.process(req("8.8.8.8"), mkQuery("c6.example", "A"), mkContext(env, ctx));
    assert.strictEqual(hit.action, "REDIRECT", "same subnet hits");
    console.log("  ok: CNAME redirect TTL / degraded / ECS scope");
  }

  // 8. Stale generation never writes the redirect cache.
  {
    dnsCache.clear();
    const { env } = makeEnv();
    const { ctx } = makeCtx();
    const stale = getProfileGeneration("p1");
    bumpProfileGeneration("p1");
    await handleBlockOrRedirect(req(), mkQuery("g.example", "A"), mkContext(env, ctx, { profileGeneration: stale }), settings, "REDIRECT", "Rule", "1.2.3.4", "A");
    assert.strictEqual(dnsCache.has("p1:g.example:A"), false);
    console.log("  ok: stale generation does not write redirect cache");
  }

  console.log(">>> [PASS] block/redirect log dedupe");
}

main().catch((e) => { console.error(e); process.exit(1); });
