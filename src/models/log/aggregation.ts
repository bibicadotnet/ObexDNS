import { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { SystemSettingsModel } from "../systemSettings";
import { ResolutionLog } from "../../types";

/** One pre-aggregated hourly_rollups row delta (added to the stored count on conflict). */
export interface RollupItem {
  profileId: string;
  metricType: string;
  hourTimestamp: number;
  key: string;
  subKey: string;
  accessPointId: string;
  count: number;
}

/** Rollups only have hour granularity, so they are used for ranges of at least this many seconds. */
export const ROLLUP_MIN_SPAN_SEC = 86400;

/**
 * How long the minute buckets of cache hits (`hit_*` metrics) are kept. They only exist to make the two
 * partial edge hours of a window exact (and to answer windows under 24h), so they are needed for little
 * more than a day, unlike the hourly rollups that follow the profile's log retention.
 * 26h = the 24h range (24h + up to a minute of alignment) + the hour a reader may still be using + 1h guard.
 */
export const HIT_RETENTION_SEC = 26 * 3600;

/** Hits-metric rows older than this are deleted. Hour-aligned, so a whole hour of minutes goes at once. */
export function hitRetentionCutoff(nowSec: number = Math.floor(Date.now() / 1000)): number {
  return Math.floor((nowSec - HIT_RETENTION_SEC) / 3600) * 3600;
}

/**
 * Oldest instant whose minute buckets can be relied on. One hour above the retention cutoff, so a query
 * never depends on an hour that a cleanup (possibly with a slightly different clock) is deleting right now.
 * A window edge below this is "in the deleted zone": see `planRollupQuery` / `planHitRange`.
 */
export function minuteDataFloor(nowSec: number = Math.floor(Date.now() / 1000)): number {
  return hitRetentionCutoff(nowSec) + 3600;
}

/** Clock drift tolerated between a relative range's `until` (taken at request start) and the planner's `now`. */
export const LIVE_SLACK_SEC = 5;

/**
 * Whether a window ending at `until` owns the whole current hour ("live" window).
 * `until` of a relative range is the clock at request start, so a few seconds of slack separate it from `nowSec`.
 * A custom end is aligned to the last second of a minute (:59, see alignRangeToMinutes) and is a real boundary the
 * user chose: it only counts as "now" once it really is in the future, otherwise events after it would be added.
 */
export function isLiveEnd(until: number, nowSec: number): boolean {
  const currentHour = Math.floor(nowSec / 3600) * 3600;
  const slack = until % 60 === 59 ? 0 : LIVE_SLACK_SEC;
  return until >= nowSec - slack && until >= currentHour;
}

/** What an analytics answer really covers, compared to the window that was asked for. */
export interface AnalyticsWindowInfo {
  /** True when the answer covers a different (whole-hour) window than the requested one. */
  aligned: boolean;
  /** True when no exact answer exists at all: the window is too old and holds no whole hour. */
  tooOld: boolean;
  /** First / last second actually covered. Both null when `tooOld`. */
  alignedSince: number | null;
  alignedUntil: number | null;
}

/**
 * Describes the window `planRollupQuery` answers for [since, until], without touching the database.
 * Same rules as the planner: an edge below `minuteDataFloor` can only be answered in whole hours.
 * (If a profile has no rollups at all the planner falls back to raw logs; that case is exact and not reported.)
 */
export function describeAnalyticsWindow(
  since: number,
  until: number,
  nowSec: number = Math.floor(Date.now() / 1000)
): AnalyticsWindowInfo {
  const minuteFloor = minuteDataFloor(nowSec);
  if (since >= minuteFloor) {
    return { aligned: false, tooOld: false, alignedSince: since, alignedUntil: until };
  }
  const from = Math.ceil(since / 3600) * 3600;
  const currentHour = Math.floor(nowSec / 3600) * 3600;
  const live = isLiveEnd(until, nowSec);
  const windowEnd = live ? currentHour + 3600 : Math.floor((until + 1) / 3600) * 3600;
  if (windowEnd <= from) {
    return { aligned: true, tooOld: true, alignedSince: null, alignedUntil: null };
  }
  // The tail [windowEnd, until] stays exact while it lies inside the minute-data zone.
  const alignedUntil = live || until >= minuteFloor ? until : windowEnd - 1;
  return { aligned: from !== since || alignedUntil !== until, tooOld: false, alignedSince: from, alignedUntil };
}

/** Where a ranged analytics query reads from: rollup hours, plus raw logs for any uncovered tail. */
export interface RollupPlan {
  /** Rollup rows with `hour_timestamp >= rollupFrom AND hour_timestamp < rollupTo`. */
  rollupFrom: number;
  rollupTo: number;
  /** Uncovered head slice [since, rollupFrom - 1], or null when `since` is already hour-aligned. */
  head: { from: number; to: number } | null;
  /** Uncovered tail slice [rollupEnd, until] of a window that ended in the past (never set for a live window). */
  tail: { from: number; to: number } | null;
  /** Raw log rows with `timestamp >= from AND timestamp <= to`, or null when rollups cover everything. */
  raw: { from: number; to: number } | null;
}

/**
 * Decides how to answer an analytics query over [since, until] from hourly_rollups.
 *
 * Rollups are written live (cache hits and logged queries, including the current hour) and can only
 * be summed in whole hours. Summing whole hours around a sub-hour boundary over-counts, which made
 * 10M and 1H return the very same hour total. So:
 *  - ranges shorter than 24h return null: callers must query the raw logs with the exact boundaries;
 *  - otherwise the lower edge is snapped UP to the next full hour (never counting data before
 *    `since`), and the upper edge includes the current (live) hour or stops at the last full hour
 *    that ends before `until`.
 *
 * Partial edge hours (head/tail) are made exact with raw logs + the minute buckets of cache hits, but those
 * buckets are deleted after HIT_RETENTION_SEC. An edge that lies below `minuteDataFloor` therefore cannot be
 * exact any more (raw logs alone would miss the hits), so the window is aligned to whole hours instead:
 *  - `since` below the floor: no head; the window starts at the next full hour;
 *  - `until` below the floor (a window that ended long ago): no tail; the window ends at the last full hour;
 *  - a range of ANY length whose start is below the floor is answered from the rollups (never from raw logs),
 *    and one with no full hour inside returns an empty plan (zero rows), not a partial raw count.
 *
 * @param since - Range start (unix seconds).
 * @param until - Range end (unix seconds).
 * @param latestRollupHour - Newest hour_timestamp present for the metric, or null if none.
 * @param nowSec - Current time (unix seconds), injectable for tests.
 * @returns A plan, or null when the raw logs must answer the whole range.
 */
export function planRollupQuery(
  since: number,
  until: number,
  latestRollupHour: number | null,
  nowSec: number = Math.floor(Date.now() / 1000)
): RollupPlan | null {
  if (latestRollupHour === null) return null;
  const minuteFloor = minuteDataFloor(nowSec);
  const minutesKept = since >= minuteFloor;
  if (minutesKept && until - since < ROLLUP_MIN_SPAN_SEC) return null;

  const rollupFrom = Math.ceil(since / 3600) * 3600;
  const currentHour = Math.floor(nowSec / 3600) * 3600;
  // A window ending at "now" owns the whole live hour (nothing exists after now). Any other window ends at the
  // last full hour inside it, and the remainder [windowEnd, until] becomes the exact tail.
  const live = isLiveEnd(until, nowSec);
  const windowEnd = live ? currentHour + 3600 : Math.floor((until + 1) / 3600) * 3600;
  // Aligned to whole hours and not one of them inside: nothing can be answered exactly, so answer "nothing".
  if (!minutesKept && windowEnd <= rollupFrom) {
    return { rollupFrom: 0, rollupTo: 0, head: null, tail: null, raw: null };
  }
  const rollupTo = Math.min(windowEnd, latestRollupHour + 3600);
  if (rollupTo <= rollupFrom) return null;

  const head = since < rollupFrom && minutesKept ? { from: since, to: rollupFrom - 1 } : null;
  const tail = !live && until >= windowEnd && windowEnd >= minuteFloor ? { from: windowEnd, to: until } : null;
  const rawFrom = rollupTo;
  const rawTo = Math.min(until, windowEnd - 1);
  return {
    rollupFrom,
    rollupTo,
    head,
    tail,
    raw: rawFrom <= rawTo ? { from: rawFrom, to: rawTo } : null
  };
}

/**
 * Snaps an analytics window to whole minutes. Cache hits are only bucketed per minute, so a window that
 * starts or ends inside a minute can only be approximated for them; with whole-minute edges the log rows
 * (exact to the second) and the hit buckets describe exactly the same window.
 *
 * The start is always floored to the minute (for a relative range this equals `floor(now/60)*60 - span`).
 * A custom end is moved to the last second of its minute; a relative end stays at "now".
 */
export function alignRangeToMinutes(
  since: number,
  until: number,
  customEnd: boolean
): { since: number; until: number } {
  return {
    since: Math.floor(since / 60) * 60,
    until: customEnd ? Math.floor(until / 60) * 60 + 59 : until
  };
}

/**
 * Minute buckets of cache hits (`hit_*` rollup metrics) to add to the raw log rows of a SHORT range
 * (under 24h), where hourly rollups are too coarse. Returns null for long ranges, which are
 * answered from the hourly rollups instead (those already contain the hits), and for ranges that start
 * below `minuteDataFloor`, whose minute buckets have been deleted.
 * The lower edge is snapped up to the next whole minute.
 */
export function planHitRange(
  since: number,
  until: number,
  nowSec: number = Math.floor(Date.now() / 1000)
): { from: number; to: number } | null {
  if (until - since >= ROLLUP_MIN_SPAN_SEC) return null;
  // Minute buckets of that age are already deleted: there is nothing to add to the raw rows.
  if (since < minuteDataFloor(nowSec)) return null;
  return { from: Math.ceil(since / 60) * 60, to: until };
}

/**
 * Model responsible for maintaining and computing hourly rollups
 * across resolution logs, clients, destinations, and domains in a unified table.
 */
export class LogAggregationModel {
  private tablesEnsured = false;

  constructor(private readonly db: D1Database) {}

  /**
   * Automatically creates the unified hourly_rollups table if it does not exist yet.
   * Self-heals environments (such as Turso on Cloudflare Workers) where build-time D1 migrations
   * do not execute against the remote Turso database.
   */
  async ensureRollupTables(): Promise<void> {
    if (this.tablesEnsured) return;
    if (typeof this.db.exec !== 'function') return;
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS hourly_rollups (
            profile_id TEXT NOT NULL,
            metric_type TEXT NOT NULL,
            hour_timestamp INTEGER NOT NULL,
            key TEXT NOT NULL,
            sub_key TEXT NOT NULL DEFAULT '',
            access_point_id TEXT NOT NULL DEFAULT '',
            count INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (
                profile_id,
                metric_type,
                hour_timestamp,
                key,
                sub_key,
                access_point_id
            )
        ) WITHOUT ROWID;
      `);
      this.tablesEnsured = true;
    } catch (e: any) {
      console.warn("[LogAggregationModel] ensureRollupTables notice:", e.message || e);
    }
  }

  /**
   * Generates atomic UPSERT statements for in-flight log micro-batches before sensitive data encryption.
   * Aggregates occurrences in-memory by (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id)
   * to drastically reduce database write row count.
   *
   * @param logs - Array of raw unencrypted resolution logs.
   * @param actionOnlyProfileIds - Profiles with E2EE enabled: only the privacy-neutral `action`
   *   totals are rolled up for them. Domains, client IPs and destination countries are plaintext at
   *   this point and must never reach the server-side rollup table.
   * @returns Array of D1PreparedStatements to be committed atomically with log batch.
   */
  createRollupUpsertStatements(
    logs: ResolutionLog[],
    actionOnlyProfileIds?: ReadonlySet<string>
  ): D1PreparedStatement[] {
    if (!logs || logs.length === 0) return [];

    const map = new Map<string, RollupItem>();

    for (const log of logs) {
      if (!log.profile_id) continue;
      const hourTs = Math.floor(log.timestamp / 3600) * 3600;
      const apId = log.access_point_id || '';

      // 1. Action metric (for traffic summary and trend)
      if (log.action) {
        const actionKey = `${log.profile_id}|action|${hourTs}|${log.action}||${apId}`;
        const existing = map.get(actionKey);
        if (existing) {
          existing.count++;
        } else {
          map.set(actionKey, {
            profileId: log.profile_id,
            metricType: 'action',
            hourTimestamp: hourTs,
            key: log.action,
            subKey: '',
            accessPointId: apId,
            count: 1
          });
        }
      }

      // E2EE profiles: nothing beyond the action totals may be stored in plaintext.
      if (actionOnlyProfileIds?.has(log.profile_id)) continue;

      // 2. Domain metric (for top allowed and blocked domains)
      if (log.domain && log.domain !== '[Encrypted]') {
        const domainKey = `${log.profile_id}|domain|${hourTs}|${log.domain}|${log.action || ''}|${apId}`;
        const existing = map.get(domainKey);
        if (existing) {
          existing.count++;
        } else {
          map.set(domainKey, {
            profileId: log.profile_id,
            metricType: 'domain',
            hourTimestamp: hourTs,
            key: log.domain,
            subKey: log.action || '',
            accessPointId: apId,
            count: 1
          });
        }
      }

      // 3. Client IP & geo country metric (for client device analytics)
      if (log.client_ip && log.client_ip !== '[Encrypted]') {
        const geoCountry = log.geo_country || '';
        const clientKey = `${log.profile_id}|client|${hourTs}|${log.client_ip}|${geoCountry}|${apId}`;
        const existing = map.get(clientKey);
        if (existing) {
          existing.count++;
        } else {
          map.set(clientKey, {
            profileId: log.profile_id,
            metricType: 'client',
            hourTimestamp: hourTs,
            key: log.client_ip,
            subKey: geoCountry,
            accessPointId: apId,
            count: 1
          });
        }
      }

      // 4. Destination country metric (for geo destination analytics)
      let destCode = log.dest_country_code || '';
      let destCountry = log.dest_country || '';
      if (!destCode && log.dest_geoip && log.dest_geoip.startsWith('{')) {
        try {
          const parsed = JSON.parse(log.dest_geoip);
          destCode = parsed.country_code || '';
          destCountry = parsed.country || '';
        } catch {}
      }
      if (destCode) {
        const codeUpper = destCode.toUpperCase();
        const destKey = `${log.profile_id}|dest|${hourTs}|${codeUpper}|${destCountry}|${apId}`;
        const existing = map.get(destKey);
        if (existing) {
          existing.count++;
        } else {
          map.set(destKey, {
            profileId: log.profile_id,
            metricType: 'dest',
            hourTimestamp: hourTs,
            key: codeUpper,
            subKey: destCountry,
            accessPointId: apId,
            count: 1
          });
        }
      }
    }

    return this.createUpsertStatementsFromItems(map.values());
  }

  /**
   * Builds atomic `count = count + n` UPSERT statements for already aggregated rollup deltas.
   * Shared by the log flush path (cache misses) and the in-memory cache-hit counter flush,
   * so both land on exactly the same hourly_rollups keys.
   *
   * @param items - Rollup deltas keyed by (profile, metric, hour, key, sub_key, access point).
   * @returns Array of D1PreparedStatements.
   */
  createUpsertStatementsFromItems(items: Iterable<RollupItem>): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [];
    for (const item of items) {
      if (item.count <= 0) continue;
      statements.push(
        this.db.prepare(`
          INSERT INTO hourly_rollups (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id, count)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id)
          DO UPDATE SET count = count + excluded.count
        `).bind(
          item.profileId,
          item.metricType,
          item.hourTimestamp,
          item.key,
          item.subKey,
          item.accessPointId,
          item.count
        )
      );
    }
    return statements;
  }

  /**
   * Retrieves the latest completed hour timestamp aggregated in hourly_rollups for a profile and metric.
   *
   * @param profileId - Profile identifier.
   * @param metricType - Optional metric type ('action', 'domain', 'client', 'dest'). Defaults to 'action'.
   * @returns The latest hour timestamp, or null if no rollups exist.
   */
  async getLatestRollupHour(profileId: string, metricType = 'action'): Promise<number | null> {
    try {
      const row = await this.db.prepare(
        "SELECT MAX(hour_timestamp) as max_hour FROM hourly_rollups WHERE profile_id = ? AND metric_type = ?"
      ).bind(profileId, metricType).first<{ max_hour: number | null }>();
      return row?.max_hour ?? null;
    } catch {
      await this.ensureRollupTables();
      return null;
    }
  }

  /**
   * Retrieves the latest completed hour timestamp aggregated in hourly_rollups for clients.
   */
  async getLatestClientRollupHour(profileId: string): Promise<number | null> {
    return this.getLatestRollupHour(profileId, 'client');
  }

  /**
   * Retrieves the latest completed hour timestamp aggregated in hourly_rollups for destinations.
   */
  async getLatestDestinationRollupHour(profileId: string): Promise<number | null> {
    return this.getLatestRollupHour(profileId, 'dest');
  }

  /**
   * Retrieves the latest completed hour timestamp aggregated in hourly_rollups for domains.
   */
  async getLatestDomainRollupHour(profileId: string): Promise<number | null> {
    return this.getLatestRollupHour(profileId, 'domain');
  }

  /**
   * Aggregates completed hours of raw logs into the unified hourly_rollups table.
   * Runs in the background during hourly cron maintenance (or on-demand).
   *
   * @param sinceSec - Optional start timestamp. If omitted, bridges from system_settings or defaults to preceding hour.
   * @param untilSec - Optional end timestamp. Defaults to start of current hour (only completed hours).
   * @param minDomainCount - Minimum query count threshold for domain rollups (default 1).
   * @returns Total number of rollup records inserted or updated.
   */
  async aggregateHourlyRollups(
    sinceSec?: number,
    untilSec?: number,
    minDomainCount = 1
  ): Promise<number> {
    await this.ensureRollupTables();
    const now = Math.floor(Date.now() / 1000);
    const currentHourStart = Math.floor(now / 3600) * 3600;
    const effectiveUntil = untilSec !== undefined ? Math.min(untilSec, currentHourStart) : currentHourStart;

    let effectiveSince = sinceSec;
    const systemSettings = new SystemSettingsModel(this.db);

    if (effectiveSince === undefined) {
      const lastAggregatedStr = await systemSettings.get("last_hourly_rollup_timestamp");
      if (lastAggregatedStr) {
        const lastHour = parseInt(lastAggregatedStr, 10);
        if (!isNaN(lastHour) && lastHour > 0) {
          effectiveSince = Math.max(lastHour, effectiveUntil - 86400);
        }
      }
      if (effectiveSince === undefined) {
        effectiveSince = Math.max(0, effectiveUntil - 3600);
      }
    }

    if (effectiveSince >= effectiveUntil) {
      return 0;
    }

    try {
      const { results: profiles } = await this.db.prepare(
        "SELECT id FROM profiles"
      ).all<{ id: string }>();

      if (!profiles || profiles.length === 0) {
        await systemSettings.set("last_hourly_rollup_timestamp", String(effectiveUntil));
        return 0;
      }

      let totalAggregatedRows = 0;

      // Process profile-by-profile to guarantee clustered index range seeks (profile_id, timestamp)
      // and completely eliminate whole-table full scans on logs.
      for (const profile of profiles) {
        const statements: D1PreparedStatement[] = [
          // 1. Action rollups
          this.db.prepare(`
            INSERT INTO hourly_rollups (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id, count)
            SELECT
                ?,
                'action',
                (timestamp / 3600) * 3600 AS hour_timestamp,
                action,
                '',
                COALESCE(access_point_id, ''),
                COUNT(*) AS count
            FROM logs
            WHERE profile_id = ? AND timestamp >= ? AND timestamp < ?
            GROUP BY (timestamp / 3600) * 3600, action, COALESCE(access_point_id, '')
            ON CONFLICT (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id)
            DO UPDATE SET count = count + excluded.count
          `).bind(profile.id, profile.id, effectiveSince, effectiveUntil),

          // 2. Client IP & Country rollups
          this.db.prepare(`
            INSERT INTO hourly_rollups (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id, count)
            SELECT
                ?,
                'client',
                (timestamp / 3600) * 3600 AS hour_timestamp,
                client_ip,
                COALESCE(geo_country, ''),
                COALESCE(access_point_id, ''),
                COUNT(*) AS count
            FROM logs
            WHERE profile_id = ? AND timestamp >= ? AND timestamp < ?
              AND client_ip IS NOT NULL AND client_ip != '' AND client_ip != '[Encrypted]'
            GROUP BY (timestamp / 3600) * 3600, client_ip, COALESCE(geo_country, ''), COALESCE(access_point_id, '')
            ON CONFLICT (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id)
            DO UPDATE SET count = count + excluded.count
          `).bind(profile.id, profile.id, effectiveSince, effectiveUntil),

          // 3. Destination Country rollups
          this.db.prepare(`
            INSERT INTO hourly_rollups (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id, count)
            SELECT
                ?,
                'dest',
                (timestamp / 3600) * 3600 AS hour_timestamp,
                UPPER(CASE 
                  WHEN dest_country_code IS NOT NULL AND dest_country_code != '' THEN dest_country_code
                  WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.country_code')
                  ELSE ''
                END) AS key,
                MAX(CASE 
                  WHEN dest_country IS NOT NULL AND dest_country != '' THEN dest_country
                  WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.country')
                  ELSE 'Unknown'
                END) AS sub_key,
                COALESCE(access_point_id, '') AS access_point_id,
                COUNT(*) AS count
            FROM logs
            WHERE profile_id = ? AND timestamp >= ? AND timestamp < ?
              AND (
                (dest_country_code IS NOT NULL AND dest_country_code != '')
                OR
                (dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' AND json_extract(dest_geoip, '$.country_code') IS NOT NULL AND json_extract(dest_geoip, '$.country_code') != '')
              )
            GROUP BY (timestamp / 3600) * 3600, 
                     UPPER(CASE 
                       WHEN dest_country_code IS NOT NULL AND dest_country_code != '' THEN dest_country_code
                       WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.country_code')
                       ELSE ''
                     END),
                     COALESCE(access_point_id, '')
            ON CONFLICT (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id)
            DO UPDATE SET count = count + excluded.count
          `).bind(profile.id, profile.id, effectiveSince, effectiveUntil),

          // 4. Domain rollups
          this.db.prepare(`
            INSERT INTO hourly_rollups (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id, count)
            SELECT
                ?,
                'domain',
                (timestamp / 3600) * 3600 AS hour_timestamp,
                domain,
                action,
                COALESCE(access_point_id, ''),
                COUNT(*) AS count
            FROM logs
            WHERE profile_id = ? AND timestamp >= ? AND timestamp < ?
              AND domain IS NOT NULL AND domain != '' AND domain != '[Encrypted]'
            GROUP BY (timestamp / 3600) * 3600, domain, action, COALESCE(access_point_id, '')
            HAVING COUNT(*) >= ?
            ON CONFLICT (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id)
            DO UPDATE SET count = count + excluded.count
          `).bind(profile.id, profile.id, effectiveSince, effectiveUntil, minDomainCount)
        ];

        const results = await this.db.batch(statements);
        for (const res of results) {
          totalAggregatedRows += res.meta.changes || 0;
        }
      }

      await systemSettings.set("last_hourly_rollup_timestamp", String(effectiveUntil));
      return totalAggregatedRows;
    } catch (e: any) {
      console.error("[LogAggregationModel] aggregateHourlyRollups failed:", e.message || e);
      return 0;
    }
  }
}
