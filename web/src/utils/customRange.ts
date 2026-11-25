/**
 * @file customRange.ts
 * @description Input handling for the "Custom range" Start/End pickers of Analytics and Query Logs.
 *
 * Everything here works on the `datetime-local` strings (`YYYY-MM-DDTHH:mm`, browser-local time) the inputs
 * hold. The point is to stop impossible ranges at the input, before any request is made:
 *  - a start older than the log retention cannot have logs, so it is moved up to the retention boundary;
 *  - an end in the future is moved down to now;
 *  - start >= end, or an end entirely older than the retention, is reported and blocks Apply.
 */

export type CustomRangeIssue = "incomplete" | "invalid" | "startAfterEnd" | "outsideRetention";

export interface CustomRangeCheck {
  valid: boolean;
  /** Why the range cannot be applied. `incomplete` (a field still empty) is not worth an error message. */
  issue?: CustomRangeIssue;
  /** Unix seconds of the checked range; only set when `valid`. */
  since?: number;
  until?: number;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Unix seconds -> `datetime-local` value in local time (minute precision). */
export function toLocalInputValue(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `datetime-local` value -> unix seconds, or NaN for an empty / unparsable value. */
export function fromLocalInputValue(value: string): number {
  if (!value) return NaN;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}

/** Oldest instant worth asking for, rounded UP to the minute so it is itself a selectable value. */
export function retentionFloorSec(retentionDays: number, nowSec: number = Math.floor(Date.now() / 1000)): number {
  return Math.ceil((nowSec - retentionDays * 86400) / 60) * 60;
}

/** `min` attribute for the pickers: the oldest value that can still hold logs. */
export function retentionMinInput(retentionDays: number, nowSec?: number): string {
  return toLocalInputValue(retentionFloorSec(retentionDays, nowSec));
}

/**
 * Corrects a value the moment it is typed or picked (the native `min`/`max` attributes only grey out the
 * calendar; typing or pasting a value still gets through). An empty / partial value is returned untouched.
 */
export function clampCustomInput(
  field: "start" | "end",
  value: string,
  retentionDays: number,
  nowSec: number = Math.floor(Date.now() / 1000)
): string {
  const sec = fromLocalInputValue(value);
  if (Number.isNaN(sec)) return value;
  if (sec > nowSec) return toLocalInputValue(nowSec);
  if (field === "start") {
    const floor = retentionFloorSec(retentionDays, nowSec);
    if (sec < floor) return toLocalInputValue(floor);
  }
  return value;
}

/** Whether `[start, end]` can be sent as a custom range. */
export function validateCustomRange(
  start: string,
  end: string,
  retentionDays: number,
  nowSec: number = Math.floor(Date.now() / 1000)
): CustomRangeCheck {
  if (!start || !end) return { valid: false, issue: "incomplete" };
  const since = fromLocalInputValue(start);
  const until = fromLocalInputValue(end);
  if (Number.isNaN(since) || Number.isNaN(until)) return { valid: false, issue: "invalid" };
  if (since >= until) return { valid: false, issue: "startAfterEnd" };
  if (until < retentionFloorSec(retentionDays, nowSec)) return { valid: false, issue: "outsideRetention" };
  if (since > nowSec) return { valid: false, issue: "invalid" };
  return { valid: true, since, until };
}

/** i18n key of the message for an issue, or null when nothing should be shown. */
export function customRangeIssueKey(issue: CustomRangeIssue | undefined): string | null {
  switch (issue) {
    case "startAfterEnd":
      return "analytics.rangeStartAfterEnd";
    case "outsideRetention":
      return "analytics.rangeOutsideRetention";
    case "invalid":
      return "analytics.rangeInvalid";
    default:
      return null;
  }
}

/**
 * Retention (days) that really applies to a profile on the client: the profile's own setting, never above the
 * limit of the user's role (`max_log_retention_days` of /api/account/me: NORMAL_USER_MAX_LOG_RETENTION_DAYS or
 * the admin one). A profile without a setting gets the role limit. With neither value known, `fallback`.
 */
export function effectiveRetentionDays(
  profileSetting: unknown,
  roleCapDays: number | null | undefined,
  fallback = 30
): number {
  const cap = typeof roleCapDays === "number" && Number.isFinite(roleCapDays) ? Math.max(0, roleCapDays) : undefined;
  const hasSetting = profileSetting !== null && profileSetting !== undefined && profileSetting !== "";
  const own = hasSetting ? Number(profileSetting) : NaN;
  if (Number.isFinite(own)) return Math.max(0, cap === undefined ? own : Math.min(own, cap));
  return cap ?? fallback;
}
