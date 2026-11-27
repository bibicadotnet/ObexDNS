/**
 * @file syncWarnings.ts
 * @description Machine-readable encoding of "list was truncated" warnings.
 *
 * Instead of storing localized English prose in `sync_error`, the backend stores a compact code
 * carrying the limit that was actually in effect (read from env at sync time). The frontend
 * decodes it and renders a translated message, so numbers are never hard-coded.
 *
 * Format: `limit:<kind>=<value>` entries joined by `;`
 *   e.g. `limit:bytes=26214400;limit:domains=500000`
 */

export type ListLimitKind = "bytes" | "domains" | "regex";

export const LIMIT_WARNING_PREFIX = "limit:";

const KIND_ORDER: ListLimitKind[] = ["bytes", "domains", "regex"];

/** Encodes the limits that were hit (kind → configured limit) or returns null when none was hit. */
export function encodeLimitWarnings(hits: Partial<Record<ListLimitKind, number>>): string | null {
  const parts = KIND_ORDER.filter((kind) => hits[kind] !== undefined).map(
    (kind) => `${LIMIT_WARNING_PREFIX}${kind}=${hits[kind]}`
  );
  return parts.length > 0 ? parts.join(";") : null;
}

/** On a 304 the stored warning is still valid: returns it if it is a limit code, otherwise null (real errors are cleared). */
export function keepLimitWarning(stored: string | null | undefined): string | null {
  return stored && stored.startsWith(LIMIT_WARNING_PREFIX) ? stored : null;
}
