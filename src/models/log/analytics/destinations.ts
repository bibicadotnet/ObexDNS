import { D1Database } from "@cloudflare/workers-types";
import { LogAggregationModel, planRollupQuery, planHitRange } from "../aggregation";
import { DestinationCountResult, ISPCountResult } from "./types";

/**
 * Handles geographic destination country and ISP distribution analytics.
 * Ranges of 24h or more use `hourly_rollups` (cache hits included, whole hours); shorter ranges
 * read the raw logs with exact boundaries.
 */
export class LogDestinationAnalytics {
  constructor(
    private readonly db: D1Database,
    private readonly aggregation?: LogAggregationModel
  ) {}

  /**
   * Retrieves top destination countries for a given time range.
   *
   * @param profileId - Profile identifier.
   * @param since - Start timestamp in seconds.
   * @param until - End timestamp in seconds.
   * @param accessPointId - Optional device/access point ID.
   * @param limit - Maximum number of destinations to return (default 250).
   * @returns Array of destination country records ordered by query count descending.
   */
  async getDestinations(
    profileId: string,
    since: number,
    until: number,
    accessPointId?: string,
    limit = 250
  ): Promise<DestinationCountResult[]> {
    const destCodeExpr = `UPPER(CASE 
            WHEN dest_country_code IS NOT NULL AND dest_country_code != '' THEN dest_country_code
            WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.country_code')
            ELSE ''
          END)`;
    const destNameExpr = `MAX(CASE 
            WHEN dest_country IS NOT NULL AND dest_country != '' THEN dest_country
            WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.country')
            ELSE 'Unknown'
          END)`;

    const rawParts = (from: number, to: number) => {
      let where = `profile_id = ? AND timestamp >= ? AND timestamp <= ?
          AND (
            (dest_country_code IS NOT NULL AND dest_country_code != '')
            OR
            (dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' AND json_extract(dest_geoip, '$.country_code') IS NOT NULL AND json_extract(dest_geoip, '$.country_code') != '')
          )`;
      const params: (string | number)[] = [profileId, from, to];
      if (accessPointId) {
        where += " AND access_point_id = ?";
        params.push(accessPointId);
      }
      const select = `SELECT ${destCodeExpr} as country_code, ${destNameExpr} as country, COUNT(*) as count FROM logs WHERE ${where} GROUP BY country_code`;
      return { select, params };
    };

    const plan = this.aggregation
      ? planRollupQuery(since, until, await this.aggregation.getLatestDestinationRollupHour(profileId))
      : null;

    if (!plan) {
      const raw = rawParts(since, until);
      const hits = this.aggregation ? planHitRange(since, until) : null;
      if (hits) {
        // Short range: exact log rows + minute buckets of cache hits.
        let hitWhere =
          "profile_id = ? AND metric_type = 'hit_dest' AND hour_timestamp >= ? AND hour_timestamp <= ?";
        const hitParams: (string | number)[] = [profileId, hits.from, hits.to];
        if (accessPointId) {
          hitWhere += " AND access_point_id = ?";
          hitParams.push(accessPointId);
        }
        const { results } = await this.db
          .prepare(
            `SELECT country_code, MAX(country) as country, SUM(count) as count FROM (
              ${raw.select}
              UNION ALL
              SELECT key as country_code, sub_key as country, SUM(count) as count
              FROM hourly_rollups WHERE ${hitWhere} GROUP BY key, sub_key
            ) WHERE country_code IS NOT NULL AND country_code != '' GROUP BY country_code ORDER BY count DESC LIMIT ${limit}`
          )
          .bind(...raw.params, ...hitParams)
          .all<DestinationCountResult>();
        return results;
      }
      const { results } = await this.db
        .prepare(`${raw.select} ORDER BY count DESC LIMIT ${limit}`)
        .bind(...raw.params)
        .all<DestinationCountResult>();
      return results;
    }

    let rollupWhere =
      "profile_id = ? AND metric_type = 'dest' AND hour_timestamp >= ? AND hour_timestamp < ?";
    const rollupParams: (string | number)[] = [profileId, plan.rollupFrom, plan.rollupTo];
    if (accessPointId) {
      rollupWhere += " AND access_point_id = ?";
      rollupParams.push(accessPointId);
    }

    const subqueries: string[] = [
      `SELECT key as country_code, sub_key as country, count FROM hourly_rollups WHERE ${rollupWhere}`
    ];
    const allParams: (string | number)[] = [...rollupParams];

    for (const seg of [plan.head, plan.tail]) {
      if (!seg) continue;
      const rawHead = rawParts(seg.from, seg.to);
      let hitHeadWhere =
        "profile_id = ? AND metric_type = 'hit_dest' AND hour_timestamp >= ? AND hour_timestamp <= ?";
      const hitHeadParams: (string | number)[] = [profileId, Math.ceil(seg.from / 60) * 60, seg.to];
      if (accessPointId) {
        hitHeadWhere += " AND access_point_id = ?";
        hitHeadParams.push(accessPointId);
      }
      const hitHeadSql = `SELECT key as country_code, sub_key as country, SUM(count) as count FROM hourly_rollups WHERE ${hitHeadWhere} GROUP BY key, sub_key`;
      subqueries.push(rawHead.select, hitHeadSql);
      allParams.push(...rawHead.params, ...hitHeadParams);
    }

    if (plan.raw) {
      const rawTail = rawParts(plan.raw.from, plan.raw.to);
      subqueries.push(rawTail.select);
      allParams.push(...rawTail.params);
    }

    if (subqueries.length === 1) {
      const { results } = await this.db
        .prepare(
          `SELECT key as country_code, MAX(sub_key) as country, SUM(count) as count
           FROM hourly_rollups WHERE ${rollupWhere}
           GROUP BY key ORDER BY count DESC LIMIT ${limit}`
        )
        .bind(...rollupParams)
        .all<DestinationCountResult>();
      return results;
    }

    const { results } = await this.db
      .prepare(
        `SELECT country_code, MAX(country) as country, SUM(count) as count FROM (
          ${subqueries.join(" UNION ALL ")}
        ) WHERE country_code != '' GROUP BY country_code ORDER BY count DESC LIMIT ${limit}`
      )
      .bind(...allParams)
      .all<DestinationCountResult>();
    return results;
  }

