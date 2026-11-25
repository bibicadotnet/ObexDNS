/**
 * @file envNumber.ts
 * @description Safe numeric reader for environment variables.
 *
 * Unlike `Number(value) || fallback`, this helper accepts an explicit `0`
 * (useful for "disable" / "no retry" settings) and rejects NaN, Infinity and
 * negative values, falling back to the built-in default instead.
 */

export interface EnvNumberOptions {
  /** Minimum accepted value (inclusive). Values below it fall back to `fallback`. Default: 0 */
  min?: number;
  /** Maximum accepted value (inclusive). Larger values are clamped. Default: no upper bound */
  max?: number;
}

/**
 * Reads a numeric env value, returning `fallback` when it is unset, empty or invalid.
 *
 * @param value - Raw value from `env.X` (string, number, undefined or null).
 * @param fallback - Built-in default used when the value is missing or invalid.
 * @param options - Optional min / max bounds.
 */
export function envNumber(value: unknown, fallback: number, options: EnvNumberOptions = {}): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const min = options.min ?? 0;
  if (n < min) return fallback;
  if (options.max !== undefined && n > options.max) return options.max;
  return n;
}
