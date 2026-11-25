import { D1Database } from "@cloudflare/workers-types";
import { LogAggregationModel, planRollupQuery, planHitRange } from "../aggregation";
import { ActionCountResult, TimeSeriesTrendPoint } from "./types";

const SAFE_INTERVALS = new Set([
  "(timestamp/60)*60",
  "(timestamp/300)*300",
  "(timestamp/900)*900",
  "(timestamp/3600)*3600",
  "(timestamp/86400)*86400"
]);

/**
 * Handles action volume summaries and time-series trend analytics.
 *
 * Ranges of 24h or more are answered from `hourly_rollups` (which also count DNS cache hits),
 * snapped to whole hours. Shorter ranges, and any query with a granular filter, read the raw
 * `logs` table with exact boundaries (cache hits write no log row, so they are not part of it).
 */
export class LogTrafficAnalytics {
  constructor(
    private readonly db: D1Database,
    private readonly aggregation?: LogAggregationModel
  ) {}

  /**
   * Retrieves action counts (PASS, BLOCK, REDIRECT, FAIL) for a given time range.
   *
   * @param profileId - Profile identifier.
   * @param since - Start timestamp in seconds.
   * @param until - End timestamp in seconds.
   * @param search - Optional domain search substring.
   * @param accessPointId - Optional device/access point ID.
   * @param destCountry - Optional destination country code.
   * @param isp - Optional ISP name filter.
   * @param status - Optional action status filter (e.g. PASS, BLOCK).
   * @param exact - Optional boolean flag to force exact count query against raw logs table directly.
   * @returns Array of action counts.
   */
  async getSummary(
    profileId: string,
    since: number,
    until: number,
    search?: string,
    accessPointId?: string,
    destCountry?: string,
    isp?: string,
    status?: string,
    exact?: boolean
  ): Promise<ActionCountResult[]> {
    // Granular filters (and the Query Logs page, via `exact`) can only be answered from raw logs.
    if (exact || search || destCountry || isp || status || !this.aggregation) {
      return this.rawSummary(profileId, since, until, { search, accessPointId, destCountry, isp, status });
    }

    // Rollups carry the access point, so a device view uses the same source (and the same
    // cache-hit-inclusive totals) as the "all access points" view.
    const plan = planRollupQuery(since, until, await this.aggregation.getLatestRollupHour(profileId));
    if (!plan) {
      const hits = planHitRange(since, until);
      if (!hits) return this.rawSummary(profileId, since, until, { accessPointId });

      // Short range: exact log rows (cache misses) + minute buckets of cache hits.
      let hitSql =
        "SELECT key as action, SUM(count) as count FROM hourly_rollups WHERE profile_id = ? AND metric_type = 'hit_action' AND hour_timestamp >= ? AND hour_timestamp <= ?";
      const hitParams: (string | number)[] = [profileId, hits.from, hits.to];
      let rawSql =
        "SELECT action, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ?";
      const rawParams: (string | number)[] = [profileId, since, until];
      if (accessPointId) {
        hitSql += " AND access_point_id = ?";
        hitParams.push(accessPointId);
        rawSql += " AND access_point_id = ?";
        rawParams.push(accessPointId);
      }
      const { results } = await this.db
        .prepare(
          `SELECT action, SUM(count) as count FROM (${rawSql} GROUP BY action UNION ALL ${hitSql} GROUP BY key) GROUP BY action`
        )
        .bind(...rawParams, ...hitParams)
        .all<ActionCountResult>();
      return results;
    }

    let rollupSql =
      "SELECT key as action, SUM(count) as count FROM hourly_rollups WHERE profile_id = ? AND metric_type = 'action' AND hour_timestamp >= ? AND hour_timestamp < ?";
    const rollupParams: (string | number)[] = [profileId, plan.rollupFrom, plan.rollupTo];
    if (accessPointId) {
      rollupSql += " AND access_point_id = ?";
      rollupParams.push(accessPointId);
    }
    rollupSql += " GROUP BY key";

    const subqueries: string[] = [rollupSql];
    const allParams: (string | number)[] = [...rollupParams];

    for (const seg of [plan.head, plan.tail]) {
      if (!seg) continue;
      let rawHeadSql =
        "SELECT action, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ?";
      const rawHeadParams: (string | number)[] = [profileId, seg.from, seg.to];
      let hitHeadSql =
        "SELECT key as action, SUM(count) as count FROM hourly_rollups WHERE profile_id = ? AND metric_type = 'hit_action' AND hour_timestamp >= ? AND hour_timestamp <= ?";
      const hitHeadParams: (string | number)[] = [profileId, Math.ceil(seg.from / 60) * 60, seg.to];
      if (accessPointId) {
        rawHeadSql += " AND access_point_id = ?";
        rawHeadParams.push(accessPointId);
        hitHeadSql += " AND access_point_id = ?";
        hitHeadParams.push(accessPointId);
      }
      subqueries.push(`${rawHeadSql} GROUP BY action`, `${hitHeadSql} GROUP BY key`);
      allParams.push(...rawHeadParams, ...hitHeadParams);
    }

    if (plan.raw) {
      let rawTailSql =
        "SELECT action, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ?";
      const rawTailParams: (string | number)[] = [profileId, plan.raw.from, plan.raw.to];
      if (accessPointId) {
        rawTailSql += " AND access_point_id = ?";
        rawTailParams.push(accessPointId);
      }
      subqueries.push(`${rawTailSql} GROUP BY action`);
      allParams.push(...rawTailParams);
    }

    if (subqueries.length === 1) {
      const { results } = await this.db.prepare(rollupSql).bind(...rollupParams).all<ActionCountResult>();
      return results;
    }

    const { results } = await this.db
      .prepare(
        `SELECT action, SUM(count) as count FROM (${subqueries.join(" UNION ALL ")}) GROUP BY action`
      )
      .bind(...allParams)
      .all<ActionCountResult>();
    return results;
  }

