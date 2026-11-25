import { Env, User, Profile, ProfileSettings, ExecutionContext } from "../../types";
import { ProfileModel } from "../../models/profile";
import { ListModel } from "../../models/list";
import { LogModel } from "../../models/log";
import { generateId } from "../../lib/auth";
import { isSafeUrl, isSafeUrlWithDnsCheck } from "../../utils/validator";
import { buildDNSQuery, parseDNSAnswer } from "../../utils/dns";
import { resolveClientGeoCountry } from "../../utils/geoip";
import { pipeline } from "../../pipeline";
import { PROFILE_NAME_REGEX } from "../../utils/validator";
import { getDefaultUpstreamUrl, getDefaultProfileFilterUrls } from "../../constants/presets";
import { syncAllListsForProfile } from "../../utils/sync";
import { validateEcsSettings } from "../../utils/ecsSubnet";
import { probeUpstream } from "../../pipeline/resolver/probe";
import { AccessPointModel } from "../../models/accessPoint";
import { profileKeyMemoryMap } from "../../pipeline/cache";
import { cacheUtils } from "../../utils/cache";
import { isServerfullEnv } from "../../utils/serverfullEnv";
import { envNumber } from "../../utils/envNumber";

/**
 * Helper to clamp profile settings to effective user role limits before returning to client.
 */
export function clampProfileSettingsForUser(profile: Profile, user: User | null, env: Env): Profile {
  const globalMax = envNumber(env.MAX_LOG_RETENTION_DAYS, 30);
  const normalUserMax = envNumber(env.NORMAL_USER_MAX_LOG_RETENTION_DAYS, Math.min(7, globalMax), { max: globalMax });
  const adminMax = envNumber(env.ADMIN_USER_MAX_LOG_RETENTION_DAYS, globalMax, { max: globalMax });
  const roleCap = user?.role === 'admin' ? adminMax : normalUserMax;

  try {
    const isString = typeof profile.settings === 'string';
    const settings = isString ? JSON.parse(profile.settings || '{}') : JSON.parse(JSON.stringify(profile.settings || {}));
    if (settings.log_retention_days != null) {
      const parsed = Number(settings.log_retention_days);
      if (Number.isFinite(parsed) && parsed > roleCap) {
        settings.log_retention_days = roleCap;
        return {
          ...profile,
          settings: isString ? JSON.stringify(settings) : settings
        };
      }
    }
  } catch {}
  return profile;
}

/**
 * Handle requests to /api/profiles (without specific profile ID)
 */
