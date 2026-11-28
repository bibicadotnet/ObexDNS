/**
 * @file types.ts
 * @description Types, configuration reader and entry shape for the connection guard
 * (country allow-list + per-IP rate limit). No `node:*` imports: this module is bundled with the Workers build too.
 */

import type { Env } from '../../types';
import { envNumber } from '../../utils/envNumber';

/** Per-IP state. All timestamps are milliseconds (`Date.now()`). */
export interface GuardEntry {
  /** Tokens left in the new-connection bucket. */
  tokConn: number;
  /** Last refill of the new-connection bucket (ms). */
  tConn: number;
  /** Tokens left in the request bucket. */
  tokReq: number;
  /** Last refill of the request bucket (ms). */
  tReq: number;
  /** While `penaltyUntil > now` every connection / request from this IP is rejected (ms). */
  penaltyUntil: number;
  /** Last time this IP was seen (ms), used by the idle cleanup. */
  lastSeen: number;
}

/** Parsed, validated guard configuration (all time values keep the env unit, converted at the point of use). */
export interface GuardConfig {
  enableGeo: boolean;
  /** Upper-case ISO country codes, e.g. ['VN', 'SG']. */
  countries: string[];
  enableRate: boolean;
  rateTcp: number;
  burstTcp: number;
  rateReq: number;
  burstReq: number;
  /** Seconds. */
  penaltyTimeSec: number;
  allowlistIps: string[];
  allowlistUrls: string[];
  geoSources: string[];
  syncIntervalHours: number;
  syncRetryMinutes: number;
  fetchTimeoutMs: number;
  minRanges: number;
  minRangesRatio: number;
  maxEntries: number;
  /** Seconds. */
  idleTtlSec: number;
  /** Longest CPU slice (ms) of background work before it sleeps. */
  yieldSliceMs: number;
  /** Sleep (ms) between two slices of background work. */
  yieldSleepMs: number;
  dryRun: boolean;
}

export const DEFAULT_GEO_SOURCES: readonly string[] = [
  'https://raw.githubusercontent.com/ipverse/rir-ip/refs/heads/master/country/{cc}/ipv4-aggregated.txt',
  'https://www.ipdeny.com/ipblocks/data/countries/{cc}.zone',
  'https://raw.githubusercontent.com/ipverse/geo-ip-blocks/master/country/{cc}/{cc}-ipv4.txt',
  'https://raw.githubusercontent.com/bibicadotnet/IPinfo-VietNam/main/country/{cc}.txt'
];

const DEFAULT_ALLOW_COUNTRIES = 'VN,SG,JP,HK';
const DEFAULT_ALLOWLIST_IPS = '217.15.166.168';
const DEFAULT_ALLOWLIST_URLS = 'https://hetrixtools.com/resources/uptime-monitor-only-ips.txt';

function splitList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Reads the guard configuration from env.
 * Flags are compared with `=== 'true'`. Numbers go through envNumber() with a minimum; invalid values fall back to the default.
 * ALLOW_COUNTRIES: unset, empty or without any valid 2-letter code -> default. GUARD_GEO_SOURCES: unset or empty -> default. ALLOWLIST_IPS / ALLOWLIST_URLS: unset -> default, empty -> no entries.
 */
export function readGuardConfig(env: Partial<Env> | Record<string, unknown>): GuardConfig {
  const e = env as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

  const countriesRaw = (str(e.ALLOW_COUNTRIES) ?? '').trim() || DEFAULT_ALLOW_COUNTRIES;
  const requested = splitList(countriesRaw).map((c) => c.toUpperCase());
  const invalid = requested.filter((c) => !/^[A-Z]{2}$/.test(c));
  let countries = Array.from(new Set(requested.filter((c) => /^[A-Z]{2}$/.test(c))));
  if (invalid.length > 0) {
    console.warn(`[Guard] ALLOW_COUNTRIES: ignoring invalid country code(s): ${invalid.join(', ')}`);
  }
  if (countries.length === 0) {
    countries = splitList(DEFAULT_ALLOW_COUNTRIES);
    console.warn(`[Guard] ALLOW_COUNTRIES="${countriesRaw}" has no valid 2-letter country code. Falling back to the default: ${countries.join(',')}`);
  }

  const sourcesRaw = (str(e.GUARD_GEO_SOURCES) ?? '').trim();
  const geoSources = sourcesRaw ? splitList(sourcesRaw) : [...DEFAULT_GEO_SOURCES];

  return {
    enableGeo: e.ENABLE_ALLOW_COUNTRIES === 'true',
    countries,
    enableRate: e.ENABLE_RATE_LIMIT === 'true',
    rateTcp: envNumber(e.RATE_LIMIT_TCP, 500, { min: 1 }),
    burstTcp: envNumber(e.BURST_TCP, 5000, { min: 1 }),
    rateReq: envNumber(e.RATE_LIMIT_REQ, 2000, { min: 1 }),
    burstReq: envNumber(e.BURST_REQ, 20000, { min: 1 }),
    penaltyTimeSec: envNumber(e.PENALTY_TIME, 5, { min: 1 }),
    allowlistIps: splitList(str(e.ALLOWLIST_IPS) ?? DEFAULT_ALLOWLIST_IPS),
    allowlistUrls: splitList(str(e.ALLOWLIST_URLS) ?? DEFAULT_ALLOWLIST_URLS),
    geoSources,
    syncIntervalHours: envNumber(e.GUARD_SYNC_INTERVAL_HOURS, 24, { min: 0.01 }),
    syncRetryMinutes: envNumber(e.GUARD_SYNC_RETRY_MINUTES, 30, { min: 1 }),
    fetchTimeoutMs: envNumber(e.GUARD_FETCH_TIMEOUT_MS, 5000, { min: 500 }),
    minRanges: envNumber(e.GUARD_MIN_RANGES, 100, { min: 0 }),
    minRangesRatio: envNumber(e.GUARD_MIN_RANGES_RATIO, 0.5, { min: 0, max: 1 }),
    maxEntries: envNumber(e.GUARD_MAX_ENTRIES, 100000, { min: 1000 }),
    idleTtlSec: envNumber(e.GUARD_IDLE_TTL_SEC, 300, { min: 1 }),
    yieldSliceMs: envNumber(e.GUARD_YIELD_SLICE_MS, 2, { min: 0.5 }),
    yieldSleepMs: envNumber(e.GUARD_YIELD_SLEEP_MS, 10, { min: 0 }),
    dryRun: e.GUARD_DRY_RUN === 'true'
  };
}
