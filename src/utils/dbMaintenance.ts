/**
 * @file dbMaintenance.ts
 * @description Duck-typed access to optional storage maintenance offered only by the local SQLite
 * adapter (Serverfull File mode). Cloudflare D1 and Turso do not implement it, so calls are no-ops there.
 */

import type { ExecutionContext } from "../types";

/** Subset of NodeD1Database used here, kept structural so shared code does not import node:sqlite. */
interface SpaceReclaimingDb {
  reclaimSpace?: (options?: {
    minFreePages?: number;
    stopBelowPages?: number;
    maxMs?: number;
  }) => Promise<unknown>;
}

/**
 * Starts a background job that returns free pages (left behind by a large delete, e.g. "delete all logs")
 * to the filesystem. It works in short chunks that yield to the event loop, so unlike a full VACUUM it
 * never blocks DNS resolution or the HTTP response for the delete itself.
 *
 * No-op when the database does not support it.
 */
export function scheduleSpaceReclaim(db: unknown, ctx?: ExecutionContext): void {
  const target = db as SpaceReclaimingDb | null | undefined;
  if (typeof target?.reclaimSpace !== "function") return;

  const job = target
    .reclaimSpace({ minFreePages: 1, stopBelowPages: 0, maxMs: 120_000 })
    .catch((err: unknown) => console.warn("[DB] Space reclaim failed:", err));

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(job);
  }
}
