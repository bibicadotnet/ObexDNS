import { Env, User, Profile, ProfileSettings, ExecutionContext } from "../../types";
import { LogModel } from "../../models/log";
import { cacheUtils } from "../../utils/cache";
import { handleProfileLogsWs } from "./logsWs";
import { scheduleSpaceReclaim } from "../../utils/dbMaintenance";
import { isServerfullEnv } from "../../utils/serverfullEnv";
import { pipelineCache } from "../../pipeline/cache";
import { alignRangeToMinutes, describeAnalyticsWindow } from "../../models/log/aggregation";
import { analyticsCachePolicy } from "../../utils/analyticsCache";
import { effectiveLogRetentionDays, resolveCustomRange, retentionThreshold, roleRetentionCap } from "../../utils/logRange";
import { envNumber } from "../../utils/envNumber";

const jsonHeaders = { 'Content-Type': 'application/json' };

/** 400 for a custom range that cannot contain any log: rejected before any query runs. */
function invalidRangeResponse(error: string): Response {
  return new Response(JSON.stringify({ error }), { status: 400, headers: jsonHeaders });
}

/**
 * Retention that really applies to a profile: its own setting, capped by the owner's role limit
 * (NORMAL_USER_MAX_LOG_RETENTION_DAYS / ADMIN_USER_MAX_LOG_RETENTION_DAYS, themselves capped by
 * MAX_LOG_RETENTION_DAYS). Same rule as the settings PATCH and the cleanup job, so the range checks never
 * accept days that cleanup has already deleted. 0 = logging disabled.
 */
function profileRetentionDays(env: Env, user: User, profile: Profile): number {
  const global = envNumber(env.MAX_LOG_RETENTION_DAYS, 30);
  const cap = roleRetentionCap(user?.role, {
    global,
    normalUser: env.NORMAL_USER_MAX_LOG_RETENTION_DAYS === undefined || env.NORMAL_USER_MAX_LOG_RETENTION_DAYS === ''
      ? undefined : envNumber(env.NORMAL_USER_MAX_LOG_RETENTION_DAYS, Math.min(7, global)),
    admin: env.ADMIN_USER_MAX_LOG_RETENTION_DAYS === undefined || env.ADMIN_USER_MAX_LOG_RETENTION_DAYS === ''
      ? undefined : envNumber(env.ADMIN_USER_MAX_LOG_RETENTION_DAYS, global)
  });
  let settings: Partial<ProfileSettings>;
  try {
    settings = typeof profile.settings === 'string' ? JSON.parse(profile.settings || '{}') : (profile.settings || {});
  } catch {
    settings = {};
  }
  return effectiveLogRetentionDays(settings.log_retention_days, cap);
}

/**
 * Handle logs and analytics requests to /api/profiles/:id/logs and /api/profiles/:id/analytics
 */
