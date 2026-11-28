/**
 * @file index.ts
 * @description Connection guard for Serverfull mode: country allow-list + per-IP rate limit (two token buckets) with a short penalty.
 * Hooks: attachGuard(server) on every TCP server (new connection, before the TLS handshake) and
 * checkRequestHit(remoteAddress) for every DNS query / HTTP request. UDP 53 is not protected.
 *
 * This module must not import `node:*` (type-only imports are fine) so src/cron.ts can still import it in the Workers build.
 */

import type { Env } from '../../types';
import { SystemSettingsModel } from '../../models/systemSettings';
import { cidrToRange, inRanges, ipToUint32, isPrivateUint32, mergeRanges } from './ip';
import { cleanupEntries, getOrCreateEntry, rebuildAllowlist, recomputeGeoActive, refill, resetState, state } from './store';
import { ALLOWLIST_KEY, ALLOWLIST_UPDATED_KEY, geoKey, geoUpdatedKey, loadRanges, loadUpdatedAtSec, runSync } from './sync';
import { readGuardConfig } from './types';

export { readGuardConfig } from './types';
export type { GuardConfig, GuardEntry } from './types';

/** Minimal shape of a net/tls/http/http2 server: only what attachGuard needs. */
type ListenerHost = { prependListener: (...args: any[]) => unknown };
/** Minimal shape of a net.Socket: type-only, so no node import is needed. */
type DestroyableSocket = { remoteAddress?: string; destroy: (error?: Error) => unknown };

// ── dry-run logging (throttled so an attack cannot flood the log) ────────────
let logWindowStart = 0;
let logInWindow = 0;
let logSuppressed = 0;
const MAX_DRY_RUN_LOGS_PER_SEC = 50;

function logWouldBlock(ip: string | undefined, reason: string): void {
  const now = Date.now();
  if (now - logWindowStart >= 1000) {
    if (logSuppressed > 0) console.log(`[Guard] dry-run: ${logSuppressed} more "would block" lines suppressed`);
    logWindowStart = now;
    logInWindow = 0;
    logSuppressed = 0;
  }
  if (logInWindow >= MAX_DRY_RUN_LOGS_PER_SEC) {
    logSuppressed++;
    return;
  }
  logInWindow++;
  console.log(`[Guard] would block ${ip ?? 'unknown'} ${reason}`);
}

/** Parses ALLOWLIST_IPS (single IPs or CIDRs). Invalid entries are skipped with a warning. */
function parseEnvAllowlist(entries: string[]): Uint32Array {
  const pairs: Array<[number, number]> = [];
  for (const entry of entries) {
    const range = cidrToRange(entry);
    if (range) pairs.push(range);
    else console.warn(`[Guard] Ignoring invalid ALLOWLIST_IPS entry: ${entry}`);
  }
  return mergeRanges(pairs);
}

/**
 * Boots the guard. Call right after env.DB is assigned and before any server is created.
 * Both switches off -> returns immediately and nothing else in this module does any work.
 */
export async function initGuard(env: Env): Promise<void> {
  resetState();
  const cfg = readGuardConfig(env);
  if (!cfg.enableGeo && !cfg.enableRate) return;

  state.cfg = cfg;
  state.active = true;
  state.envAllow = parseEnvAllowlist(cfg.allowlistIps);
  state.nextSyncAt = 0;

  const syncGeo = cfg.enableGeo && cfg.countries.length > 0;
  const syncAllow = cfg.allowlistUrls.length > 0;
  const updatedAt: Array<number | null> = [];

  try {
    const settings = new SystemSettingsModel(env.DB);

    const allow = await loadRanges(settings, ALLOWLIST_KEY);
    if (allow) state.urlAllow = allow;
    if (syncAllow) updatedAt.push(await loadUpdatedAtSec(settings, ALLOWLIST_UPDATED_KEY));

    if (syncGeo) {
      for (const cc of cfg.countries) {
        const arr = await loadRanges(settings, geoKey(cc));
        if (arr && arr.length > 0) state.geo.set(cc, arr);
        updatedAt.push(await loadUpdatedAtSec(settings, geoUpdatedKey(cc)));
      }
    }
  } catch (err) {
    console.warn('[Guard] Could not load saved lists:', err instanceof Error ? err.message : err);
    updatedAt.push(null);
  }

  rebuildAllowlist();
  recomputeGeoActive();

  // nextSyncAt = min(updated_at in DB, seconds) * 1000 + interval. Any missing updated_at -> 0 (sync now).
  if (!syncGeo && !syncAllow) {
    state.nextSyncAt = Infinity;
  } else if (updatedAt.some((v) => v === null)) {
    state.nextSyncAt = 0;
  } else {
    state.nextSyncAt = Math.min(...(updatedAt as number[])) * 1000 + cfg.syncIntervalHours * 3600 * 1000;
  }

  console.log(
    `[Guard] Active: countryFilter=${cfg.enableGeo ? (state.geoActive ? `on (${cfg.countries.join(',')})` : 'waiting for lists (fail-open)') : 'off'}, ` +
    `rateLimit=${cfg.enableRate ? 'on' : 'off'}${cfg.dryRun ? ', DRY-RUN (log only)' : ''}`
  );

  if (syncGeo && !state.geoActive) {
    console.warn('[Guard] Country lists are missing or incomplete: the country filter lets everything through until the first sync completes.');
    runSync(env).catch((err) => console.error('[Guard] Background sync error:', err));
  }
}

