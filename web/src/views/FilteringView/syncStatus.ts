import type { TFunction } from "i18next";

/** Which configured limit truncated a list. Mirrors the backend's `ListLimitKind`. */
export type LimitKind = "bytes" | "domains" | "regex";

export interface LimitWarning {
  kind: LimitKind;
  /** Limit in effect on the server when the list was synced (bytes for `bytes`, a count otherwise). */
  limit: number;
}

export interface ParsedSyncStatus {
  /** Truncation warnings; the list still synced and is in use. */
  warnings: LimitWarning[];
  /** A real sync failure message (raw server text); null when there is none. */
  error: string | null;
}

// Backend format (src/utils/sync/syncWarnings.ts): `limit:<kind>=<value>` entries joined by `;`
const LIMIT_RE = /^limit:(bytes|domains|regex)=(\d+)$/;

/** Splits a list's `sync_error` into truncation warnings and a genuine error. */
export function parseSyncStatus(raw: string | null | undefined): ParsedSyncStatus {
  if (!raw) return { warnings: [], error: null };
  const warnings: LimitWarning[] = [];
  for (const part of raw.split(";")) {
    const m = LIMIT_RE.exec(part.trim());
    if (!m) return { warnings: [], error: raw };
    warnings.push({ kind: m[1] as LimitKind, limit: Number(m[2]) });
  }
  return { warnings, error: null };
}

/** Localized sentence for one warning; the number always comes from the server-side limit. */
export function limitWarningText(t: TFunction, w: LimitWarning): string {
  if (w.kind === "bytes") {
    const mb = Math.round((w.limit / 1024 / 1024) * 10) / 10;
    return t("filtering.limitWarnBytes", { limit: mb.toLocaleString() });
  }
  const key = w.kind === "domains" ? "filtering.limitWarnDomains" : "filtering.limitWarnRegex";
  return t(key, { limit: w.limit.toLocaleString() });
}