export async function handleProfilesCoreCollectionRequest(
  request: Request,
  env: Env,
  user: User,
  pathParts: string[],
  ctx?: ExecutionContext
): Promise<Response> {
  const profileModel = new ProfileModel(env.DB, env);

  // GET /api/profiles
  if (request.method === 'GET') {
    const results = await profileModel.listByOwner(user.id);
    const clamped = results.map(p => clampProfileSettingsForUser(p, user, env));
    
    // Determine which profile is default
    let defaultProfileId: string | null = null;
    for (const p of clamped) {
      try {
        const s = typeof p.settings === 'string' ? JSON.parse(p.settings || '{}') : p.settings;
        if (s?.is_default === true) {
          defaultProfileId = p.id;
          break;
        }
      } catch {}
    }
    // If no profile explicitly marked as default, the earliest created profile (oldest) is the default
    if (!defaultProfileId && clamped.length > 0) {
      const sortedByCreated = [...clamped].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
      defaultProfileId = sortedByCreated[0].id;
    }

    const enriched = clamped.map(p => ({
      ...p,
      is_default: p.id === defaultProfileId
    }));
    return new Response(JSON.stringify(enriched), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });
  }

  // POST /api/profiles
  if (request.method === 'POST') {
    const body = await request.json() as { name?: unknown; is_default?: boolean; apply_default_filters?: boolean };
    const trimmedName = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    
    if (!trimmedName || !PROFILE_NAME_REGEX.test(trimmedName)) {
      return new Response("Invalid Profile Name format", { status: 400 });
    }

    const existingProfiles = await profileModel.listByOwner(user.id);
    const maxProfiles = Number(env.MAX_PROFILES_PER_USER) || 10;
    if (existingProfiles.length >= maxProfiles) return new Response(`Profile limit exceeded (max ${maxProfiles})`, { status: 400 });

    const existing = existingProfiles.find(p => p.name === trimmedName);
    if (existing) return new Response("The profile name already exists", { status: 400 });

    const newId = generateId(6);
    const globalMaxRetention = env.MAX_LOG_RETENTION_DAYS !== undefined && env.MAX_LOG_RETENTION_DAYS !== ''
      ? Number(env.MAX_LOG_RETENTION_DAYS)
      : 30;
    const adminDefaultRetention = env.DEFAULT_LOG_RETENTION_DAYS !== undefined && env.DEFAULT_LOG_RETENTION_DAYS !== ''
      ? Math.min(Number(env.DEFAULT_LOG_RETENTION_DAYS), globalMaxRetention)
      : Math.min(7, globalMaxRetention);
    const normalUserMaxRetention = env.NORMAL_USER_MAX_LOG_RETENTION_DAYS !== undefined && env.NORMAL_USER_MAX_LOG_RETENTION_DAYS !== ''
      ? Math.min(Number(env.NORMAL_USER_MAX_LOG_RETENTION_DAYS), globalMaxRetention)
      : Math.min(7, globalMaxRetention);
    const normalUserDefaultRetention = env.NORMAL_USER_DEFAULT_LOG_RETENTION_DAYS !== undefined && env.NORMAL_USER_DEFAULT_LOG_RETENTION_DAYS !== ''
      ? Math.min(Number(env.NORMAL_USER_DEFAULT_LOG_RETENTION_DAYS), normalUserMaxRetention)
      : Math.min(1, normalUserMaxRetention);

    const defaultRetentionDays = user?.role === 'admin' ? adminDefaultRetention : normalUserDefaultRetention;
    const defaultUpstream = getDefaultUpstreamUrl(env);

    // If user specified is_default: true, clear is_default from existing profiles
    if (body.is_default === true && existingProfiles.length > 0) {
      for (const p of existingProfiles) {
        let s: ProfileSettings = typeof p.settings === 'string' ? JSON.parse(p.settings || '{}') : JSON.parse(JSON.stringify(p.settings || {}));
        if (s.is_default) {
          s.is_default = false;
          await profileModel.updateSettings(p.id, s);
          ctx?.waitUntil(pipeline.clearCache(p.id, true, env));
        }
      }
    } else {
      // If existing profiles exist but none is marked default, mark the earliest existing profile as default
      const hasDefaultProfile = existingProfiles.some(p => {
        try {
          const s = typeof p.settings === 'string' ? JSON.parse(p.settings || '{}') : p.settings;
          return s?.is_default === true;
        } catch { return false; }
      });
      if (existingProfiles.length > 0 && !hasDefaultProfile) {
        const sorted = [...existingProfiles].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
        const earliest = sorted[0];
        try {
          let s = typeof earliest.settings === 'string' ? JSON.parse(earliest.settings || '{}') : JSON.parse(JSON.stringify(earliest.settings || {}));
          s.is_default = true;
          await profileModel.updateSettings(earliest.id, s);
        } catch {}
      }
    }

    const isDefaultSetting = existingProfiles.length === 0 ? true : Boolean(body.is_default);

    const defaultSettings: ProfileSettings = {
      upstream: [defaultUpstream],
      ecs: { enabled: true, use_client_ip: true },
      log_retention_days: defaultRetentionDays,
      skip_log_on_pass: false,
      default_policy: 'ALLOW',
      best_effort_ech: { enabled: false },
      is_default: isDefaultSetting
    };
    await profileModel.create({ id: newId, owner_id: user.id, name: trimmedName || "Unnamed Profile", settings: defaultSettings });

    // Automatically inherit active account-level E2EE keys if configured
    try {
      const existingLogKey = await env.DB.prepare(
        "SELECT public_key, is_active FROM user_log_keys WHERE profile_id IN (SELECT id FROM profiles WHERE owner_id = ?) LIMIT 1"
      )
        .bind(user.id)
        .first<{ public_key: string; is_active?: number }>();

      if (existingLogKey?.public_key) {
        const now = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
          "INSERT INTO user_log_keys (profile_id, public_key, created_at, is_active) VALUES (?, ?, ?, ?)"
        )
          .bind(newId, existingLogKey.public_key, now, existingLogKey.is_active ?? 1)
          .run();

        const existingRecKey = await env.DB.prepare(
          "SELECT encrypted_sk, iv, salt FROM user_recovery_wrapped_keys WHERE profile_id IN (SELECT id FROM profiles WHERE owner_id = ?) LIMIT 1"
        )
          .bind(user.id)
          .first<{ encrypted_sk: string; iv: string; salt: string }>();

        if (existingRecKey) {
          await env.DB.prepare(
            "INSERT INTO user_recovery_wrapped_keys (profile_id, encrypted_sk, iv, salt, created_at) VALUES (?, ?, ?, ?, ?)"
          )
            .bind(newId, existingRecKey.encrypted_sk, existingRecKey.iv, existingRecKey.salt, now)
            .run();
        }
      }
    } catch (e) {
      console.error("[Profiles] Failed to inherit E2EE log key for new profile:", e);
    }

    // Attach default filter lists to the profile if configured
    const applyDefaultFilters = body.apply_default_filters !== false;
    let listsAttached = false;
    if (applyDefaultFilters) {
      try {
        const defaultFilterUrls = getDefaultProfileFilterUrls(env);
        if (defaultFilterUrls.length > 0) {
          const listModel = new ListModel(env.DB);
          await listModel.addListsBulk(newId, defaultFilterUrls);
          listsAttached = true;
        }
      } catch (listErr) {
        console.warn(`[Profiles] Failed to attach default filter lists to profile ${newId}:`, listErr);
      }
    }

    if (listsAttached && ctx) {
      ctx.waitUntil(
        syncAllListsForProfile(newId, env, ctx).catch((err) => {
          console.error(`[Profiles] Background sync failed for profile ${newId}:`, err);
        })
      );
    }

    return new Response(JSON.stringify({ id: newId }), { status: 201 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

/**
 * Handle core requests to /api/profiles/:id
 */
export async function handleProfilesCoreRequest(
  request: Request,
  env: Env,
  user: User | null,
  profile: Profile,
  pathParts: string[],
  ctx: ExecutionContext
): Promise<Response> {
  const profileModel = new ProfileModel(env.DB, env);
  const logModel = new LogModel(env.DB, env);
  const profileId = profile.id;

  // Handles:
  // - DELETE /api/profiles/:id
  // - PATCH /api/profiles/:id (updateName)
  // - GET /api/profiles/:id
  if (pathParts.length === 3) {
    if (request.method === 'DELETE') {
      const url = new URL(request.url);
      const newDefaultId = url.searchParams.get('new_default_id');

      let wasDefault = false;
      try {
        const s = typeof profile.settings === 'string' ? JSON.parse(profile.settings || '{}') : profile.settings;
        wasDefault = s?.is_default === true;
      } catch {}

      const isServerfull = isServerfullEnv(env);
      const cache = !isServerfull && typeof caches !== "undefined" && caches ? (caches as any).default : null;
      if (profile.profile_key) {
        profileKeyMemoryMap.delete(profile.profile_key);
        if (cache) {
          ctx.waitUntil(cacheUtils.delete(cache, `doh_key_v1:${profile.profile_key}`));
        }
      }
      try {
        const apModel = new AccessPointModel(env.DB);
        const aps = await apModel.getAccessPoints(profileId);
        for (const ap of aps) {
          if (ap.token) {
            profileKeyMemoryMap.delete(ap.token);
            if (cache) {
              ctx.waitUntil(cacheUtils.delete(cache, `doh_key_v1:${ap.token}`));
            }
          }
        }
      } catch {}
      await profileModel.delete(profileId);
      ctx.waitUntil(pipeline.clearCache(profileId, true, env));

      // Handle reassigning default profile if deleted profile was default or newDefaultId is specified
      if (user) {
        if (newDefaultId) {
          const target = await profileModel.getById(newDefaultId);
          if (target && target.owner_id === user.id) {
            let s: ProfileSettings = typeof target.settings === 'string' ? JSON.parse(target.settings || '{}') : JSON.parse(JSON.stringify(target.settings || {}));
            s.is_default = true;
            await profileModel.updateSettings(target.id, s);
            ctx.waitUntil(pipeline.clearCache(target.id, true, env));
          }
        } else if (wasDefault) {
          const remaining = await profileModel.listByOwner(user.id);
          if (remaining.length > 0) {
            const sorted = [...remaining].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
            const nextDefault = sorted[0];
            let s: ProfileSettings = typeof nextDefault.settings === 'string' ? JSON.parse(nextDefault.settings || '{}') : JSON.parse(JSON.stringify(nextDefault.settings || {}));
            s.is_default = true;
            await profileModel.updateSettings(nextDefault.id, s);
            ctx.waitUntil(pipeline.clearCache(nextDefault.id, true, env));
          }
        }
      }

      return new Response(null, { status: 204 });
    }

    if (request.method === 'PATCH') {
      const body = await request.json() as { name?: unknown; is_default?: boolean };
      if (body.name !== undefined) {
        const trimmedName = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
        if (!trimmedName || !PROFILE_NAME_REGEX.test(trimmedName)) return new Response("Invalid Profile Name format", { status: 400 });
        await profileModel.updateName(profileId, trimmedName);
      }
      if (body.is_default !== undefined && user) {
        const allProfiles = await profileModel.listByOwner(user.id);
        for (const p of allProfiles) {
          let s: ProfileSettings = typeof p.settings === "string" ? JSON.parse(p.settings || "{}") : JSON.parse(JSON.stringify(p.settings || {}));
          const shouldBeDefault = (p.id === profileId && body.is_default === true);
          if (s.is_default !== shouldBeDefault) {
            s.is_default = shouldBeDefault;
            await profileModel.updateSettings(p.id, s);
            ctx.waitUntil(pipeline.clearCache(p.id, true, env));
          }
        }
      }
      ctx.waitUntil(pipeline.clearCache(profileId, true, env));
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'GET') {
      const clamped = clampProfileSettingsForUser(profile, user, env);
      let isDefault = false;
      try {
        const s = typeof clamped.settings === 'string' ? JSON.parse(clamped.settings || '{}') : clamped.settings;
        isDefault = s?.is_default === true;
      } catch {}
      if (!isDefault && user) {
        const all = await profileModel.listByOwner(user.id);
        if (all.length === 1 && all[0].id === profileId) {
          isDefault = true;
        } else if (all.length > 0) {
          const hasAnyDefault = all.some(p => {
            try {
              const s = typeof p.settings === 'string' ? JSON.parse(p.settings || '{}') : p.settings;
              return s?.is_default === true;
            } catch { return false; }
          });
          if (!hasAnyDefault) {
            const sorted = [...all].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
            if (sorted[0].id === profileId) {
              isDefault = true;
            }
          }
        }
      }
      return new Response(JSON.stringify({ ...clamped, is_default: isDefault }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  // POST /api/profiles/:id/rotate_key
  if (pathParts[3] === 'rotate_key' && request.method === 'POST') {
    const oldKey = profile.profile_key;
    const newKey = generateId(12);
    await profileModel.rotateKey(profileId, newKey);
    if (oldKey) {
      profileKeyMemoryMap.delete(oldKey);
      const isServerfull = isServerfullEnv(env);
      const cache = !isServerfull && typeof caches !== "undefined" && caches ? (caches as any).default : null;
      if (cache) {
        ctx.waitUntil(cacheUtils.delete(cache, `doh_key_v1:${oldKey}`));
      }
    }
    ctx.waitUntil(pipeline.clearCache(profileId, false, env));
    return new Response(JSON.stringify({ profile_key: newKey }), { headers: { 'Content-Type': 'application/json' } });
  }

  // PATCH /api/profiles/:id/settings
  if (pathParts[3] === 'settings' && request.method === 'PATCH') {
    const newSettings = await request.json() as ProfileSettings;
    
    // Enforce log retention limit
    const globalMaxRetention = envNumber(env.MAX_LOG_RETENTION_DAYS, 30);
    const adminMaxRetention = envNumber(env.ADMIN_USER_MAX_LOG_RETENTION_DAYS, globalMaxRetention, { max: globalMaxRetention });
    const normalUserMax = envNumber(env.NORMAL_USER_MAX_LOG_RETENTION_DAYS, Math.min(7, globalMaxRetention), { max: globalMaxRetention });
    const userMaxRetention = user?.role === 'admin' ? adminMaxRetention : normalUserMax;

    if (newSettings.log_retention_days != null) {
      const parsedDays = Number(newSettings.log_retention_days);
      newSettings.log_retention_days = Number.isFinite(parsedDays)
        ? Math.max(0, Math.min(parsedDays, userMaxRetention))
        : 0;
    }
    
    // Load the stored settings first: upstream is only re-probed when it actually changed.
    const oldProfile = await profileModel.getById(profileId);
    let oldSettingsParsed: Partial<ProfileSettings> = {};
    try {
      oldSettingsParsed = JSON.parse(oldProfile?.settings || "{}");
    } catch {}

    if (newSettings.upstream !== undefined) {
      if (!Array.isArray(newSettings.upstream) || newSettings.upstream.length === 0) {
        return new Response("Upstream is required.", { status: 400 });
      }
      const cleaned: string[] = [];
      for (const entry of newSettings.upstream) {
        const trimmed = typeof entry === 'string' ? entry.trim() : '';
        if (!trimmed || trimmed.length > 2048) {
          return new Response("Upstream cannot be empty.", { status: 400 });
        }
        cleaned.push(trimmed);
      }
      newSettings.upstream = cleaned;
    }

    if (newSettings.upstream && Array.isArray(newSettings.upstream)) {
      for (const url of newSettings.upstream) {
        // 允许三种格式：https://...、http://...、tcp://...、裸 IP（8.8.8.8）或 IP:port（8.8.8.8:5353）
        // resolver.ts 中裸 IP 已被视为经典 TCP DNS，API 验证层对齐此行为。
        const isHttps = url.startsWith('https://');
        const isHttp  = url.startsWith('http://');
        const isTcp   = url.startsWith('tcp://');
        const isTls   = url.startsWith('tls://');
        const isDot   = url.startsWith('dot://');
        const isUdp   = url.startsWith('udp://');
        const isSdns  = url.startsWith('sdns://');
        // 裸 host[:port]：不含 / 且不含 scheme
        const isBareHost = !url.includes('//') && !url.startsWith('/');

        if (!isHttps && !isHttp && !isTcp && !isTls && !isDot && !isUdp && !isSdns && !isBareHost) {
          return new Response("Invalid upstream URL format. Only HTTP(S), TCP, TLS (DoT), DNS Stamp (sdns://), or bare host[:port] are allowed.", { status: 400 });
        }
        // 统一规范化后做安全检查（防 SSRF，包含 DNS 解析校验）
        const normalized = isBareHost ? `tcp://${url}` : url;
        if (!(await isSafeUrlWithDnsCheck(normalized))) {
          return new Response("Invalid upstream URL. Private networks and localhosts are not allowed.", { status: 400 });
        }
      }
    }

    // Verify that a *changed* upstream really resolves before saving it. Saving an upstream that
    // only looks valid (e.g. a DoH host without "/dns-query" -> HTTP 403) would break every query
    // of the profile immediately. Unchanged upstreams are not re-probed so unrelated settings
    // (log retention, policy ...) can still be saved while the upstream is temporarily down.
    if (newSettings.upstream && newSettings.upstream.length > 0) {
      const previousUpstream = Array.isArray(oldSettingsParsed.upstream) ? oldSettingsParsed.upstream[0] : undefined;
      const nextUpstream = newSettings.upstream[0];
      if (nextUpstream !== previousUpstream) {
        const probe = await probeUpstream(nextUpstream);
        if (!probe.ok) {
          return new Response(`Upstream verification failed: ${probe.error}`, { status: 400 });
        }
      }
    }

    // EDNS Client Subnet: reject malformed / empty custom subnets, append default prefix to bare IPs.
    if (newSettings.ecs !== undefined) {
      const ecsResult = validateEcsSettings(newSettings.ecs as any);
      if (!ecsResult.ok) {
        return new Response(ecsResult.error, { status: 400 });
      }
      newSettings.ecs = ecsResult.value;
    }

    // Best-effort ECH: the outer SNI (fronting domain) is server-managed. Only the on/off flag is user-controlled.
    if (newSettings.best_effort_ech !== undefined) {
      const rawEch: unknown = newSettings.best_effort_ech;
      const echEnabled = typeof rawEch === 'boolean' ? rawEch : Boolean((rawEch as { enabled?: unknown } | null)?.enabled);
      newSettings.best_effort_ech = { enabled: echEnabled };
    }

    // 检查旧配置中的 log_retention_days
    let oldDays = 30;
    if (oldSettingsParsed?.log_retention_days != null) {
      oldDays = Number(oldSettingsParsed.log_retention_days);
    }

    await profileModel.updateSettings(profileId, newSettings);

    // 仅在显式缩短日志留存期时触发主动清理，避免每次保存设置无谓执行 DELETE
    const newDays = newSettings.log_retention_days;
    if (newDays != null && Number(newDays) < oldDays) {
      if (Number(newDays) === 0) {
        // 关闭日志时彻底清空当前配置的历史日志 (thực hiện theo chunk có pacing để không nghẽn DNS)
        ctx.waitUntil((async () => {
          try {
            await logModel.deleteByProfile(profileId);
            await logModel.kemKeys.cleanupProfileOrphans(profileId);
          } catch (e: any) {
            console.error("[Profile] Failed to purge logs on retention disable:", e?.message || e);
          }
        })());
      } else {
        const threshold = Math.floor(Date.now() / 1000 - (Number(newDays) * 24 * 3600));
        ctx.waitUntil(logModel.deleteLogsChunked(profileId, threshold));
      }
    }

    // 设置变更仅清除配置缓存，保留 2.5MB 布隆过滤器缓存
    ctx.waitUntil(pipeline.clearCache(profileId, false, env));
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  // POST /api/profiles/:id/probe_upstream
  if (pathParts[3] === 'probe_upstream' && request.method === 'POST') {
    const body = await request.json() as { upstream?: string };
    const upstream = typeof body?.upstream === 'string' ? body.upstream.trim() : '';
    if (!upstream) {
      return new Response("Upstream is required.", { status: 400 });
    }
    const isHttps = upstream.startsWith('https://');
    const isHttp  = upstream.startsWith('http://');
    const isTcp   = upstream.startsWith('tcp://');
    const isTls   = upstream.startsWith('tls://');
    const isDot   = upstream.startsWith('dot://');
    const isUdp   = upstream.startsWith('udp://');
    const isSdns  = upstream.startsWith('sdns://');
    const isBareHost = !upstream.includes('//') && !upstream.startsWith('/');

    if (!isHttps && !isHttp && !isTcp && !isTls && !isDot && !isUdp && !isSdns && !isBareHost) {
      return new Response("Invalid upstream URL format. Only HTTP(S), TCP, TLS (DoT), DNS Stamp (sdns://), or bare host[:port] are allowed.", { status: 400 });
    }
    const normalized = isBareHost ? `tcp://${upstream}` : upstream;
    if (!(await isSafeUrlWithDnsCheck(normalized))) {
      return new Response("Invalid upstream URL. Private networks and localhosts are not allowed.", { status: 400 });
    }

    const probe = await probeUpstream(upstream);
    if (!probe.ok) {
      return new Response(`Upstream verification failed: ${probe.error}`, { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true, latency: probe.latency }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // POST /api/profiles/:id/test
  if (pathParts[3] === 'test' && request.method === 'POST') {
    const { domain, type } = await request.json() as { domain: string, type: string };
    const rawQuery = buildDNSQuery(domain, type);
    const result = await pipeline.process(request, { name: domain, type, raw: rawQuery }, { profileId, startTime: Date.now(), env, ctx });
    return new Response(JSON.stringify({
      action: result.action,
      reason: result.reason,
      answers: result.answer.length > 0 ? parseDNSAnswer(result.answer) : [],
      diagnostics: result.diagnostics,
      latency: result.latency,
      timings: result.timings,
      client_ip: request.headers.get("CF-Connecting-IP") || "127.0.0.1",
      geo_country: await resolveClientGeoCountry(request, request.headers.get("CF-Connecting-IP") || "127.0.0.1"),
      success: true 
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response("Not Found", { status: 404 });
}
