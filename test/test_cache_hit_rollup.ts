/**
 * @file test_cache_hit_rollup.ts
 * @description Cache hits (served from RAM, never logged) must be counted into hourly_rollups
 * with `count = count + n`, on the same keys as logged queries, honouring the log policy.
 */
import assert from "node:assert";
import {
  recordCacheHit,
  flushAllPending,
  discardPendingLogs,
  isLogPolicyEnabled
} from "../src/pipeline/logBatcher";

interface Row { sql: string; args: any[] }

// flushLogBatch reads the Workers Cache API; none exists under Node.
(globalThis as any).caches = { default: undefined };

function makeEnv(opts: { failFirstBatch?: boolean; onFirstBatch?: () => void } = {}) {
  const batches: Row[][] = [];
  let failures = opts.failFirstBatch ? 1 : 0;
  const db: any = {
    prepare(sql: string) {
      return {
        bind: (...args: any[]) => ({
          sql,
          args,
          // E2EE key lookup: profile "enc" has a key, everyone else does not
          first: async () =>
            sql.includes("user_log_keys") && args[0] === "enc"
              ? { public_key: JSON.stringify({ kty: "EC" }) }
              : null
        })
      };
    },
    async batch(stmts: Row[]) {
      if (failures > 0 && opts.onFirstBatch) { opts.onFirstBatch(); opts.onFirstBatch = undefined; }
      if (failures > 0) { failures--; throw new Error("transient failure"); }
      batches.push(stmts);
      return stmts.map(() => ({ meta: { changes: 1 } }));
    }
  };
  return { env: { DB: db } as any, batches };
}

const ev = (over: Record<string, any> = {}) => ({
  profileId: "p1",
  accessPointId: "iphone",
  timestamp: 7200 + 5,
  action: "PASS",
  domain: "example.com",
  clientIp: "10.0.0.2",
  geoCountry: "LAN",
  destCountryCode: "us",
  destCountry: "United States",
  ...over
});

function flatten(batches: Row[][]) {
  return batches.flat().map((r) => r.args);
}

