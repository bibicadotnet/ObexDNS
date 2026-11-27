/**
 * A block mark is dropped only when the row it stands for is deleted:
 * marks logged before the deletion cutoff go, newer marks stay (no duplicate log rows).
 */
import assert from "node:assert";
import { blockLogMarks, markBlockLogged, isBlockLogged, clearBlockLogMarksFor } from "../src/pipeline/cache";

blockLogMarks.clear();
const now = Math.floor(Date.now() / 1000);
blockLogMarks.set("p1:old.example", now - 8 * 86400);
blockLogMarks.set("p1:new.example", now - 86400);
blockLogMarks.set("p2:old.example", now - 8 * 86400);

clearBlockLogMarksFor(["p1"], now - 7 * 86400);
assert.strictEqual(isBlockLogged("p1", "old.example"), false, "row older than cutoff deleted -> mark dropped");
assert.strictEqual(isBlockLogged("p1", "new.example"), true, "row still in retention -> mark kept");
assert.strictEqual(isBlockLogged("p2", "old.example"), true, "other profile untouched");

markBlockLogged("p1", "fresh.example");
clearBlockLogMarksFor(["p1"]);
assert.strictEqual(isBlockLogged("p1", "fresh.example"), false, "no cutoff -> all marks of the profile dropped");
assert.strictEqual(isBlockLogged("p2", "old.example"), true);
console.log("OK");
