/**
 * @file domainState.ts
 * @description Decides when a query deserves a row in Query Logs.
 *
 * Query Logs are for checking (was it allowed / blocked / redirected, did it fail, did the answer change),
 * Analytics is for totals. A row used to be written on every DNS cache miss, which tied the log to the cache
 * lifecycle: when a list update cleared the cache, every domain got a "new" row again, and a lazy refresh that
 * silently swapped the IP of a CDN host left no trace at all.
 *
 * This module keeps a small RAM memory of the last answer seen per (profile, domain, type[, ECS scope]) that is
 * deliberately independent of the DNS cache (cache clears, expiry and lazy refreshes do not touch it).
 * Every resolved miss and every background refresh is compared with it:
 *
 *   no memory                 -> 'new'        first time this domain is seen
 *   answer differs            -> 'changed'    (found by a background refresh: 'refreshed')
 *   same answer, long ago     -> 'recheck'    re-logged at most once per DOMAIN_STATE_RELOG_SEC so the domain stays findable
 *   same answer, recently     -> null         no row; the caller counts the query like a cache hit (Analytics stays exact)
 *
 * "Answer" means the SET of A/AAAA addresses (order ignored, TTL ignored, CNAME chain ignored) plus action and
 * rcode. Other record types (HTTPS, TXT, ...) only report presence/absence changes, because their payload
 * (ECH configs, ...) rotates on its own.
 *
 * Privacy: the memory lives in RAM only and is never persisted, so it also works for E2EE profiles (their
 * domains/answers must not be stored in plaintext). The cost of that is that a process restart (or a fresh
 * Workers isolate) forgets it and the next query of each domain is logged as 'new' once, exactly like before.
 */
import { SizeCappedMap } from "./cache";
import { envNumber } from "../utils/envNumber";
import type { ProfileSettings } from "../types";

export type LogEvent = "new" | "changed" | "refreshed" | "recheck" | "error";

/** Canonical description of one resolution result. */
export interface AnswerSnapshot {
  /** Comparison key: equal fingerprints mean "same answer". */
  fp: string;
  /** Human-readable answer, shown as "previous answer" when it is replaced. */
  display: string;
  action: string;
}

/** What the caller must do with a resolved query. */
export interface EventDecision {
  /** Event to write as a log row, or null when no row is needed (count it as a cache hit instead). */
  event: LogEvent | null;
  /** Previous answer, set for 'changed' / 'refreshed'. */
  prevAnswer?: string;
  /** Previous action (e.g. PASS -> BLOCK after a list update), set for 'changed' / 'refreshed'. */
  prevAction?: string;
}

interface DomainStateEntry {
  fp: string;
  display: string;
  action: string;
  /** Last time a row of any event was written for this key (ms). */
  lastLoggedAt: number;
  /** Last time a 'changed' / 'refreshed' row was written (ms), for rate limiting CDNs that rotate constantly. */
  lastChangeLoggedAt: number;
  /** Last time a refresh error row was written (ms). */
  lastErrorLoggedAt: number;
}

export const DEFAULT_DOMAIN_STATE_LIMIT = 100_000;
/** Same answer is logged again after this long (seconds): keeps the domain findable once old rows age out. */
export const DEFAULT_RELOG_SEC = 24 * 3600;
/** At most one 'changed' row per key in this window (seconds); CDNs such as googlevideo rotate IPs constantly. */
export const DEFAULT_CHANGE_MIN_INTERVAL_SEC = 600;
/** At most one refresh-error row per key in this window (seconds). */
export const DEFAULT_ERROR_MIN_INTERVAL_SEC = 900;

const MAX_DISPLAY_CHARS = 240;
const MAX_FP_IPS = 32;

const state = new SizeCappedMap<string, DomainStateEntry>(DEFAULT_DOMAIN_STATE_LIMIT);
let lastLimitEnv: unknown;

type EnvLike = Record<string, unknown> | undefined;

function applyLimit(env: EnvLike): void {
  const raw = env?.DOMAIN_STATE_LIMIT ?? (typeof process !== "undefined" ? process.env?.DOMAIN_STATE_LIMIT : undefined);
  if (raw === lastLimitEnv) return;
  lastLimitEnv = raw;
  const limit = Math.floor(envNumber(raw, DEFAULT_DOMAIN_STATE_LIMIT, { min: 100 }));
  if (limit !== state.getMaxEntries()) state.setMaxEntries(limit);
}

function envSec(env: EnvLike, key: string, fallback: number, min: number): number {
  const raw = env?.[key] ?? (typeof process !== "undefined" ? process.env?.[key] : undefined);
  return envNumber(raw, fallback, { min });
}

/** Memory key. The ECS scope is part of it: clients in different subnets legitimately get different answers. */
export function domainStateKey(profileId: string, name: string, type: string, ecsScope?: string): string {
  const base = `${profileId}:${name}:${type}`;
  return ecsScope ? `${base}|${ecsScope}` : base;
}

/** Record fields needed to build a snapshot (subset of ParsedDNSAnswerRecord). */
export interface SnapshotRecord {
  type: string;
  data: string;
}

/**
 * Snapshot of a resolved upstream answer.
 * @param qtype - The queried record type.
 * @param rcode - DNS response code of the answer.
 * @param records - Decoded answer records.
 */