  /**
   * Retrieves ISP distribution for queries matching an optional country code.
   *
   * @param profileId - Profile identifier.
   * @param countryCode - Optional ISO 2-letter country code.
   * @param since - Start timestamp in seconds.
   * @param until - End timestamp in seconds.
   * @param accessPointId - Optional device filter.
   * @param limit - Maximum number of ISPs to return (default 250).
   * @returns Array of ISP count records.
   */
  async getISPByCountry(
    profileId: string,
    countryCode: string | undefined,
    since: number,
    until: number,
    accessPointId?: string,
    limit = 250
  ): Promise<ISPCountResult[]> {
    let queryStr = `
      SELECT 
        CASE 
          WHEN dest_isp IS NOT NULL AND dest_isp != '' THEN dest_isp
          WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.isp')
          ELSE NULL 
        END as name, 
        COUNT(*) as count 
      FROM logs 
      WHERE profile_id = ? 
        AND timestamp >= ? 
        AND timestamp <= ? 
        AND (
          (dest_isp IS NOT NULL AND dest_isp != '')
          OR
          (dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' AND json_extract(dest_geoip, '$.isp') IS NOT NULL AND json_extract(dest_geoip, '$.isp') != '')
        )
    `;
    const params: (string | number)[] = [profileId, since, until];
    if (countryCode) {
      queryStr += ` AND UPPER(CASE 
        WHEN dest_country_code IS NOT NULL AND dest_country_code != '' THEN dest_country_code
        WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.country_code')
        ELSE ''
      END) = ?`;
      params.push(countryCode.toUpperCase());
    }
    if (accessPointId) {
      queryStr += " AND access_point_id = ?";
      params.push(accessPointId);
    }
    queryStr += ` GROUP BY name ORDER BY count DESC LIMIT ${limit}`;
    const { results } = await this.db
      .prepare(queryStr)
      .bind(...params)
      .all<{ name: string | null; count: number }>();

    return results.map((r) => ({
      name: r.name || "Unknown",
      count: r.count
    }));
  }
}
