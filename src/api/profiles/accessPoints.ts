import { Env, User, ExecutionContext, ProfileSettings } from "../../types";
import { AccessPointModel } from "../../models/accessPoint";
import { ProfileModel } from "../../models/profile";
import { AP_NAME_REGEX } from "../../utils/validator";
import { pipeline } from "../../pipeline";
import { profileKeyMemoryMap } from "../../pipeline/cache";
import { cacheUtils } from "../../utils/cache";
import { isServerfullEnv } from "../../utils/serverfullEnv";

/**
 * Handle access points requests to /api/profiles/:id/access_points
 */
export async function handleProfileAccessPointsRequest(
  request: Request,
  env: Env,
  user: User,
  profileId: string,
  pathParts: string[],
  ctx: ExecutionContext
): Promise<Response> {
  const apModel = new AccessPointModel(env.DB);

  if (request.method === 'GET') {
    const results = await apModel.getAccessPoints(profileId);
    const profileModel = new ProfileModel(env.DB, env);
    const p = await profileModel.getById(profileId);
    let defaultApId = "";
    try {
      const s = typeof p?.settings === "string" ? JSON.parse(p?.settings || "{}") : p?.settings;
      defaultApId = s?.default_ap_id || "";
    } catch {}
    if (!defaultApId && results.length > 0) {
      defaultApId = results[0].id;
    }
    const enriched = results.map(ap => ({
      ...ap,
      is_default: results.length === 1 || ap.id === defaultApId
    }));
    return new Response(JSON.stringify(enriched), { headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'POST') {
    if (pathParts.length === 6 && pathParts[5] === 'set_default') {
      const apId = pathParts[4];
      const aps = await apModel.getAccessPoints(profileId);
      const targetAp = aps.find((a) => a.id === apId);
      if (!targetAp) return new Response("Access Point not found", { status: 404 });

      const profileModel = new ProfileModel(env.DB, env);
      const p = await profileModel.getById(profileId);
      if (!p) return new Response("Profile not found", { status: 404 });

      let settings: ProfileSettings = typeof p.settings === "string" ? JSON.parse(p.settings || "{}") : JSON.parse(JSON.stringify(p.settings || {}));
      settings.default_ap_id = apId;
      await profileModel.updateSettings(profileId, settings);
      ctx.waitUntil(pipeline.clearCache(profileId, false, env));
      return new Response(JSON.stringify({ success: true, default_ap_id: apId }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (pathParts.length === 6 && pathParts[5] === 'rotate_token') {
      const apId = pathParts[4];
      const aps = await apModel.getAccessPoints(profileId);
      const targetAp = aps.find((a) => a.id === apId);
      const oldToken = targetAp?.token;
      const newToken = await apModel.rotateAccessPointToken(apId, profileId);
      if (oldToken) {
        profileKeyMemoryMap.delete(oldToken);
        const isServerfull = isServerfullEnv(env);
        const cache = !isServerfull && typeof caches !== "undefined" && caches ? (caches as any).default : null;
        if (cache) {
          ctx.waitUntil(cacheUtils.delete(cache, `doh_key_v1:${oldToken}`));
        }
      }
      ctx.waitUntil(pipeline.clearCache(profileId, false, env));
      return new Response(JSON.stringify({ token: newToken }), { headers: { 'Content-Type': 'application/json' } });
    }

    const body = await request.json() as { name?: unknown };
    const trimmedName = typeof body?.name === "string" ? body.name.trim().replace(/\s+/g, ' ') : "";
    if (!trimmedName) return new Response("Name is required", { status: 400 });
    if (!AP_NAME_REGEX.test(trimmedName)) return new Response("Invalid Access Point name format", { status: 400 });
    
    const currentAps = await apModel.getAccessPoints(profileId);
    if (currentAps.some(ap => ap.name.toLowerCase() === trimmedName.toLowerCase())) {
      return new Response("Access Point name already exists", { status: 400 });
    }
    const maxAps = Number(env.MAX_ACCESS_POINTS_PER_PROFILE) || 100;
    if (currentAps.length >= maxAps) return new Response(`Access point limit exceeded (max ${maxAps})`, { status: 400 });
    
    const result = await apModel.addAccessPoint(profileId, trimmedName);
    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'PATCH' && pathParts.length === 5) {
    const apId = pathParts[4];
    const body = await request.json() as { name?: unknown };
    const trimmedName = typeof body?.name === "string" ? body.name.trim().replace(/\s+/g, ' ') : "";
    if (!trimmedName) return new Response("Name is required", { status: 400 });
    if (!AP_NAME_REGEX.test(trimmedName)) return new Response("Invalid Access Point name format", { status: 400 });

    const currentAps = await apModel.getAccessPoints(profileId);
    if (currentAps.some(ap => ap.id !== apId && ap.name.toLowerCase() === trimmedName.toLowerCase())) {
      return new Response("Access Point name already exists", { status: 400 });
    }

    await apModel.updateAccessPointName(apId, profileId, trimmedName);
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'DELETE' && pathParts.length === 5) {
    const apId = pathParts[4];
    const url = new URL(request.url);
    const newDefaultId = url.searchParams.get("new_default_id");
    const aps = await apModel.getAccessPoints(profileId);
    const targetAp = aps.find((a) => a.id === apId);
    const oldToken = targetAp?.token;
    await apModel.deleteAccessPoint(apId, profileId);
    if (oldToken) {
      profileKeyMemoryMap.delete(oldToken);
      const isServerfull = isServerfullEnv(env);
      const cache = !isServerfull && typeof caches !== "undefined" && caches ? (caches as any).default : null;
      if (cache) {
        ctx.waitUntil(cacheUtils.delete(cache, `doh_key_v1:${oldToken}`));
      }
    }

    // If deleted AP was default_ap_id, update profile settings to user-chosen or next remaining AP
    const profileModel = new ProfileModel(env.DB, env);
    const p = await profileModel.getById(profileId);
    if (p) {
      let settings: ProfileSettings = typeof p.settings === "string" ? JSON.parse(p.settings || "{}") : JSON.parse(JSON.stringify(p.settings || {}));
      if (settings.default_ap_id === apId) {
        const remaining = aps.filter(a => a.id !== apId);
        if (newDefaultId && remaining.some(a => a.id === newDefaultId)) {
          settings.default_ap_id = newDefaultId;
        } else {
          settings.default_ap_id = remaining.length > 0 ? remaining[0].id : "";
        }
        await profileModel.updateSettings(profileId, settings);
      }
    }

    ctx.waitUntil(pipeline.clearCache(profileId, false, env));
    return new Response(null, { status: 204 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}