/** Adds the new-connection check (runs before the TLS handshake) to a server. No-op when the guard is off. */
export function attachGuard(server: ListenerHost): void {
  if (!state.active) return;
  server.prependListener('connection', onConnection);
}

/** New TCP connection: private/allowlist pass, then country filter, then the connection bucket. */
export function onConnection(socket: DestroyableSocket): void {
  const cfg = state.cfg;
  if (!cfg) return;
  const ipStr = socket.remoteAddress;
  const ip = ipToUint32(ipStr);
  if (ip === null) return;
  if (isPrivateUint32(ip)) return;
  if (inRanges(state.allow, ip)) return;

  if (state.geoActive) {
    let allowed = false;
    for (const cc of cfg.countries) {
      if (inRanges(state.geo.get(cc), ip)) { allowed = true; break; }
    }
    if (!allowed) {
      if (cfg.dryRun) logWouldBlock(ipStr, 'geo');
      else socket.destroy();
      return;
    }
  }

  if (!cfg.enableRate) return;

  const now = Date.now();
  const entry = getOrCreateEntry(ip, now);
  const penaltyMs = cfg.penaltyTimeSec * 1000;

  if (entry.penaltyUntil > now) {
    entry.penaltyUntil = now + penaltyMs;
    socket.destroy();
    return;
  }

  entry.tokConn = refill(entry.tokConn, entry.tConn, now, cfg.rateTcp, cfg.burstTcp);
  entry.tConn = now;
  if (entry.tokConn >= 1) {
    entry.tokConn -= 1;
    return;
  }

  if (cfg.dryRun) {
    logWouldBlock(ipStr, 'rate-tcp');
    return;
  }
  entry.penaltyUntil = now + penaltyMs;
  socket.destroy();
}

/**
 * Per DNS query / HTTP request. Returns false when the connection must be closed.
 * Keyed by IP; the country is not re-checked here (it was checked when the connection was opened).
 */
export function checkRequestHit(remoteAddress: string | undefined): boolean {
  const cfg = state.cfg;
  if (!cfg || !state.active || !cfg.enableRate) return true;
  const ip = ipToUint32(remoteAddress);
  if (ip === null) return true;
  if (isPrivateUint32(ip) || inRanges(state.allow, ip)) return true;

  const now = Date.now();
  const entry = getOrCreateEntry(ip, now);
  const penaltyMs = cfg.penaltyTimeSec * 1000;

  if (entry.penaltyUntil > now) {
    entry.penaltyUntil = now + penaltyMs;
    return false;
  }

  entry.tokReq = refill(entry.tokReq, entry.tReq, now, cfg.rateReq, cfg.burstReq);
  entry.tReq = now;
  if (entry.tokReq >= 1) {
    entry.tokReq -= 1;
    return true;
  }

  if (cfg.dryRun) {
    logWouldBlock(remoteAddress, 'rate-req');
    return true;
  }
  entry.penaltyUntil = now + penaltyMs;
  return false;
}

/** Called by cron every 60 s: sweeps idle entries, then syncs the lists when they are due. Never throws. */
export async function guardTick(env: Env): Promise<void> {
  if (!state.active || !state.cfg) return;
  try {
    const now = Date.now();
    cleanupEntries(now);
    if (now < state.nextSyncAt) return;
    await runSync(env);
  } catch (err) {
    console.error('[Guard] Tick failed:', err);
  }
}

/** Test/inspection helpers. */
export function getNextSyncAt(): number {
  return state.nextSyncAt;
}
export { state as guardState, resetState as resetGuardForTests };
