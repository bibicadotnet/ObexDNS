/**
 * @file test_e2ee_retry_keeps_payload.ts
 * @description A failed db.batch() re-queues the logs. For E2EE profiles the retry must encrypt the
 * original data again; it used to encrypt already blanked fields and overwrite the payload with
 * empty strings, so the stored log decrypted to nothing.
 */
import assert from "node:assert";
import { enqueueLog, flushLogBatch, pendingLogCount } from "../src/pipeline/logBatcher";
import { decryptSensitiveLogData } from "../src/lib/crypto/e2ee";

// flushLogBatch reads the Workers Cache API; none exists under Node.
(globalThis as any).caches = { default: undefined };

const COL = { domain: 6, clientIp: 4, geo: 5, encVersion: 18, payload: 20 };

async function main() {
  console.log(">>> [TEST] E2EE retry keeps payload");
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"])) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);

  const mk = (failures: number) => {
    const inserts: any[][] = [];
    let left = failures;
    const db: any = {
      prepare(sql: string) {
        return {
          bind: (...args: any[]) => ({
            sql,
            args,
            // profile "enc" has an E2EE key, profile "plain" has none
            first: async () =>
              sql.includes("user_log_keys") && args[0] === "enc" ? { public_key: JSON.stringify(pub) } : null
          })
        };
      },
      async batch(stmts: any[]) {
        if (left > 0) { left--; throw new Error("transient failure"); }
        for (const s of stmts) if (s.sql.includes("INSERT INTO logs")) inserts.push(s.args);
        return [];
      }
    };
    return { env: { DB: db } as any, inserts };
  };
  const ctx: any = { waitUntil() {} };
  const log = (profile: string, domain: string): any => ({
    profile_id: profile, timestamp: 1, client_ip: "10.0.0.9", geo_country: "VN",
    domain, record_type: "A", action: "PASS", answer: "1.2.3.4"
  });
  const warn = console.warn;
  console.warn = () => {};

  try {
    // 1. No failure: baseline.
    {
      const { env, inserts } = mk(0);
      enqueueLog(log("enc", "a.example"), undefined, env, ctx);
      await flushLogBatch(env, ctx);
      const plain = await decryptSensitiveLogData(priv, inserts[0][COL.payload]);
      assert.strictEqual(plain.domain, "a.example");
      assert.strictEqual(inserts[0][COL.domain], "");
      console.log("  ok: baseline decrypts");
    }

    // 2. Write fails once, then succeeds: payload still carries the real data.
    // 3. Fails twice: still intact (each attempt starts from the raw log).
    for (const failures of [1, 2]) {
      const { env, inserts } = mk(failures);
      enqueueLog(log("enc", "secret.example"), undefined, env, ctx);
      for (let i = 0; i < failures; i++) {
        await flushLogBatch(env, ctx);
        assert.strictEqual(pendingLogCount(), 1, "failed log must be re-queued");
      }
      await flushLogBatch(env, ctx);
      assert.strictEqual(pendingLogCount(), 0);
      assert.strictEqual(inserts.length, 1, "exactly one row, no duplicates");
      const row = inserts[0];
      const plain = await decryptSensitiveLogData(priv, row[COL.payload]);
      assert.strictEqual(plain.domain, "secret.example", "domain lost after " + failures + " failed write(s)");
      assert.strictEqual(plain.client_ip, "10.0.0.9");
      assert.strictEqual(plain.geo_country, "VN");
      assert.strictEqual(plain.answer, "1.2.3.4");
      assert.strictEqual(row[COL.domain], "", "plaintext domain column must stay empty");
      assert.strictEqual(row[COL.clientIp], "");
      assert.strictEqual(row[COL.encVersion], 1);
      console.log("  ok: payload intact after " + failures + " failed write(s)");
    }

    // 4. A plaintext (non-E2EE) profile retried after a failure is unchanged.
    {
      const { env, inserts } = mk(1);
      enqueueLog(log("plain", "open.example"), undefined, env, ctx);
      await flushLogBatch(env, ctx);
      await flushLogBatch(env, ctx);
      assert.strictEqual(inserts.length, 1);
      assert.strictEqual(inserts[0][COL.domain], "open.example");
      assert.strictEqual(inserts[0][COL.encVersion], 0);
      assert.strictEqual(inserts[0][COL.payload], null);
      console.log("  ok: plaintext profile retry unchanged");
    }
  } finally {
    console.warn = warn;
  }
  console.log(">>> [PASS] E2EE retry keeps payload");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