export async function handleProfileLogsAndAnalyticsRequest(
  request: Request,
  env: Env,
  user: User,
  profile: Profile,
  pathParts: string[],
  ctx: ExecutionContext
): Promise<Response> {
  const logModel = new LogModel(env.DB, env);
  const profileId = profile.id;

  // Handle Logs endpoint: /api/profiles/:id/logs
  if (pathParts[3] === 'logs') {
    // Handle WebSocket real-time streaming endpoint: /api/profiles/:id/logs/ws or Upgrade: websocket
    if (pathParts[4] === 'ws' || request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return handleProfileLogsWs(request, env, user, profile, ctx);
    }

    if (request.method === 'DELETE') {
      await logModel.deleteByProfile(profileId);
      await logModel.kemKeys.cleanupProfileOrphans(profileId, 0);
      if (env.CF_ZONE_ID && env.CF_PURGE_TOKEN) {
        ctx.waitUntil(pipelineCache.purgeTags(env, [`analytics-${profileId}`]).catch(() => {}));
      }
      // Give the freed pages back to the disk in the background (never blocks DNS or this response).
      scheduleSpaceReclaim(env.DB, ctx);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.method !== 'GET') {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const urlParams = new URL(request.url).searchParams;
    const range = urlParams.get('range') || '1h';
    const before = urlParams.get('before');
    const status = urlParams.get('status');
    const search = urlParams.get('search');
    const accessPointId = urlParams.get('access_point_id');
    const destCountry = urlParams.get('dest_country');
    const isp = urlParams.get('isp');
    const domain = urlParams.get('domain') || undefined;
    const recordType = urlParams.get('record_type') || undefined;
    const geoCountry = urlParams.get('geo_country') || undefined;
    const reason = urlParams.get('reason') || undefined;
    const startParam = urlParams.get('start');
    const endParam = urlParams.get('end');
    
    let since: number;
    let until = Math.floor(Date.now() / 1000);
    const logRetentionDays = profileRetentionDays(env, user, profile);

    if (logRetentionDays === 0) {
      if (pathParts.length > 4 && pathParts[4] !== 'export') {
        return new Response("Log Not Found", { status: 404 });
      }
      return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
    }

    const retentionFloor = retentionThreshold(logRetentionDays, until);

    if (startParam && endParam) {
      const custom = resolveCustomRange(startParam, endParam, logRetentionDays, until);
      if (!custom.ok) return invalidRangeResponse(custom.error);
      since = custom.since;
      until = custom.until;
    } else {
      since = until;
      switch (range) {
        case '10m': since -= 600; break;
        case '1h': since -= 3600; break;
        case '24h': since -= 86400; break;
        case '7d': since -= 604800; break;
        case '30d': since -= 2592000; break;
        default: since -= 3600; break;
      }
      since = Math.max(since, retentionFloor);
    }

    if (pathParts.length > 4) {
      if (pathParts[4] === 'export') {
        const results = await logModel.getLogs(profileId, {
          since,
          until,
          status: status || undefined,
          search: search || undefined,
          access_point_id: accessPointId || undefined,
          dest_country: destCountry || undefined,
          isp: isp || undefined,
          domain,
          record_type: recordType,
          geo_country: geoCountry,
          reason,
          export: true
        });
        return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
      }

      const logId = parseInt(pathParts[4], 10);
      if (isNaN(logId)) {
        return new Response("Invalid Log ID", { status: 400 });
      }

      const timestampParam = urlParams.get('timestamp');
      const timestamp = timestampParam ? parseInt(timestampParam, 10) : undefined;

      const logDetail = await logModel.getLog(profileId, logId, timestamp);
      if (!logDetail) {
        return new Response("Log Not Found", { status: 404 });
      }
      return new Response(JSON.stringify(logDetail), { headers: { 'Content-Type': 'application/json' } });
    }

    let limit = parseInt(urlParams.get('limit') || '50', 10);
    if (isNaN(limit) || limit <= 0) {
      limit = 50;
    } else if (limit > 1000) {
      limit = 1000;
    }

    const results = await logModel.getLogs(profileId, {
      since,
      until,
      status: status || undefined,
      search: search || undefined,
      before: before ? parseInt(before) : undefined,
      limit,
      access_point_id: accessPointId || undefined,
      dest_country: destCountry || undefined,
      isp: isp || undefined,
      domain,
      record_type: recordType,
      geo_country: geoCountry,
      reason
    });
    return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
  }

  // Handle Analytics endpoint: /api/profiles/:id/analytics
  if (pathParts[3] === 'analytics') {
    if (request.method !== 'GET') {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const urlParams = new URL(request.url).searchParams;
    const range = urlParams.get('range');
    const startParam = urlParams.get('start');
    const endParam = urlParams.get('end');
    const accessPointId = urlParams.get('access_point_id') || undefined;
    let since: number; let until = Math.floor(Date.now() / 1000); let interval: string;
    const analyticsRetentionDays = profileRetentionDays(env, user, profile);

    if (startParam && endParam) {
      // Reversed / malformed / entirely-expired ranges are refused here, so they never reach the database;
      // a start older than the retention is moved up to the boundary (nothing older exists).
      const custom = resolveCustomRange(startParam, endParam, analyticsRetentionDays, until);
      if (!custom.ok) return invalidRangeResponse(custom.error);
      since = custom.since; until = custom.until; interval = "(timestamp/3600)*3600";
    }
    else {
      switch (range) {
        case '10m': since = until - 600; interval = "(timestamp/60)*60"; break;
        case '1h': since = until - 3600; interval = "(timestamp/60)*60"; break;
        case '24h': since = until - 86400; interval = "(timestamp/3600)*3600"; break;
        case '7d': since = until - 604800; interval = "(timestamp/86400)*86400"; break;
        case '30d': since = until - 2592000; interval = "(timestamp/86400)*86400"; break;
        default: since = until - 3600; interval = "(timestamp/60)*60"; break;
      }
    }
    if (!(startParam && endParam) && analyticsRetentionDays > 0) {
      // A relative range wider than the retention only asks for rows that no longer exist.
      since = Math.max(since, retentionThreshold(analyticsRetentionDays, until));
    }
    ({ since, until } = alignRangeToMinutes(since, until, !!(startParam && endParam)));
    // Window with no whole hour inside and no minute data left: the answer is empty by definition.
    const analyticsWindow = describeAnalyticsWindow(since, until);

    // Cache bucket/TTL grow with the size of the window (see analyticsCachePolicy).
    const cachePolicy = analyticsCachePolicy(range, since, until, !!(startParam && endParam));

    const subResource = pathParts[4];
    const isServerfull = isServerfullEnv(env);
    const cache = !isServerfull && typeof caches !== "undefined" && caches ? (caches as any).default : null;

    if (subResource) {
      const exact = urlParams.get('exact') === 'true';
      // Relative ranges ("10m", "1h", ...) slide with the clock, so the key carries a time bucket whose
      // length equals the TTL: a cached answer is never older than one bucket.
      const subCacheKey = `analytics_sub:${profileId}:${subResource}:${urlParams.toString()}:${cachePolicy.windowKey}`;
      if (!exact && cache) {
        const cached = await cacheUtils.get<any>(cache, subCacheKey);
        if (cached) {
          return new Response(JSON.stringify(cached), {
            headers: {
              'Content-Type': 'application/json',
              'X-Cache': 'HIT',
              'Cache-Control': 'private, no-cache'
            }
          });
        }
      }

      let data: any = null;
      const summaryFiltered = Boolean(
        exact || urlParams.get('search') || urlParams.get('dest_country') || urlParams.get('isp') || urlParams.get('status')
      );
      const answeredFromPlan = subResource === 'summary' ? !summaryFiltered
        : ['trend', 'top_allowed', 'top_blocked', 'clients', 'destinations'].includes(subResource);
      if (analyticsWindow.tooOld && answeredFromPlan) {
        // Nothing can be counted exactly in this window: skip the queries instead of running them to get zero rows.
        return new Response(JSON.stringify([]), {
          headers: { 'Content-Type': 'application/json', 'X-Cache': 'SKIP', 'Cache-Control': 'private, no-cache' }
        });
      }
      if (subResource === 'summary') {
        const search = urlParams.get('search') || undefined;
        const destCountry = urlParams.get('dest_country') || undefined;
        const isp = urlParams.get('isp') || undefined;
        const status = urlParams.get('status') || undefined;
        data = await logModel.getSummary(profileId, since, until, search, accessPointId, destCountry, isp, status, exact);
      } else if (subResource === 'trend') {
        data = await logModel.getTrend(profileId, since, until, interval, accessPointId);
      } else if (subResource === 'top_allowed') {
        data = await logModel.getTopAllowed(profileId, since, until, accessPointId);
      } else if (subResource === 'top_blocked') {
        data = await logModel.getTopBlocked(profileId, since, until, accessPointId);
      } else if (subResource === 'clients') {
        data = await logModel.getClients(profileId, since, until, accessPointId);
      } else if (subResource === 'destinations') {
        const limitParam = urlParams.get('limit');
        const limit = limitParam ? parseInt(limitParam, 10) : undefined;
        data = await logModel.getDestinations(profileId, since, until, accessPointId, limit !== undefined && !isNaN(limit) ? limit : undefined);
      } else if (subResource === 'isps') {
        const countryCode = urlParams.get('country_code') || undefined;
        const limitParam = urlParams.get('limit');
        const limit = limitParam ? parseInt(limitParam, 10) : undefined;
        data = await logModel.getISPByCountry(profileId, countryCode, since, until, accessPointId, limit !== undefined && !isNaN(limit) ? limit : undefined);
      } else {
        return new Response("Not Found", { status: 404 });
      }

      if (!exact && cache) {
        await cacheUtils.set(cache, subCacheKey, data, cachePolicy.bucketSec, [`analytics-${profileId}`]);
      }
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'MISS',
          'Cache-Control': exact ? 'no-cache, no-store' : 'private, no-cache'
        }
      });
    }
    
    // `since`/`until` slide with the clock for relative ranges, so key on the range label and time bucket.
    const cacheKey = `analytics:${profileId}:${cachePolicy.windowKey}:${interval}:${accessPointId || 'all'}`;
    if (cache) {
      const cached = await cacheUtils.get<any>(cache, cacheKey);
      if (cached) {
        return new Response(JSON.stringify(cached), {
          headers: {
            'Content-Type': 'application/json',
            'X-Cache': 'HIT',
            'Cache-Control': 'private, no-cache'
          }
        });
      }
    }

    const win = analyticsWindow;
    // Tell the client which window the numbers really cover, so a window that had to be aligned to whole
    // hours (or has no exact answer at all) is not shown as if it were the one that was asked for.
    const result = win.tooOld
      ? { summary: [], trend: [], top_allowed: [], top_blocked: [], clients: [], destinations: [] }
      : await logModel.getAnalytics(profileId, since, until, interval, accessPointId);
    const analytics = {
      ...result,
      aligned: win.aligned,
      too_old: win.tooOld,
      aligned_since: win.alignedSince,
      aligned_until: win.alignedUntil
    };
    if (cache) {
      await cacheUtils.set(cache, cacheKey, analytics, cachePolicy.bucketSec, [`analytics-${profileId}`]);
    }

    return new Response(JSON.stringify(analytics), {
      headers: {
        'Content-Type': 'application/json',
        'X-Cache': 'MISS',
        'Cache-Control': 'private, no-cache'
      }
    });
  }

  return new Response("Not Found", { status: 404 });
}
