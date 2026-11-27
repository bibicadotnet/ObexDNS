/**
 * @file test_custom_range_input.ts
 * @description Frontend Custom Range input rules (web/src/utils/customRange.ts): over-long start is moved up to the
 * retention boundary, a future end down to now, reversed / expired ranges are reported and block Apply.
 */
import assert from "node:assert";
import {
  clampCustomInput,
  retentionFloorSec,
  toLocalInputValue,
  validateCustomRange
} from "../web/src/utils/customRange";

const NOW = Math.floor(new Date(2026, 10, 20, 12, 30, 20).getTime() / 1000); // local 2026-11-20 12:30:20
const RET = 7;
const at = (daysAgo: number, mins = 0) => toLocalInputValue(NOW - daysAgo * 86400 + mins * 60);
const floorStr = toLocalInputValue(retentionFloorSec(RET, NOW));

// Start older than the retention is moved up to the boundary (typed or pasted values included).
assert.strictEqual(clampCustomInput("start", at(20), RET, NOW), floorStr);
assert.strictEqual(clampCustomInput("start", at(3), RET, NOW), at(3));
// The boundary itself and anything after it is untouched.
assert.strictEqual(clampCustomInput("start", floorStr, RET, NOW), floorStr);
// End is never moved up to the retention (it would hide the problem); a future value goes down to now.
assert.strictEqual(clampCustomInput("end", at(20), RET, NOW), at(20));
assert.strictEqual(clampCustomInput("end", at(-2), RET, NOW), toLocalInputValue(NOW));
assert.strictEqual(clampCustomInput("start", at(-2), RET, NOW), toLocalInputValue(NOW));
// Empty / partial input is left alone.
assert.strictEqual(clampCustomInput("start", "", RET, NOW), "");

// Validation.
assert.deepStrictEqual(validateCustomRange("", at(1), RET, NOW), { valid: false, issue: "incomplete" });
assert.deepStrictEqual(validateCustomRange(at(1), "", RET, NOW), { valid: false, issue: "incomplete" });
assert.strictEqual(validateCustomRange(at(1, 10), at(1), RET, NOW).issue, "startAfterEnd"); // start later than end
assert.strictEqual(validateCustomRange(at(1), at(1), RET, NOW).issue, "startAfterEnd"); // equal
assert.strictEqual(validateCustomRange(at(20), at(10), RET, NOW).issue, "outsideRetention"); // all expired
assert.strictEqual(validateCustomRange("garbage", at(1), RET, NOW).issue, "invalid");
const ok = validateCustomRange(at(3), at(1), RET, NOW);
assert.ok(ok.valid && ok.since! < ok.until!);
// After clamping, a start that was too old is valid as long as the end is inside the retention.
assert.ok(validateCustomRange(clampCustomInput("start", at(20), RET, NOW), at(1), RET, NOW).valid);

console.log("test_custom_range_input: all assertions passed");

// Retention that applies on the client: profile setting capped by the role limit (e.g. NORMAL_USER_MAX = 7).
import { effectiveRetentionDays } from "../web/src/utils/customRange";
assert.strictEqual(effectiveRetentionDays(30, 7), 7);
assert.strictEqual(effectiveRetentionDays(3, 7), 3);
assert.strictEqual(effectiveRetentionDays(undefined, 7), 7);
assert.strictEqual(effectiveRetentionDays(undefined, undefined), 30);
assert.strictEqual(effectiveRetentionDays(14, undefined), 14);
assert.strictEqual(effectiveRetentionDays(0, 7), 0);
console.log("effectiveRetentionDays ok");
