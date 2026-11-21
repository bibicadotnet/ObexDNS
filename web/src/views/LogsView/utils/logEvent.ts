/**
 * Query Logs record events (why a row exists), not every DNS lookup.
 * See migration 0070 and src/pipeline/domainState.ts on the server.
 */
import type { LogEntry } from "../types";

export type LogEventKind = "new" | "changed" | "refreshed" | "recheck" | "error";

const KNOWN: ReadonlySet<string> = new Set(["new", "changed", "refreshed", "recheck", "error"]);

/** Returns the event of a row, or null for rows written before events existed (or unknown values). */
export function getLogEvent(log: Pick<LogEntry, "event">): LogEventKind | null {
  const e = log.event;
  return e && KNOWN.has(e) ? (e as LogEventKind) : null;
}

/** Blueprint intent class suffix per event. */
export function eventIntent(event: LogEventKind): "primary" | "warning" | "danger" | "none" | "success" {
  switch (event) {
    case "changed":
    case "refreshed":
      return "warning";
    case "error":
      return "danger";
    case "new":
      return "primary";
    default:
      return "none";
  }
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Keeps only the addresses of an "a, b, c" answer string (drops the CNAME chain); falls back to the whole text. */
export function addressesOf(answer: string | null | undefined): string {
  if (!answer) return "";
  const parts = answer.split(",").map((p) => p.trim()).filter(Boolean);
  const ips = parts.filter((p) => IPV4.test(p) || (p.includes(":") && /^[0-9a-fA-F:.]+$/.test(p)));
  return (ips.length > 0 ? ips : parts).join(", ");
}

/** "old → new" for changed/refreshed rows, otherwise the plain answer. */
export function answerWithChange(log: Pick<LogEntry, "answer" | "prev_answer" | "event">): string {
  const answer = log.answer || "";
  const event = getLogEvent(log);
  if ((event === "changed" || event === "refreshed") && log.prev_answer) {
    return `${addressesOf(log.prev_answer)} → ${addressesOf(answer) || answer || "-"}`;
  }
  return answer || "-";
}
