/**
 * @file test_refresh_cooldown.ts
 * @description REFRESH_COOLDOWN_SEC: minimum pause between two manual Refresh clicks (Query Logs / Analytics).
 * Per user + profile + tab, 0 disables it, invalid values fall back to the default, a burst of parallel
 * requests cannot get more than one refresh through, and the 429 answer carries Retry-After.
 */
import assert from "node:assert";
import {
  DEFAULT_REFRESH_COOLDOWN_SEC,
  checkRefreshCooldown,
  getRefreshCooldownSec,
  refreshCooldownResponse,
  resetRefreshCooldowns
} from "../src/utils/refreshCooldown";

async function main(): Promise<void> {
  const env = (v?: string | number) => ({ REFRESH_COOLDOWN_SEC: v }) as any;
  const T0 = 1_000_000;

  // Configuration: default 10, explicit values, 0 = off, junk falls back to the default, huge values are capped.
  assert.strictEqual(getRefreshCooldownSec(env()), DEFAULT_REFRESH_COOLDOWN_SEC);
  assert.strictEqual(getRefreshCooldownSec(env("")), DEFAULT_REFRESH_COOLDOWN_SEC);
  assert.strictEqual(getRefreshCooldownSec(env("30")), 30);
  assert.strictEqual(getRefreshCooldownSec(env(0)), 0);
  assert.strictEqual(getRefreshCooldownSec(env("abc")), DEFAULT_REFRESH_COOLDOWN_SEC);
  assert.strictEqual(getRefreshCooldownSec(env(-5)), DEFAULT_REFRESH_COOLDOWN_SEC);
  assert.strictEqual(getRefreshCooldownSec(env(999999)), 3600);

  // First refresh passes, the next ones are refused until the pause is over.
  resetRefreshCooldowns();
  assert.strictEqual(checkRefreshCooldown(env(10), "analytics", "u1", "p1", T0), 0);
  assert.strictEqual(checkRefreshCooldown(env(10), "analytics", "u1", "p1", T0 + 1), 10);
  assert.strictEqual(checkRefreshCooldown(env(10), "analytics", "u1", "p1", T0 + 4_500), 6);
  assert.strictEqual(checkRefreshCooldown(env(10), "analytics", "u1", "p1", T0 + 9_999), 1);
  assert.strictEqual(checkRefreshCooldown(env(10), "analytics", "u1", "p1", T0 + 10_000), 0);
  // A refused attempt does not extend the pause.
  assert.strictEqual(checkRefreshCooldown(env(10), "analytics", "u1", "p1", T0 + 15_000), 5);
  assert.strictEqual(checkRefreshCooldown(env(10), "analytics", "u1", "p1", T0 + 20_000), 0);

  // Independent per tab, user and profile.
  resetRefreshCooldowns();
  assert.strictEqual(checkRefreshCooldown(env(10), "logs", "u1", "p1", T0), 0);
  assert.strictEqual(checkRefreshCooldown(env(10), "analytics", "u1", "p1", T0), 0);
  assert.strictEqual(checkRefreshCooldown(env(10), "logs", "u2", "p1", T0), 0);
  assert.strictEqual(checkRefreshCooldown(env(10), "logs", "u1", "p2", T0), 0);
  assert.ok(checkRefreshCooldown(env(10), "logs", "u1", "p1", T0 + 1) > 0);

  // 0 = never limited.
  resetRefreshCooldowns();
  for (let i = 0; i < 50; i++) assert.strictEqual(checkRefreshCooldown(env(0), "logs", "u1", "p1", T0 + i), 0);

  // A burst of parallel requests lets exactly one through.
  resetRefreshCooldowns();
  const burst = await Promise.all(
    Array.from({ length: 100 }, async () => checkRefreshCooldown(env(10), "analytics", "u1", "p1", T0))
  );
  assert.strictEqual(burst.filter((w) => w === 0).length, 1);

  // Changing the value takes effect on the next check (no restart needed for tests / hot reload).
  resetRefreshCooldowns();
  assert.strictEqual(checkRefreshCooldown(env(2), "logs", "u1", "p1", T0), 0);
  assert.strictEqual(checkRefreshCooldown(env(2), "logs", "u1", "p1", T0 + 2_000), 0);

  // The map does not grow without bound: expired entries are dropped once it is large.
  resetRefreshCooldowns();
  for (let i = 0; i < 1500; i++) checkRefreshCooldown(env(1), "logs", `u${i}`, "p", T0);
  assert.strictEqual(checkRefreshCooldown(env(1), "logs", "late", "p", T0 + 5_000), 0);

  // 429 answer.
  const res = refreshCooldownResponse(7);
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.headers.get("Retry-After"), "7");
  assert.deepStrictEqual(await res.json(), { error: "refresh_cooldown", retry_after: 7 });

  console.log("test_refresh_cooldown: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
