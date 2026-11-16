/**
 * @file memory.ts
 * @description Diagnostic memory tracking utility.
 */

export function logMemoryUsage(tag: string): void {
  if (typeof process !== "undefined" && process?.memoryUsage) {
    const m = process.memoryUsage();
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    console.log(
      `[Memory:${tag}] RSS: ${mb(m.rss)}MB | Heap: ${mb(m.heapUsed)}/${mb(m.heapTotal)}MB | ArrayBuffers: ${mb(m.arrayBuffers || 0)}MB | Ext: ${mb(m.external)}MB`
    );
  }
}
