/**
 * @file listParseWorker.ts
 * @description Worker-thread entry: runs one list download + parse + hash + sort + serialize job
 * (see listParseCore.ts) and posts the result back. The caller terminates the worker afterwards, which
 * returns the (large) parse heap to the OS instead of keeping it resident.
 */

import { parentPort, workerData } from "node:worker_threads";
import { parseListCore, ListParseParams } from "./listParseCore";

const port = parentPort!;
port.postMessage({ type: "started" });

parseListCore(workerData as ListParseParams)
  .then((result) => {
    const transfer = result.filterBytes ? [result.filterBytes.buffer as ArrayBuffer] : [];
    port.postMessage({ type: "result", result }, transfer);
  })
  .catch((err: unknown) => {
    port.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  });
