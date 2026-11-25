/**
 * @file test_log_queue_cap.ts
 * @description logBatchQueue must stay bounded when the database is slow or down: new logs are
 * dropped beyond the cap, and a failed flush cannot push the queue past it either.
 */
import assert from "node:assert";
import {
  enqueueLog,
  flushLogBatch,
  pendingLogCount,
  droppedLogCount
} from "../src/pipeline/logBatcher";

const CAP = 10_000;

// flushLogBatch reads the Workers Cache API; none exists under Node.
(globalThis as any).caches = { default: undefined };

const settleTicks = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

const makeLog = (i: number): any => ({
  profile_id: "p1",
  timestamp: 1000 + i,
  client_ip: "10.0.0.2",
  geo_country: "LAN",
  domain: `d${i}.example`,
  record_type: "A",
  action: "PASS"
});

function makeEnv(batch: (stmts: any[]) => Promise<any>) {
  const db: any = {
    prepare(sql: string) {
      return {
        bind: (...args: any[]) => ({
          sql,
          args,
          first: async () => null
        })
      };
    },
    batch
  };
  return { DB: db } as any;
}

const ctx: any = { waitUntil: (_p: Promise<unknown>) => {} };

async function drain(env: any) {
  for (let i = 0; i < 1000 && pendingLogCount() > 0; i++) {
    await flushLogBatch(env, ctx);
    await settleTicks(2);
  }
}

async function main() {
  console.log(">>> [TEST] log queue cap");

  // 1. Healthy database: everything drains, nothing is dropped.
  {
    const written: number[] = [];
    const env = makeEnv(async (stmts) => { written.push(stmts.length); return []; });
    const before = droppedLogCount();
    for (let i = 0; i < 500; i++) enqueueLog(makeLog(i), undefined, env, ctx);
    await settleTicks();
    await drain(env);
    assert.strictEqual(pendingLogCount(), 0);
    assert.strictEqual(droppedLogCount(), before);
    console.log("  ok: healthy DB drains, no drops");
  }

  // 2. Database down: the queue stops at the cap and extra logs are counted as dropped.
  {
    const env = makeEnv(async () => { throw new Error("db down"); });
    const before = droppedLogCount();
    const warn = console.warn;
    let warnings = 0;
    console.warn = () => { warnings++; };
    try {
      for (let i = 0; i < CAP + 500; i++) enqueueLog(makeLog(i), undefined, env, ctx);
      assert.ok(pendingLogCount() <= CAP, "queue over cap: " + pendingLogCount());
      assert.strictEqual(droppedLogCount() - before, 500);
      await settleTicks(); // failed flushes re-queue their rows
      assert.ok(pendingLogCount() <= CAP, "queue over cap after failed flush: " + pendingLogCount());
      assert.ok(pendingLogCount() >= CAP - 40, "failed flush must keep its rows: " + pendingLogCount());
      // Drop warnings are rate limited: 500 drops, one line at most.
      assert.ok(warnings <= 3, "too many warnings: " + warnings);
    } finally {
      console.warn = warn;
    }
    console.log("  ok: DB down -> queue capped at " + CAP + ", dropped " + (droppedLogCount() - before));
  }

  // 3. New logs arriving while a flush is writing and then failing must not overflow the
  // re-queue: rows that no longer fit are dropped and counted.
  {
    const startPending = pendingLogCount();
    let injected = false;
    const env = makeEnv(async () => {
      if (!injected) {
        injected = true;
        for (let i = 0; i < 100; i++) enqueueLog(makeLog(i), undefined, env, ctx);
      }
      throw new Error("db down");
    });
    const warn = console.warn;
    console.warn = () => {};
    const before = droppedLogCount();
    try {
      await flushLogBatch(env, ctx);
      await settleTicks();
    } finally {
      console.warn = warn;
    }
    assert.ok(pendingLogCount() <= CAP, "queue over cap after re-queue: " + pendingLogCount());
    assert.ok(droppedLogCount() > before, "overflowing rows must be counted");
    assert.ok(startPending <= CAP);
    console.log("  ok: re-queue respects the cap");
  }

  // 4. Recovery: once the database works again the queue drains completely.
  {
    const env = makeEnv(async () => []);
    await drain(env);
    assert.strictEqual(pendingLogCount(), 0);
    console.log("  ok: queue drains after recovery");
  }

  // 5. The cap is configurable (LOG_QUEUE_MAX_ROWS); values below the minimum are ignored (default used).
  {
    const env = makeEnv(async () => { throw new Error("db down"); });
    env.LOG_QUEUE_MAX_ROWS = 150;
    const warn = console.warn;
    console.warn = () => {};
    const before = droppedLogCount();
    try {
      for (let i = 0; i < 400; i++) enqueueLog(makeLog(i), undefined, env, ctx);
      await settleTicks();
      assert.ok(pendingLogCount() <= 150, "custom cap ignored: " + pendingLogCount());
      assert.ok(droppedLogCount() - before >= 250);
      env.LOG_QUEUE_MAX_ROWS = 5; // below the minimum 100 -> invalid, default cap (10000) applies
      await drain(makeEnv(async () => []));
      for (let i = 0; i < 300; i++) enqueueLog(makeLog(i), undefined, env, ctx);
      await settleTicks();
      assert.ok(pendingLogCount() >= 250, "too-small value must not shrink the cap to " + pendingLogCount());
    } finally {
      console.warn = warn;
    }
    await drain(makeEnv(async () => []));
    assert.strictEqual(pendingLogCount(), 0);
    console.log("  ok: LOG_QUEUE_MAX_ROWS honoured, too-small value ignored");
  }

  console.log(">>> [PASS] log queue cap");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
