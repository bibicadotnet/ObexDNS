import { D1Database } from "@cloudflare/workers-types";
import { LogAggregationModel, planRollupQuery, planHitRange } from "../aggregation";
import { ClientCountResult } from "./types";

/**
 * Handles client device and IP-level analytics.
 * Ranges of 24h or more use `hourly_rollups` (cache hits included, whole hours); shorter ranges
 * read the raw logs with exact boundaries.
 */
export class LogClientAnalytics {
  constructor(
    private readonly db: D1Database,
    private readonly aggregation?: LogAggregationModel
  ) {}

  /**
   * Retrieves top client IPs and locations for a given time range.
   *
   * @param profileId - Profile identifier.
   * @param since - Start timestamp in seconds.
   * @param until - End timestamp in seconds.
   * @param accessPointId - Optional device/access point ID.
   * @returns Array of top client records ordered by query count descending.
   */
  async getClients(
    profileId: string,
    since: number,
    until: number,
    accessPointId?: string
  ): Promise<ClientCountResult[]> {
    const rawWhere = (from: number, to: number) => {
      let where =
        "profile_id = ? AND timestamp >= ? AND timestamp <= ? AND client_ip IS NOT NULL AND client_ip != '' AND client_ip != '[Encrypted]'";
      const params: (string | number)[] = [profileId, from, to];
      if (accessPointId) {
        where += " AND access_point_id = ?";
        params.push(accessPointId);
      }
      return { where, params };
    };

    const plan = this.aggregation
      ? planRollupQuery(since, until, await this.aggregation.getLatestClientRollupHour(profileId))
      : null;

    if (!plan) {
      const { where, params } = rawWhere(since, until);
      const hits = this.aggregation ? planHitRange(since, until) : null;
      if (hits) {
        // Short range: exact log rows + minute buckets of cache hits.
        let hitWhere =
          "profile_id = ? AND metric_type = 'hit_client' AND hour_timestamp >= ? AND hour_timestamp <= ?";
        const hitParams: (string | number)[] = [profileId, hits.from, hits.to];
        if (accessPointId) {
          hitWhere += " AND access_point_id = ?";
          hitParams.push(accessPointId);
        }
        const { results } = await this.db
          .prepare(
            `SELECT client_ip, NULLIF(geo_country, '') as geo_country, SUM(count) as count FROM (
              SELECT client_ip, COALESCE(geo_country, '') as geo_country, COUNT(*) as count
              FROM logs WHERE ${where} GROUP BY client_ip, COALESCE(geo_country, '')
              UNION ALL
              SELECT key as client_ip, sub_key as geo_country, SUM(count) as count
              FROM hourly_rollups WHERE ${hitWhere} GROUP BY key, sub_key
            ) GROUP BY client_ip, geo_country ORDER BY count DESC LIMIT 20`
          )
          .bind(...params, ...hitParams)
          .all<ClientCountResult>();
        return results;
      }
      const { results } = await this.db
        .prepare(
          `SELECT client_ip, geo_country, COUNT(*) as count FROM logs WHERE ${where} GROUP BY client_ip, geo_country ORDER BY count DESC LIMIT 20`
        )
        .bind(...params)
        .all<ClientCountResult>();
      return results;
    }

    let rollupWhere =
      "profile_id = ? AND metric_type = 'client' AND hour_timestamp >= ? AND hour_timestamp < ?";
    const rollupParams: (string | number)[] = [profileId, plan.rollupFrom, plan.rollupTo];
    if (accessPointId) {
      rollupWhere += " AND access_point_id = ?";
      rollupParams.push(accessPointId);
    }

    const subqueries: string[] = [
      `SELECT key as client_ip, sub_key as geo_country, count FROM hourly_rollups WHERE ${rollupWhere}`
    ];
    const allParams: (string | number)[] = [...rollupParams];

    for (const seg of [plan.head, plan.tail]) {
      if (!seg) continue;
      const rawHead = rawWhere(seg.from, seg.to);
      const rawHeadSql = `SELECT client_ip, COALESCE(geo_country, '') as geo_country, COUNT(*) as count FROM logs WHERE ${rawHead.where} GROUP BY client_ip, COALESCE(geo_country, '')`;
      let hitHeadWhere =
        "profile_id = ? AND metric_type = 'hit_client' AND hour_timestamp >= ? AND hour_timestamp <= ?";
      const hitHeadParams: (string | number)[] = [profileId, Math.ceil(seg.from / 60) * 60, seg.to];
      if (accessPointId) {
        hitHeadWhere += " AND access_point_id = ?";
        hitHeadParams.push(accessPointId);
      }
      const hitHeadSql = `SELECT key as client_ip, sub_key as geo_country, SUM(count) as count FROM hourly_rollups WHERE ${hitHeadWhere} GROUP BY key, sub_key`;
      subqueries.push(rawHeadSql, hitHeadSql);
      allParams.push(...rawHead.params, ...hitHeadParams);
    }

    if (plan.raw) {
      const raw = rawWhere(plan.raw.from, plan.raw.to);
      subqueries.push(
        `SELECT client_ip, COALESCE(geo_country, '') as geo_country, COUNT(*) as count FROM logs WHERE ${raw.where} GROUP BY client_ip, COALESCE(geo_country, '')`
      );
      allParams.push(...raw.params);
    }

    if (subqueries.length === 1) {
      const { results } = await this.db
        .prepare(
          `SELECT key as client_ip, NULLIF(sub_key, '') as geo_country, SUM(count) as count
           FROM hourly_rollups WHERE ${rollupWhere}
           GROUP BY key, sub_key ORDER BY count DESC LIMIT 20`
        )
        .bind(...rollupParams)
        .all<ClientCountResult>();
      return results;
    }

    const { results } = await this.db
      .prepare(
        `SELECT client_ip, NULLIF(geo_country, '') as geo_country, SUM(count) as count FROM (
          ${subqueries.join(" UNION ALL ")}
        ) GROUP BY client_ip, geo_country ORDER BY count DESC LIMIT 20`
      )
      .bind(...allParams)
      .all<ClientCountResult>();
    return results;
  }
}
