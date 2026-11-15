/**
 * @file yieldToEventLoop.ts
 * @description Lets pending I/O (DNS sockets, HTTP requests) run between two chunks of
 * synchronous work. SQLite calls in Serverfull mode (node:sqlite) are synchronous, so long
 * maintenance jobs are split into short chunks with a yield in between.
 */

/** Resolves on the next turn of the event loop, after pending I/O callbacks have run. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof setImmediate === 'function') {
      setImmediate(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}
