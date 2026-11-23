/**
 * @file listParseClient.ts
 * @description Runs the CPU-heavy half of a list sync (download, parse, hash, sort, serialize) on a worker
 * thread so the thread serving DNS never pays for it. One short-lived worker per job: jobs run in parallel
 * and the parse heap is released when the worker is terminated.
 *
 * Falls back to running inline (the previous behaviour, with cooperative yielding) when:
 *  - SYNC_WORKER=0, or
 *  - the worker bundle (list-parse-worker.mjs) is not next to the running file (dev via tsx / single-file builds), or
 *  - the worker cannot start (checked once; later jobs skip straight to inline).
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { parseListCore, ListParseParams, ListParseResult } from "./listParseCore";

/** Everything in ListParseParams except the yield knobs, which depend on where the job runs. */
export type ListParseJob = Omit<ListParseParams, "yieldBatchSize" | "yieldSleepMs">;

const isOff = (v: unknown): boolean => /^(0|off|false|no|none)$/i.test(String(v ?? "").trim());
const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && v !== "" && v !== undefined && v !== null ? n : fallback;
};

let workerBroken = false;
const UNAVAILABLE = Symbol("worker-unavailable");

function resolveWorkerFile(): string | null {
  const override = process.env.SYNC_WORKER_FILE; // tests: point at a freshly built bundle when running from source
  if (override) return fs.existsSync(override) ? override : null;
  try {
    const file = fileURLToPath(new URL("./list-parse-worker.mjs", import.meta.url).href);
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

function failed(message: string): ListParseResult {
  return {
    fetchError: `List parse worker failed: ${message}`,
    truncated: false,
    notModified: false,
    count: 0,
    domainLimitHit: false,
    regexLimitHit: false,
    filterBytes: null,
    adguardPayload: { exceptions: [], rewrites: {}, patterns: [] }
  };
}

function runInWorker(file: string, params: ListParseParams): Promise<ListParseResult | typeof UNAVAILABLE> {
  return new Promise((resolve) => {
    let started = false;
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(file, { workerData: params });
    } catch {
      resolve(UNAVAILABLE);
      return;
    }
    const done = (value: ListParseResult | typeof UNAVAILABLE): void => {
      if (settled) return;
      settled = true;
      void worker.terminate().catch(() => {});
      resolve(value);
    };
    worker.on("message", (m: any) => {
      if (m?.type === "started") started = true;
      else if (m?.type === "result") done(m.result as ListParseResult);
      else if (m?.type === "error") done(failed(String(m.message)));
    });
    worker.on("error", (err: Error) => done(started ? failed(err.message) : UNAVAILABLE));
    worker.on("exit", (code) => done(started ? failed(`exited with code ${code}`) : UNAVAILABLE));
  });
}

export async function runListParse(job: ListParseJob, env: object): Promise<ListParseResult> {
  const e = env as Record<string, unknown>;
  const read = (key: string): unknown => e?.[key] ?? process.env[key];

  if (!workerBroken && !isOff(read("SYNC_WORKER"))) {
    const file = resolveWorkerFile();
    if (file) {
      // A worker has its own thread, so it can run long slices between yields (defaults: 50k rules, 1 ms).
      const result = await runInWorker(file, {
        ...job,
        yieldBatchSize: Math.max(1, num(read("SYNC_WORKER_YIELD_BATCH_SIZE"), 50_000)),
        yieldSleepMs: num(read("SYNC_WORKER_YIELD_SLEEP_MS"), 1)
      });
      if (result !== UNAVAILABLE) return result;
      workerBroken = true;
      console.warn("[Sync] List parse worker could not start; parsing on the main thread from now on.");
    }
  }

  // Inline fallback: identical to the previous behaviour (small slices + sleeps so DNS stays responsive).
  return parseListCore({
    ...job,
    yieldBatchSize: Number(read("SYNC_YIELD_BATCH_SIZE")) || 5000,
    yieldSleepMs: Number(read("SYNC_YIELD_SLEEP_MS")) || 10
  });
}