  /**
   * Counts actions straight from the raw logs table over [since, until] (inclusive).
   */
  private async rawSummary(
    profileId: string,
    since: number,
    until: number,
    filters: {
      search?: string;
      accessPointId?: string;
      destCountry?: string;
      isp?: string;
      status?: string;
    }
  ): Promise<ActionCountResult[]> {
    const { search, accessPointId, destCountry, isp, status } = filters;
    let queryStr =
      "SELECT action, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ?";
    const params: (string | number)[] = [profileId, since, until];
    if (search) {
      queryStr += " AND domain LIKE ?";
      params.push(`%${search}%`);
    }
    if (accessPointId) {
      queryStr += " AND access_point_id = ?";
      params.push(accessPointId);
    }
    if (status === "FAIL") {
      // Literal so SQLite can answer from the partial index idx_logs_profile_fail_time (migration 0069).
      queryStr += " AND action = 'FAIL'";
    } else if (status) {
      queryStr += " AND action = ?";
      params.push(status);
    }
    if (destCountry) {
      queryStr += ` AND UPPER(CASE 
          WHEN dest_country_code IS NOT NULL AND dest_country_code != '' THEN dest_country_code
          WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.country_code')
          ELSE ''
        END) = ?`;
      params.push(destCountry.toUpperCase());
    }
    if (isp) {
      queryStr += ` AND (CASE 
          WHEN dest_isp IS NOT NULL AND dest_isp != '' THEN dest_isp
          WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.isp')
          ELSE ''
        END) = ?`;
      params.push(isp);
    }
    queryStr += " GROUP BY action";
    const { results } = await this.db
      .prepare(queryStr)
      .bind(...params)
      .all<ActionCountResult>();
    return results;
  }

