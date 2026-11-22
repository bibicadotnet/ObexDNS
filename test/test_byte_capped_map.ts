import { ByteCappedMap, SizeCappedMap } from "../src/pipeline/cache";

function assert(cond: any, msg: string) {
  if (!cond) throw new Error("Assertion failed: " + msg);
}

console.log("Running ByteCappedMap tests...");

const map = new ByteCappedMap<string, { byteLength: number; val: string }>(100);

// Add entry 1 (40 bytes)
map.set("a", { byteLength: 40, val: "A" });
assert(map.totalBytes === 40, `Expected 40, got ${map.totalBytes}`);
assert(map.size === 1, `Expected size 1`);

// Add entry 2 (40 bytes)
map.set("b", { byteLength: 40, val: "B" });
assert(map.totalBytes === 80, `Expected 80, got ${map.totalBytes}`);
assert(map.size === 2, `Expected size 2`);

// Overwrite entry 1 with new size (50 bytes)
map.set("a", { byteLength: 50, val: "A2" });
assert(map.totalBytes === 90, `Expected 90, got ${map.totalBytes}`);
assert(map.size === 2, `Expected size 2`);

// Touch 'b' so 'b' becomes newest and 'a' becomes oldest
assert(map.get("b")?.val === "B", "Get b");

// Add entry 3 (30 bytes) -> total would be 90 + 30 = 120 > 100.
// 'a' should be evicted because 'b' was touched!
map.set("c", { byteLength: 30, val: "C" });
assert(!map.has("a"), "Entry 'a' should have been evicted");
assert(map.has("b"), "Entry 'b' should remain");
assert(map.has("c"), "Entry 'c' should exist");
assert(map.totalBytes === 70, `Expected 70 (40+30), got ${map.totalBytes}`);

// Test setMaxBytes dynamic resizing
map.setMaxBytes(50);
// Currently has b (40) and c (30) = 70 > 50 -> oldest 'b' should be evicted!
assert(map.totalBytes <= 50, `Expected <= 50, got ${map.totalBytes}`);
assert(!map.has("b"), "b should be evicted on shrink");
assert(map.has("c"), "c should remain");

// Test item exceeding budget still admitted
map.set("huge", { byteLength: 150, val: "HUGE" });
assert(map.size === 1, "Only huge should be in map");
assert(map.has("huge"), "huge should exist");
assert(map.totalBytes === 150, `Expected 150, got ${map.totalBytes}`);

// Clear
map.clear();
assert(map.totalBytes === 0, "Expected 0 bytes after clear");
assert(map.size === 0, "Expected size 0");

console.log("Running SizeCappedMap tests...");
const sizeMap = new SizeCappedMap<string, string>(3);
sizeMap.set("k1", "v1");
sizeMap.set("k2", "v2");
sizeMap.set("k3", "v3");
assert(sizeMap.size === 3, "Size should be 3");

// Touch k1 so k2 becomes oldest
assert(sizeMap.get("k1") === "v1", "Get k1");
sizeMap.set("k4", "v4");
assert(!sizeMap.has("k2"), "k2 should be evicted");
assert(sizeMap.has("k1"), "k1 should remain");
assert(sizeMap.has("k3"), "k3 should remain");
assert(sizeMap.has("k4"), "k4 should remain");

// Test setMaxEntries dynamic resizing
sizeMap.setMaxEntries(2);
assert(sizeMap.size === 2, "Size should shrink to 2");
assert(!sizeMap.has("k3"), "k3 should be evicted on shrink");
assert(sizeMap.has("k1") && sizeMap.has("k4"), "k1 and k4 remain");

console.log("All ByteCappedMap & SizeCappedMap tests PASSED!");
