/**
 * @file test_log_range_validation.ts
 * @description Custom range validation shared by the Query Logs and Analytics endpoints: reversed, malformed
 * and out-of-retention ranges are rejected before any query runs; an over-long start is moved up to the
 * retention boundary and a future end down to "now".
 */
import assert from "node:assert";
import {
  effectiveLogRetentionDays,
  roleRetentionCap,
  resolveCustomRange,
  retentionThreshold
} from "../src/utils/logRange";

const NOW = 1_800_000_000;
const DAY = 86400;
const RET = 7;
const threshold = retentionThreshold(RET, NOW);

// Plain valid range inside the retention window: untouched.
assert.deepStrictEqual(resolveCustomRange(String(NOW - 3600), String(NOW - 60), RET, NOW), {
  ok: true, since: NOW - 3600, until: NOW - 60, clampedSince: false, clampedUntil: false
});

// Start after / equal to end.
assert.deepStrictEqual(resolveCustomRange(String(NOW - 60), String(NOW - 3600), RET, NOW), { ok: false, error: "start_after_end" });
assert.deepStrictEqual(resolveCustomRange(String(NOW - 60), String(NOW - 60), RET, NOW), { ok: false, error: "start_after_end" });

// Malformed values.
for (const bad of ["", "abc", "-5", "1.5", "1e9", "99999999999999"]) {
  assert.deepStrictEqual(resolveCustomRange(bad, String(NOW), RET, NOW), { ok: false, error: "invalid_range" }, `start=${bad}`);
  assert.deepStrictEqual(resolveCustomRange(String(NOW - 60), bad, RET, NOW), { ok: false, error: "invalid_range" }, `end=${bad}`);
}

// Entirely older than the retention: nothing can exist there.
assert.deepStrictEqual(resolveCustomRange(String(NOW - 20 * DAY), String(NOW - 10 * DAY), RET, NOW), { ok: false, error: "outside_retention" });
assert.deepStrictEqual(resolveCustomRange(String(threshold - 100), String(threshold - 1), RET, NOW), { ok: false, error: "outside_retention" });

// Start older than the retention, end inside: start is moved up to the boundary.
assert.deepStrictEqual(resolveCustomRange(String(NOW - 20 * DAY), String(NOW - DAY), RET, NOW), {
  ok: true, since: threshold, until: NOW - DAY, clampedSince: true, clampedUntil: false
});
// End exactly on the boundary still has the boundary second.
assert.deepStrictEqual(resolveCustomRange(String(threshold - 100), String(threshold), RET, NOW), {
  ok: true, since: threshold, until: threshold, clampedSince: true, clampedUntil: false
});

// End in the future is moved down to now; start in the future is rejected.
assert.deepStrictEqual(resolveCustomRange(String(NOW - 600), String(NOW + 5000), RET, NOW), {
  ok: true, since: NOW - 600, until: NOW, clampedSince: false, clampedUntil: true
});
assert.deepStrictEqual(resolveCustomRange(String(NOW + 100), String(NOW + 5000), RET, NOW), { ok: false, error: "invalid_range" });

// Retention 0: every custom range is outside it.
assert.deepStrictEqual(resolveCustomRange(String(NOW - 600), String(NOW - 60), 0, NOW), { ok: false, error: "outside_retention" });

// Effective retention: profile value capped by the global maximum, fallback to the maximum.
assert.strictEqual(effectiveLogRetentionDays(7, 30), 7);
assert.strictEqual(effectiveLogRetentionDays(90, 30), 30);
assert.strictEqual(effectiveLogRetentionDays(undefined, 30), 30);
assert.strictEqual(effectiveLogRetentionDays("abc", 30), 30);
assert.strictEqual(effectiveLogRetentionDays(-3, 30), 0);

assert.strictEqual(effectiveLogRetentionDays(null, 7), 7);
assert.strictEqual(effectiveLogRetentionDays("", 7), 7);
assert.strictEqual(effectiveLogRetentionDays(30, 7), 7); // stored 30 but the role cap is 7

// Role caps: normal user 7 (env), admin = global 30, global always wins when lower.
const lim = { global: 30, normalUser: 7, admin: undefined as number | undefined };
assert.strictEqual(roleRetentionCap("user", lim), 7);
assert.strictEqual(roleRetentionCap("admin", lim), 30);
assert.strictEqual(roleRetentionCap("user", { ...lim, normalUser: undefined }), 7); // default 7
assert.strictEqual(roleRetentionCap("user", { ...lim, normalUser: 90 }), 30); // capped by the global max
assert.strictEqual(roleRetentionCap("admin", { global: 14, normalUser: undefined, admin: 60 }), 14);
assert.strictEqual(roleRetentionCap("user", { global: 3, normalUser: undefined, admin: undefined }), 3);

console.log("test_log_range_validation: all assertions passed");