  /**
   * Retrieves timeseries trend data aggregated by interval.
   *
   * @param profileId - Profile identifier.
   * @param since - Start timestamp in seconds.
   * @param until - End timestamp in seconds.
   * @param interval - SQL group by expression (e.g. `(timestamp/3600)*3600` or `(timestamp/86400)*86400`).
   * @param accessPointId - Optional device filter.
   * @returns Array of timeseries points ordered by timestamp ascending.
   */
  async getTrend(
    profileId: string,
    since: number,
    until: number,
    interval: string,
    accessPointId?: string
  ): Promise<TimeSeriesTrendPoint[]> {
    const isHourly = interval.includes("3600");
    const isDaily = interval.includes("86400");

    // Sub-hour buckets (and rollups disabled) can only come from the raw logs.
    if ((!isHourly && !isDaily) || !this.aggregation) {
      return this.rawTrend(
        profileId,
        since,
        until,
        interval,
        accessPointId,
        this.aggregation ? planHitRange(since, until) : null
      );
    }

    const plan = planRollupQuery(since, until, await this.aggregation.getLatestRollupHour(profileId));
    if (!plan) {
      return this.rawTrend(profileId, since, until, interval, accessPointId, planHitRange(since, until));
    }

    const rollupInterval = isDaily ? "(hour_timestamp / 86400) * 86400" : "hour_timestamp";
    const logsInterval = isDaily ? "(timestamp / 86400) * 86400" : "(timestamp / 3600) * 3600";

    let rollupSql = `SELECT ${rollupInterval} as timestamp, key as action, SUM(count) as count FROM hourly_rollups WHERE profile_id = ? AND metric_type = 'action' AND hour_timestamp >= ? AND hour_timestamp < ?`;
    const rollupParams: (string | number)[] = [profileId, plan.rollupFrom, plan.rollupTo];
    if (accessPointId) {
      rollupSql += " AND access_point_id = ?";
      rollupParams.push(accessPointId);
    }
    rollupSql += ` GROUP BY ${rollupInterval}, key`;

    const subqueries: string[] = [rollupSql];
    const allParams: (string | number)[] = [...rollupParams];

    for (const seg of [plan.head, plan.tail]) {
      if (!seg) continue;
      let rawHeadSql = `SELECT ${logsInterval} as timestamp, action, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ?`;
      const rawHeadParams: (string | number)[] = [profileId, seg.from, seg.to];
      const hitHeadInterval = isDaily ? "(hour_timestamp / 86400) * 86400" : "(hour_timestamp / 3600) * 3600";
      let hitHeadSql = `SELECT ${hitHeadInterval} as timestamp, key as action, SUM(count) as count FROM hourly_rollups WHERE profile_id = ? AND metric_type = 'hit_action' AND hour_timestamp >= ? AND hour_timestamp <= ?`;
      const hitHeadParams: (string | number)[] = [profileId, Math.ceil(seg.from / 60) * 60, seg.to];
      if (accessPointId) {
        rawHeadSql += " AND access_point_id = ?";
        rawHeadParams.push(accessPointId);
        hitHeadSql += " AND access_point_id = ?";
        hitHeadParams.push(accessPointId);
      }
      subqueries.push(`${rawHeadSql} GROUP BY ${logsInterval}, action`, `${hitHeadSql} GROUP BY ${hitHeadInterval}, key`);
      allParams.push(...rawHeadParams, ...hitHeadParams);
    }

    if (plan.raw) {
      let rawTailSql = `SELECT ${logsInterval} as timestamp, action, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ?`;
      const rawTailParams: (string | number)[] = [profileId, plan.raw.from, plan.raw.to];
      if (accessPointId) {
        rawTailSql += " AND access_point_id = ?";
        rawTailParams.push(accessPointId);
      }
      subqueries.push(`${rawTailSql} GROUP BY ${logsInterval}, action`);
      allParams.push(...rawTailParams);
    }

    if (subqueries.length === 1) {
      const { results } = await this.db
        .prepare(`${rollupSql} ORDER BY timestamp ASC`)
        .bind(...rollupParams)
        .all<TimeSeriesTrendPoint>();
      return results;
    }

    const { results } = await this.db
      .prepare(
        `SELECT timestamp, action, SUM(count) as count FROM (${subqueries.join(" UNION ALL ")}) GROUP BY timestamp, action ORDER BY timestamp ASC`
      )
      .bind(...allParams)
      .all<TimeSeriesTrendPoint>();
    return results;
  }

  /**
   * Trend from the raw logs; for short ranges the minute buckets of cache hits are added on top.
   */
  private async rawTrend(
    profileId: string,
    since: number,
    until: number,
    interval: string,
    accessPointId?: string,
    hits?: { from: number; to: number } | null
  ): Promise<TimeSeriesTrendPoint[]> {
    const safeInterval = SAFE_INTERVALS.has(interval.trim()) ? interval.trim() : "(timestamp/3600)*3600";

    let rawSql = `SELECT ${safeInterval} as timestamp, action, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ?`;
    const params: (string | number)[] = [profileId, since, until];
    if (accessPointId) {
      rawSql += " AND access_point_id = ?";
      params.push(accessPointId);
    }
    rawSql += ` GROUP BY ${safeInterval}, action`;

    if (!hits) {
      const { results } = await this.db
        .prepare(`${rawSql} ORDER BY timestamp ASC`)
        .bind(...params)
        .all<TimeSeriesTrendPoint>();
      return results;
    }

    // safeInterval is whitelisted above, so rewriting its column name is safe.
    const hitInterval = safeInterval.replace("timestamp", "hour_timestamp");
    let hitSql = `SELECT ${hitInterval} as timestamp, key as action, SUM(count) as count FROM hourly_rollups WHERE profile_id = ? AND metric_type = 'hit_action' AND hour_timestamp >= ? AND hour_timestamp <= ?`;
    const hitParams: (string | number)[] = [profileId, hits.from, hits.to];
    if (accessPointId) {
      hitSql += " AND access_point_id = ?";
      hitParams.push(accessPointId);
    }
    hitSql += ` GROUP BY ${hitInterval}, key`;

    const { results } = await this.db
      .prepare(
        `SELECT timestamp, action, SUM(count) as count FROM (${rawSql} UNION ALL ${hitSql}) GROUP BY timestamp, action ORDER BY timestamp ASC`
      )
      .bind(...params, ...hitParams)
      .all<TimeSeriesTrendPoint>();
    return results;
  }
}
