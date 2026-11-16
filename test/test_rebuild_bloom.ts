/// <reference types="node" />
import assert from "node:assert";
import { rebuildProfileFilter } from "../src/utils/sync/orchestrator";
import { FingerprintSet, FingerprintSetBuilder } from "../src/utils/fingerprintSet";
import type { Env } from "../src/types";

async function runTests() {
  console.log(">>> [TEST] Running rebuildProfileFilter Unit Tests...\n");

  // Mock database stores
  let profileStore: any = {
    id: "prof_1",
    list_updated_at: 1000 // Prior timestamp
  };

  const listStore = [
    { id: 1, profile_id: "prof_1", url: "https://example.com/list1.txt", enabled: 1 },
    { id: 2, profile_id: "prof_1", url: "https://example.com/list2.txt", enabled: 1 }
  ];

  // Create two separate filter sets
  const builder1 = new FingerprintSetBuilder();
  builder1.add("malware1.com");
  const filter1 = await builder1.build();

  const builder2 = new FingerprintSetBuilder();
  builder2.add("malware2.com");
  const filter2 = await builder2.build();

  const listFilterStore = new Map<number, ArrayBuffer>([
    [1, filter1.toUint8Array().buffer as ArrayBuffer],
    [2, filter2.toUint8Array().buffer as ArrayBuffer]
  ]);

  let profileFilterStore: ArrayBuffer | null = null;

  // Mock DB
  const mockDb: any = {
    prepare(sql: string) {
      const stmt = {
        bind(...args: any[]) {
          return {
            async first() {
              if (sql.includes("FROM profiles WHERE id = ?")) {
                return profileStore.id === args[0] ? profileStore : null;
              }
              if (sql.includes("FROM list_blooms WHERE list_id = ?")) {
                if (sql.includes("head") || sql.includes("substr")) {
                  const buf = listFilterStore.get(args[0]);
                  return buf ? { head: new Uint8Array(buf).slice(0, 16) } : null;
                }
                return listFilterStore.has(args[0]) ? { present: 1 } : null;
              }
              if (sql.includes("FROM profile_blooms WHERE profile_id = ?")) {
                if (sql.includes("head") || sql.includes("substr")) {
                  return profileFilterStore ? { head: new Uint8Array(profileFilterStore).slice(0, 16) } : null;
                }
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM lists WHERE profile_id = ?")) {
                return { results: listStore.filter(l => l.profile_id === args[0]) };
              }
              if (sql.includes("FROM list_blooms WHERE list_id = ?")) {
                const buf = listFilterStore.get(args[0]);
                return { results: buf ? [{ bloom_filter_chunk: buf }] : [] };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("UPDATE profiles SET list_updated_at = ? WHERE id = ?")) {
                profileStore.list_updated_at = args[0];
                return { success: true };
              }
              if (sql.includes("INSERT INTO profile_blooms")) {
                profileFilterStore = args[2];
                return { success: true };
              }
              if (sql.includes("DELETE FROM profile_blooms WHERE profile_id = ?")) {
                profileFilterStore = null;
                return { success: true };
              }
              return { success: true };
            }
          };
        },
        async all() {
          if (sql.includes("FROM system_lists")) {
            return { results: [] };
          }
          return { results: [] };
        },
        async first() {
          return null;
        },
        async run() {
          return { success: true };
        }
      };
      return stmt;
    },
    async batch(statements: any[]) {
      for (const stmt of statements) {
        await stmt.run();
      }
      return statements.map(() => ({ success: true }));
    }
  };

  const testEnv: Env = {
    DB: mockDb,
    ASSETS: {}
  };

  const mockCtx: any = {
    waitUntil(p: Promise<any>) {
      p.catch(() => {});
    }
  };

  // Test 1: Rebuild with 2 active lists
  console.log("1. Testing rebuildProfileFilter with 2 lists...");
  await rebuildProfileFilter("prof_1", testEnv, mockCtx);

  assert(profileFilterStore !== null, "Profile filter should have been created");
  const mergedFilter = FingerprintSet.fromUint8Array(new Uint8Array(profileFilterStore!));
  assert.strictEqual(mergedFilter.test("malware1.com"), true, "Should contain domain from list 1");
  assert.strictEqual(mergedFilter.test("malware2.com"), true, "Should contain domain from list 2");
  assert.strictEqual(mergedFilter.test("safe.com"), false, "Should not contain unlisted domain");
  assert.strictEqual(profileStore.list_updated_at, 1000, "priorListUpdatedAt should be preserved");

  // Test 2: Simulate list 1 deleted -> rebuild with only list 2 remaining
  console.log("2. Testing rebuildProfileFilter after deleting list 1...");
  listStore.shift(); // remove list 1
  listFilterStore.delete(1);

  await rebuildProfileFilter("prof_1", testEnv, mockCtx);

  assert(profileFilterStore !== null, "Profile filter should have been updated");
  const updatedFilter = FingerprintSet.fromUint8Array(new Uint8Array(profileFilterStore!));
  assert.strictEqual(updatedFilter.test("malware1.com"), false, "Should NO LONGER contain domain from deleted list 1");
  assert.strictEqual(updatedFilter.test("malware2.com"), true, "Should still contain domain from list 2");
  assert.strictEqual(profileStore.list_updated_at, 1000, "priorListUpdatedAt should still be preserved");

  // Test 3: Simulate list 2 deleted -> rebuild with 0 lists remaining
  console.log("3. Testing rebuildProfileFilter after deleting all lists...");
  listStore.shift(); // remove list 2
  listFilterStore.delete(2);

  await rebuildProfileFilter("prof_1", testEnv, mockCtx);
  assert.strictEqual(profileFilterStore, null, "Profile filter should be cleared when 0 lists remain");
  assert.strictEqual(profileStore.list_updated_at, 1000, "priorListUpdatedAt should still be preserved");

  console.log("\n>>> [TEST] All rebuildProfileFilter tests passed successfully!");
}

runTests().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