export function snapshotFromAnswer(
  action: string,
  qtype: string,
  rcode: number,
  records: SnapshotRecord[]
): AnswerSnapshot {
  const display = truncate(records.map((r) => r.data).join(", "));
  let body: string;
  if (qtype === "A" || qtype === "AAAA") {
    const ips = Array.from(new Set(records.filter((r) => r.type === "A" || r.type === "AAAA").map((r) => r.data))).sort();
    body = ips.slice(0, MAX_FP_IPS).join(",");
  } else {
    body = records.length > 0 ? "data" : "empty";
  }
  return { fp: `${action}|${rcode}|${body}`, display: display || rcodeLabel(rcode), action };
}

/** Snapshot of a synthetic BLOCK / REDIRECT answer (display answer such as 0.0.0.0, NXDOMAIN or a redirect target). */
export function snapshotFromSynthetic(action: string, displayAnswer: string): AnswerSnapshot {
  return { fp: `${action}|${displayAnswer}`, display: truncate(displayAnswer), action };
}

function truncate(text: string): string {
  return text.length > MAX_DISPLAY_CHARS ? `${text.slice(0, MAX_DISPLAY_CHARS - 1)}…` : text;
}

function rcodeLabel(rcode: number): string {
  switch (rcode) {
    case 0: return "NODATA";
    case 1: return "FORMERR";
    case 2: return "SERVFAIL";
    case 3: return "NXDOMAIN";
    case 4: return "NOTIMP";
    case 5: return "REFUSED";
    default: return `RCODE ${rcode}`;
  }
}

export interface ObserveOptions {
  /** True for a lazy-cache refresh (no client was waiting for this result). */
  background: boolean;
  env?: EnvLike;
  settings?: Pick<ProfileSettings, "log_retention_days">;
  now?: number;
}

/** Re-log interval in ms, never longer than half of the profile's log retention. */
function relogMs(opts: ObserveOptions): number {
  let sec = envSec(opts.env, "DOMAIN_STATE_RELOG_SEC", DEFAULT_RELOG_SEC, 60);
  const days = Number(opts.settings?.log_retention_days);
  if (Number.isFinite(days) && days > 0) sec = Math.min(sec, Math.floor((days * 86400) / 2));
  return sec * 1000;
}

/**
 * Compares a resolved answer with the remembered one, updates the memory and says whether a row is needed.
 * Cheap: one Map lookup and a few string comparisons, no I/O.
 */
export function observeAnswer(key: string, snap: AnswerSnapshot, opts: ObserveOptions): EventDecision {
  applyLimit(opts.env);
  const now = opts.now ?? Date.now();
  const entry = state.get(key);

  // fp === "" is a placeholder created by allowRefreshError (an error was logged before any answer was seen).
  if (!entry || entry.fp === "") {
    // A background refresh without memory has nothing to compare with: remember, do not log.
    state.set(key, {
      fp: snap.fp,
      display: snap.display,
      action: snap.action,
      lastLoggedAt: opts.background ? 0 : now,
      lastChangeLoggedAt: 0,
      lastErrorLoggedAt: entry?.lastErrorLoggedAt ?? 0
    });
    return { event: opts.background ? null : "new" };
  }

  if (entry.fp === snap.fp) {
    if (!opts.background && now - entry.lastLoggedAt >= relogMs(opts)) {
      entry.lastLoggedAt = now;
      return { event: "recheck" };
    }
    return { event: null };
  }

  // The answer changed. Always remember the newest one; only the row is rate limited.
  const prevAnswer = entry.display;
  const prevAction = entry.action;
  const minInterval = envSec(opts.env, "DOMAIN_STATE_CHANGE_MIN_SEC", DEFAULT_CHANGE_MIN_INTERVAL_SEC, 0) * 1000;
  const allowed = now - entry.lastChangeLoggedAt >= minInterval;
  entry.fp = snap.fp;
  entry.display = snap.display;
  entry.action = snap.action;
  if (!allowed) return { event: null };
  entry.lastChangeLoggedAt = now;
  entry.lastLoggedAt = now;
  return { event: opts.background ? "refreshed" : "changed", prevAnswer, prevAction };
}

/**
 * Rate limit for 'error' rows caused by a failed background refresh (the client was served the stale answer, so
 * nobody would otherwise learn that the upstream stopped answering). Returns true when a row may be written.
 */
export function allowRefreshError(key: string, env?: EnvLike, now: number = Date.now()): boolean {
  applyLimit(env);
  const minInterval = envSec(env, "DOMAIN_STATE_ERROR_MIN_SEC", DEFAULT_ERROR_MIN_INTERVAL_SEC, 0) * 1000;
  const entry = state.get(key);
  if (!entry) {
    state.set(key, { fp: "", display: "", action: "", lastLoggedAt: now, lastChangeLoggedAt: 0, lastErrorLoggedAt: now });
    return true;
  }
  if (now - entry.lastErrorLoggedAt < minInterval) return false;
  entry.lastErrorLoggedAt = now;
  return true;
}

/**
 * Forgets everything about the given profiles. Called when their logs are deleted: a domain must then be able to
 * show up in the (empty) Query Logs again instead of waiting for the next re-log interval.
 */
export function clearDomainStateFor(profileIds: Set<string> | string[]): void {
  const pSet = profileIds instanceof Set ? profileIds : new Set(profileIds);
  if (pSet.size === 0) return;
  for (const key of state.keys()) {
    const colon = key.indexOf(":");
    if (colon > 0 && pSet.has(key.slice(0, colon))) state.delete(key);
  }
}

/** Number of remembered keys (diagnostics and tests). */
export function domainStateSize(): number {
  return state.size;
}

/** Drops all memory (tests). */
export function resetDomainState(): void {
  state.clear();
}
