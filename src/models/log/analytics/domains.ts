import { D1Database } from "@cloudflare/workers-types";
import { LogAggregationModel, planRollupQuery, planHitRange } from "../aggregation";
import { DomainCountResult } from "./types";

/**
 * Handles top allowed and top blocked domain analytics.
 * Ranges of 24h or more use `hourly_rollups` (cache hits included, whole hours); shorter ranges
 * read the raw logs with exact boundaries.
 */
export class LogDomainAnalytics {
  constructor(
    private readonly db: D1Database,
    private readonly aggregation?: LogAggregationModel
  ) {}

  /**
   * Retrieves top allowed domains for a given time range.
   *
   * @param profileId - Profile identifier.
   * @param since - Start timestamp in seconds.
   * @param until - End timestamp in seconds.
   * @param accessPointId - Optional device filter.
   * @returns Array of top allowed domain records ordered by count descending.
   */
  async getTopAllowed(
    profileId: string,
    since: number,
    until: number,
    accessPointId?: string
  ): Promise<DomainCountResult[]> {
    return this.getTopByAction(profileId, since, until, "PASS", accessPointId);
  }

  /**
   * Retrieves top blocked domains for a given time range.
   *
   * @param profileId - Profile identifier.
   * @param since - Start timestamp in seconds.
   * @param until - End timestamp in seconds.
   * @param accessPointId - Optional device filter.
   * @returns Array of top blocked domain records ordered by count descending.
   */
  async getTopBlocked(
    profileId: string,
    since: number,
    until: number,
    accessPointId?: string
  ): Promise<DomainCountResult[]> {
    return this.getTopByAction(profileId, since, until, "BLOCK", accessPointId);
  }

  private async getTopByAction(
    profileId: string,
    since: number,
    until: number,
    action: "PASS" | "BLOCK",
    accessPointId?: string
  ): Promise<DomainCountResult[]> {
    const rawQuery = (from: number, to: number, grouped: boolean) => {
      let sql =
        "SELECT domain, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ? AND domain IS NOT NULL AND domain != '' AND domain != '[Encrypted]' AND action = ?";
      const params: (string | number)[] = [profileId, from, to, action];
      if (accessPointId) {
        sql += " AND access_point_id = ?";
        params.push(accessPointId);
      }
      sql += " GROUP BY domain";
      if (!grouped) sql += " ORDER BY count DESC LIMIT 10";
      return { sql, params };
    };

    const plan = this.aggregation
      ? planRollupQuery(since, until, await this.aggregation.getLatestDomainRollupHour(profileId))
      : null;

    if (!plan) {
      const hits = this.aggregation ? planHitRange(since, until) : null;
      if (!hits) {
        const { sql, params } = rawQuery(since, until, false);
        const { results } = await this.db.prepare(sql).bind(...params).all<DomainCountResult>();
        return results;
      }
      // Short range: exact log rows + minute buckets of cache hits.
      const raw = rawQuery(since, until, true);
      let hitSql =
        "SELECT key as domain, SUM(count) as count FROM hourly_rollups WHERE profile_id = ? AND metric_type = 'hit_domain' AND sub_key = ? AND hour_timestamp >= ? AND hour_timestamp <= ?";
      const hitParams: (string | number)[] = [profileId, action, hits.from, hits.to];
      if (accessPointId) {
        hitSql += " AND access_point_id = ?";
        hitParams.push(accessPointId);
      }
      hitSql += " GROUP BY key";
      const { results } = await this.db
        .prepare(
          `SELECT domain, SUM(count) as count FROM (${raw.sql} UNION ALL ${hitSql}) GROUP BY domain ORDER BY count DESC LIMIT 10`
        )
        .bind(...raw.params, ...hitParams)
        .all<DomainCountResult>();
      return results;
    }

    let rollupSql =
      "SELECT key as domain, SUM(count) as count FROM hourly_rollups WHERE profile_id = ? AND metric_type = 'domain' AND sub_key = ? AND hour_timestamp >= ? AND hour_timestamp < ?";
    const rollupParams: (string | number)[] = [profileId, action, plan.rollupFrom, plan.rollupTo];
    if (accessPointId) {
      rollupSql += " AND access_point_id = ?";
      rollupParams.push(accessPointId);
    }
    rollupSql += " GROUP BY key";

    const subqueries: string[] = [rollupSql];
    const allParams: (string | number)[] = [...rollupParams];

    for (const seg of [plan.head, plan.tail]) {
      if (!seg) continue;
      const rawHead = rawQuery(seg.from, seg.to, true);
      let hitHeadSql =
        "SELECT key as domain, SUM(count) as count FROM hourly_rollups WHERE profile_id = ? AND metric_type = 'hit_domain' AND sub_key = ? AND hour_timestamp >= ? AND hour_timestamp <= ?";
      const hitHeadParams: (string | number)[] = [profileId, action, Math.ceil(seg.from / 60) * 60, seg.to];
      if (accessPointId) {
        hitHeadSql += " AND access_point_id = ?";
        hitHeadParams.push(accessPointId);
      }
      hitHeadSql += " GROUP BY key";
      subqueries.push(rawHead.sql, hitHeadSql);
      allParams.push(...rawHead.params, ...hitHeadParams);
    }

    if (plan.raw) {
      const rawTail = rawQuery(plan.raw.from, plan.raw.to, true);
      subqueries.push(rawTail.sql);
      allParams.push(...rawTail.params);
    }

    if (subqueries.length === 1) {
      const { results } = await this.db
        .prepare(`${rollupSql} ORDER BY count DESC LIMIT 10`)
        .bind(...rollupParams)
        .all<DomainCountResult>();
      return results;
    }

    const { results } = await this.db
      .prepare(
        `SELECT domain, SUM(count) as count FROM (${subqueries.join(" UNION ALL ")}) GROUP BY domain ORDER BY count DESC LIMIT 10`
      )
      .bind(...allParams)
      .all<DomainCountResult>();
    return results;
  }
}