async function main() {
  console.log(">>> [TEST] cache hit rollup counters");

  // 1. Many hits collapse into a handful of rows; counts add up.
  {
    const { env, batches } = makeEnv();
    for (let i = 0; i < 1000; i++) recordCacheHit(ev(), env);
    await flushAllPending(env);
    const rows = flatten(batches);
    // action, domain, client, dest (hourly) + the same four as minute-bucketed hit_* rows
    // -> 8 rows regardless of 1000 hits
    assert.strictEqual(rows.length, 8);
    for (const r of rows) assert.strictEqual(r[6], 1000);
    assert.ok(batches.flat().every((s) => s.sql.includes("count = count + excluded.count")));
    const byMetric = new Map(rows.map((r) => [r[1], r]));
    assert.deepStrictEqual(byMetric.get("action")!.slice(0, 6), ["p1", "action", 7200, "PASS", "", "iphone"]);
    assert.deepStrictEqual(byMetric.get("domain")!.slice(0, 6), ["p1", "domain", 7200, "example.com", "PASS", "iphone"]);
    assert.deepStrictEqual(byMetric.get("client")!.slice(0, 6), ["p1", "client", 7200, "10.0.0.2", "LAN", "iphone"]);
    assert.deepStrictEqual(byMetric.get("dest")!.slice(0, 6), ["p1", "dest", 7200, "US", "United States", "iphone"]);
    assert.deepStrictEqual(byMetric.get("hit_action")!.slice(0, 6), ["p1", "hit_action", 7200, "PASS", "", "iphone"]);
    console.log("  ok: 1000 hits -> 8 upsert rows");
  }

  // 2. Per-device keys stay separate (iPad vs iPhone), as do hours.
  {
    const { env, batches } = makeEnv();
    recordCacheHit(ev({ accessPointId: "iphone" }), env);
    recordCacheHit(ev({ accessPointId: "ipad" }), env);
    recordCacheHit(ev({ accessPointId: "ipad", timestamp: 7200 + 3600 }), env);
    await flushAllPending(env);
    const domainRows = flatten(batches).filter((r) => r[1] === "domain");
    assert.strictEqual(domainRows.length, 3);
    assert.deepStrictEqual(domainRows.map((r) => r[5]).sort(), ["ipad", "ipad", "iphone"]);
    console.log("  ok: per access point / hour keys");
  }

  // 3. Failed flush merges the deltas back; nothing lost, nothing doubled.
  {
    const { env, batches } = makeEnv({ failFirstBatch: true });
    for (let i = 0; i < 3; i++) recordCacheHit(ev(), env);
    await flushAllPending(env);
    assert.strictEqual(batches.length, 0);
    recordCacheHit(ev(), env);
    await flushAllPending(env);
    const action = flatten(batches).find((r) => r[1] === "action")!;
    assert.strictEqual(action[6], 4);
    console.log("  ok: failed flush retried without loss");
  }

  // 4. Deleting a profile's logs discards its pending hit counters.
  {
    const { env, batches } = makeEnv();
    recordCacheHit(ev({ profileId: "gone" }), env);
    recordCacheHit(ev({ profileId: "kept" }), env);
    discardPendingLogs("gone");
    await flushAllPending(env);
    const profiles = new Set(flatten(batches).map((r) => r[0]));
    assert.deepStrictEqual([...profiles], ["kept"]);
    console.log("  ok: discard drops pending hits");
  }

  // 4a. Phantom rollups: "delete logs" while a flush is writing must not be undone by the
  // merge-back of a failed write.
  {
    const { env, batches } = makeEnv({
      failFirstBatch: true,
      onFirstBatch: () => { discardPendingLogs("gone"); }
    });
    recordCacheHit(ev({ profileId: "gone" }), env);
    recordCacheHit(ev({ profileId: "kept" }), env);
    await flushAllPending(env); // fails after discard -> merges back what is left
    await flushAllPending(env); // retry
    const profiles = new Set(flatten(batches).map((r) => r[0]));
    assert.deepStrictEqual([...profiles], ["kept"]);
    console.log("  ok: in-flight discard survives failed flush");
  }

  // 4a'. Hits and log rows share one db.batch() transaction (single SQLite writer).
  {
    const { env, batches } = makeEnv();
    recordCacheHit(ev({ profileId: "p1" }), env);
    const { enqueueLog } = await import("../src/pipeline/logBatcher");
    enqueueLog({
      profile_id: "p1", timestamp: 7205, client_ip: "10.0.0.2", geo_country: "LAN",
      domain: "miss.example", record_type: "A", action: "PASS"
    } as any, { log_retention_days: 7 } as any, env, { waitUntil() {} } as any);
    await flushAllPending(env);
    assert.strictEqual(batches.length, 1);
    const sqls = batches[0].map((r) => r.sql);
    assert.ok(sqls.some((q) => q.includes("INSERT INTO logs")), "log insert in batch");
    assert.ok(sqls.filter((q) => q.includes("hourly_rollups")).length >= 4, "rollups in batch");
    console.log("  ok: single batch for hits + logs");
  }

  // 4b. E2EE profiles only get action totals from cache hits.
  {
    const { env, batches } = makeEnv();
    recordCacheHit(ev({ profileId: "enc" }), env);
    recordCacheHit(ev({ profileId: "plain" }), env);
    await flushAllPending(env);
    const rows = flatten(batches);
    assert.deepStrictEqual(rows.filter((r) => r[0] === "enc").map((r) => r[1]).sort(), ["action", "hit_action"]);
    assert.strictEqual(rows.filter((r) => r[0] === "plain").length, 8);
    console.log("  ok: E2EE profile -> action only (hits)");
  }

  // 4c. Same rule for the log flush path (createRollupUpsertStatements).
  {
    const { env } = makeEnv();
    const { LogAggregationModel } = await import("../src/models/log/aggregation");
    const agg = new LogAggregationModel(env.DB);
    const log = (pid: string) => ({
      profile_id: pid, timestamp: 7205, client_ip: "10.0.0.2", geo_country: "LAN",
      domain: "example.com", record_type: "A", action: "PASS", dest_country_code: "US", dest_country: "United States"
    });
    const stmts = agg.createRollupUpsertStatements([log("enc"), log("plain")] as any, new Set(["enc"])) as any[];
    assert.deepStrictEqual(stmts.filter((r) => r.args[0] === "enc").map((r) => r.args[1]), ["action"]);
    assert.strictEqual(stmts.filter((r) => r.args[0] === "plain").length, 4);
    console.log("  ok: E2EE profile -> action only (logs)");
  }

  // 4d. Backlog is written in chunks of at most 200 rows per db.batch(), nothing lost.
  {
    const { env, batches } = makeEnv();
    for (let i = 0; i < 300; i++) recordCacheHit(ev({ domain: `d${i}.example`, destCountryCode: null }), env);
    await flushAllPending(env);
    assert.ok(batches.length >= 2 && batches.every((b) => b.length <= 200 + 0));
    const total = flatten(batches).filter((r) => r[1] === "domain").length;
    assert.strictEqual(total, 300);
    console.log("  ok: backlog chunked (" + batches.map((b) => b.length).join("+") + " rows)");
  }

  // 4e. Chunk size is configurable via CACHE_HIT_FLUSH_CHUNK_SIZE.
  {
    const { env, batches } = makeEnv();
    env.CACHE_HIT_FLUSH_CHUNK_SIZE = 50;
    for (let i = 0; i < 120; i++) recordCacheHit(ev({ domain: `c${i}.example`, destCountryCode: null }), env);
    await flushAllPending(env);
    assert.ok(batches.every((b) => b.length <= 50), "chunk <= 50");
    assert.strictEqual(flatten(batches).filter((r) => r[1] === "domain").length, 120);
    console.log("  ok: chunk size from env (" + batches.map((b) => b.length).join("+") + ")");
  }

  // 4f. A permanently failing DB cannot make the counter map grow without bound.
  {
    const { env } = makeEnv();
    env.DB.batch = async () => { throw new Error("db down"); };
    for (let i = 0; i < 40000; i++) recordCacheHit(ev({ domain: `x${i}.example`, destCountryCode: null }), env);
    const { pendingHitCounterRows } = await import("../src/pipeline/logBatcher");
    assert.ok(pendingHitCounterRows() <= 20000 + 4, "rows over hard cap: " + pendingHitCounterRows());
    await flushAllPending(env); // fails, merges back
    assert.ok(pendingHitCounterRows() <= 20000 + 4);
    console.log("  ok: hard cap holds under DB outage");
  }

  // 5. Log policy used to decide whether hits are counted.
  assert.strictEqual(isLogPolicyEnabled({ log_retention_days: 0 } as any, "PASS"), false);
  assert.strictEqual(isLogPolicyEnabled({ log_retention_days: 7, skip_log_on_pass: true } as any, "PASS"), false);
  assert.strictEqual(isLogPolicyEnabled({ log_retention_days: 7, skip_log_on_pass: true } as any, "BLOCK"), true);
  assert.strictEqual(isLogPolicyEnabled({ log_retention_days: 7 } as any, "PASS"), true);
  console.log("  ok: log policy");

  console.log(">>> [PASS] cache hit rollup counters");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
