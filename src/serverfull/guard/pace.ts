/**
 * @file pace.ts
 * @description CPU pacing for the guard's heavy work (parsing / merging / encoding downloaded lists, sweeping the IP map).
 *
 * Why a time budget and not "every N items": the cost of one item depends on the machine (cold JIT, small vCPU), so a fixed
 * batch can mean 2 ms on one host and 15 ms on another. The longest stall a DNS query can suffer is exactly one slice,
 * so the slice is bounded in milliseconds: work for at most `sliceMs`, then sleep `sleepMs` so queued DNS / HTTP events run.
 *
 * Usage inside a loop (the clock is read only every few dozen items, it costs ~0.05 us per read):
 *   if ((++n & 63) === 0 && pace.due()) await pace.rest();
 *
 * One pacer per CPU-bound phase: its slice starts when it is created, so create it right before the phase
 * (not before a network wait). No `node:*` imports (performance / setTimeout are globals in Node and Workers).
 */

export interface Pacer {
  /** True once the current slice has used up its CPU budget. */
  due(): boolean;
  /** Sleeps (event loop is free) and starts a new slice. */
  rest(): Promise<void>;
  /** How many times it rested (tests / diagnostics). */
  readonly rests: number;
}

export function createPacer(sliceMs: number, sleepMs: number): Pacer {
  let sliceStart = performance.now();
  let rests = 0;
  return {
    due: () => performance.now() - sliceStart >= sliceMs,
    async rest() {
      rests++;
      await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
      sliceStart = performance.now();
    },
    get rests() {
      return rests;
    }
  };
}
