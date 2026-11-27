/**
 * @file test_e2ee_fail_closed.ts
 * @description E2EE must fail closed: when a profile's logs cannot be encrypted (broken or unsupported
 * key, failed key lookup) they are dropped, never written in plaintext, and the cache-hit counters
 * of a profile with an unknown E2EE state are not written (as plaintext domain/client rollups) either.
 */
import assert from "node:assert";
import {
  enqueueLog,
  flushLogBatch,
  recordCacheHit,
  pendingLogCount,
  pendingHitCounterRows,
  droppedUnprotectedLogCount
} from "../src/pipeline/logBatcher";

// flushLogBatch reads the Workers Cache API; none exists under Node.
(globalThis as any).caches = { default: undefined };

interface Stmt { sql: string; args: any[] }

async function main() {
  console.log(">>> [TEST] E2EE fail closed");
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"])) as CryptoKeyPair;
  const goodPub = await crypto.subtle.exportKey("jwk", kp.publicKey);

  // key rows per profile; "throw" makes the lookup fail once, then the profile's next row applies
  const keys: Record<string, any> = {
    "bad-key": { kty: "EC", crv: "P-256", x: "AAAA", y: "BBBB" }, // import fails -> encryption throws
    "odd-key": { foo: "bar" },                                     // neither pqc_pk nor kty
    "good-key": goodPub
  };
  const lookupFailures: Record<string, number> = {};
  const written: Stmt[] = [];

  const db: any = {
    prepare(sql: string) {
      return {
        bind: (...args: any[]) => ({
          sql,
          args,
          first: async () => {
            if (!sql.includes("user_log_keys")) return null;
            const pid = args[0];
            if ((lookupFailures[pid] ?? 0) > 0) { lookupFailures[pid]--; throw new Error("read failed"); }
            return keys[pid] ? { public_key: JSON.stringify(keys[pid]) } : null;
          }
        })
      };
    },
    async batch(stmts: Stmt[]) { written.push(...stmts); return []; }
  };
  const env: any = { DB: db };
  const ctx: any = { waitUntil() {} };
  const log = (profile: string, domain: string): any => ({
    profile_id: profile, timestamp: 7200 + 5, client_ip: "10.0.0.9", geo_country: "VN",
    domain, record_type: "A", action: "PASS"
  });
  const hit = (profile: string) => ({
    profileId: profile, accessPointId: "ap", timestamp: 7200 + 5, action: "PASS",
    domain: "hit.example", clientIp: "10.0.0.9", geoCountry: "VN"
  });
  const inserts = () => written.filter((s) => s.sql.includes("INSERT INTO logs"));
  const rowsOf = (pid: string, metric?: string) =>
    written.filter((s) => s.args[0] === pid && (!metric || s.args[1] === metric) && s.sql.includes("hourly_rollups"));

  const origError = console.error, origWarn = console.warn;
  console.error = () => {}; console.warn = () => {};
  try {
    // 1. Broken key / unsupported key: the E2EE profile's log is dropped, the plain profile's is kept.
    {
      const before = droppedUnprotectedLogCount();
      enqueueLog(log("bad-key", "secret1.example"), undefined, env, ctx);
      enqueueLog(log("odd-key", "secret2.example"), undefined, env, ctx);
      enqueueLog(log("plain-ok", "open.example"), undefined, env, ctx);
      await flushLogBatch(env, ctx);
      assert.strictEqual(pendingLogCount(), 0, "dropped logs must not be re-queued");
      assert.strictEqual(droppedUnprotectedLogCount() - before, 2);
      const rows = inserts();
      assert.deepStrictEqual(rows.map((r) => r.args[0]), ["plain-ok"]);
      assert.ok(!JSON.stringify(written).includes("secret1.example"), "plaintext leaked (bad key)");
      assert.ok(!JSON.stringify(written).includes("secret2.example"), "plaintext leaked (odd key)");
      assert.ok(!JSON.stringify(written).includes("10.0.0.9") || rows[0].args[4] === "10.0.0.9");
      console.log("  ok: undecryptable E2EE logs dropped, plain profile still written");
    }

    // 2. Key lookup fails: the log is dropped (not stored in plaintext) and its hit counters wait.
    {
      written.length = 0;
      lookupFailures["flaky"] = 1;
      keys["flaky"] = goodPub;               // flaky profile is really an E2EE profile
      const before = droppedUnprotectedLogCount();
      enqueueLog(log("flaky", "secret3.example"), undefined, env, ctx);
      recordCacheHit(hit("flaky"), env, ctx);
      await flushLogBatch(env, ctx);
      assert.strictEqual(droppedUnprotectedLogCount() - before, 1);
      assert.strictEqual(inserts().length, 0, "no row for a profile with unknown E2EE state");
      assert.strictEqual(rowsOf("flaky").length, 0, "no rollup rows for unknown E2EE state");
      assert.ok(!JSON.stringify(written).includes("secret3.example"));
      assert.ok(pendingHitCounterRows() > 0, "hit counters must wait in RAM");

      // 3. Lookup works again: only the privacy-neutral action totals are written for the E2EE profile.
      await flushLogBatch(env, ctx);
      assert.strictEqual(pendingHitCounterRows(), 0);
      const metrics = new Set(rowsOf("flaky").map((r) => r.args[1]));
      assert.deepStrictEqual([...metrics].sort(), ["action", "hit_action"], "E2EE profile must only get action totals");
      assert.ok(!JSON.stringify(written).includes("hit.example"));
      console.log("  ok: failed key lookup -> nothing plaintext, counters kept, then action-only");
    }

    // 4. A profile without any E2EE key still logs and counts normally.
    {
      written.length = 0;
      enqueueLog(log("plain-ok", "open2.example"), undefined, env, ctx);
      recordCacheHit(hit("plain-ok"), env, ctx);
      await flushLogBatch(env, ctx);
      assert.strictEqual(inserts().length, 1);
      assert.ok(rowsOf("plain-ok", "domain").length >= 1);
      console.log("  ok: non-E2EE profile unaffected");
    }
  } finally {
    console.error = origError; console.warn = origWarn;
  }
  console.log(">>> [PASS] E2EE fail closed");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
