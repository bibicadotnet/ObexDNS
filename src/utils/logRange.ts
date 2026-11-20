/**
 * @file logRange.ts
 * @description Validation of the `start` / `end` custom range of the Query Logs and Analytics endpoints.
 *
 * A range that cannot contain any log (reversed, malformed, or entirely older than the profile's log
 * retention) is rejected up front, so no query is spent proving that it is empty. A start that reaches
 * further back than the retention is simply moved up to the retention boundary, since nothing older exists.
 */

export type CustomRangeError = "invalid_range" | "start_after_end" | "outside_retention";

export type CustomRangeResult =
  | { ok: true; since: number; until: number; clampedSince: boolean; clampedUntil: boolean }
  | { ok: false; error: CustomRangeError };

const UNIX_SECONDS = /^\d{1,12}$/;

/**
 * Effective log retention (days) of a profile: its own setting, never above `capDays` (the cap of the
 * profile owner's role: NORMAL_USER_MAX_LOG_RETENTION_DAYS or ADMIN_USER_MAX_LOG_RETENTION_DAYS, itself
 * limited by MAX_LOG_RETENTION_DAYS). A profile with no (valid) setting gets the cap.
 */
export function effectiveLogRetentionDays(
  profileRetentionDays: unknown,
  capDays: number
): number {
  if (profileRetentionDays === null || profileRetentionDays === undefined || profileRetentionDays === "") {
    return capDays;
  }
  const raw = Number(profileRetentionDays);
  return Number.isFinite(raw) ? Math.max(0, Math.min(raw, capDays)) : capDays;
}

/**
 * Highest retention (days) a role may have. Same rule as profile settings (PATCH) and the cleanup job:
 * the role's own limit, capped by the global MAX_LOG_RETENTION_DAYS (defaults: 7 for users, global for admins).
 */
export function roleRetentionCap(
  role: string | undefined,
  limits: { global: number; normalUser: number | undefined; admin: number | undefined }
): number {
  const global = limits.global;
  const raw = role === "admin" ? limits.admin : limits.normalUser;
  const fallback = role === "admin" ? global : Math.min(7, global);
  return raw === undefined ? fallback : Math.min(raw, global);
}

/**
 * Oldest second for which a profile can still hold logs.
 */
export function retentionThreshold(retentionDays: number, nowSec: number): number {
  return Math.floor(nowSec - retentionDays * 24 * 3600);
}

/**
 * Validates a custom `[start, end]` range (unix seconds, as query-string values).
 *
 * - malformed numbers                        -> `invalid_range`
 * - start >= end                             -> `start_after_end`
 * - end older than the retention window      -> `outside_retention` (no log can exist there)
 * - start before the retention window        -> moved up to the boundary (`clampedSince`)
 * - end in the future                        -> moved down to `nowSec` (`clampedUntil`)
 * - start in the future                      -> `invalid_range`
 */
export function resolveCustomRange(
  startParam: string,
  endParam: string,
  retentionDays: number,
  nowSec: number = Math.floor(Date.now() / 1000)
): CustomRangeResult {
  if (!UNIX_SECONDS.test(startParam) || !UNIX_SECONDS.test(endParam)) {
    return { ok: false, error: "invalid_range" };
  }
  const start = Number(startParam);
  const end = Number(endParam);
  if (start >= end) return { ok: false, error: "start_after_end" };

  const threshold = retentionThreshold(retentionDays, nowSec);
  if (end < threshold) return { ok: false, error: "outside_retention" };

  const until = Math.min(end, nowSec);
  const since = Math.max(start, threshold);
  if (since > until) return { ok: false, error: "invalid_range" };

  return { ok: true, since, until, clampedSince: since !== start, clampedUntil: until !== end };
}
