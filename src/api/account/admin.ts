import { Env, User, ExecutionContext } from "../../types";
import { generateId } from "../../lib/auth";
import { hashPassword } from "../../utils/crypto";
import { UserModel } from "../../models/user";
import { LogModel } from "../../models/log";
import { SystemSettingsModel } from "../../models/systemSettings";
import { PASSWORD_REGEX, USERNAME_REGEX } from "../../utils/validator";
import { isServerfullEnv } from "../../utils/serverfullEnv";
import { pipeline } from "../../pipeline";
import { invalidateAuthUserCache } from "../../lib/middleware";
import {
  getDatabaseService,
  isTursoConfigured,
  getTursoMigrationStats,
  runTursoMigrations
} from "../../lib/turso";
import { toPublicErrorCode } from "../../utils/publicError";

/**
 * Allowlist of system setting keys that can be updated via administrative REST APIs.
 * Prevents key namespace pollution and blocks attempts to overwrite internal timestamps or runtime secrets.
 */
const ALLOWED_ADMIN_SETTINGS_KEYS = new Set<string>([
  'turnstile_site_key',
  'turnstile_secret_key',
  'turnstile_enabled_signup',
  'turnstile_enabled_login',
  'registration_enabled'
]);

/**
 * Handle admin requests to /api/admin/...
 */
export async function handleAdminRequest(
  request: Request,
  env: Env,
  user: User,
  pathParts: string[],
  ctx: ExecutionContext
): Promise<Response> {
  const userModel = new UserModel(env.DB, env);

  if (pathParts[2] === 'users') {
    if (request.method === 'GET') {
      const users = await userModel.listAll();
      return new Response(JSON.stringify(users), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'POST') {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return new Response("Invalid JSON payload", { status: 400 });
      }
      const { username, password, role } = body;
      if (typeof username !== 'string' || !username || !USERNAME_REGEX.test(username)) {
        return new Response("Invalid username format", { status: 400 });
      }
      if (typeof password !== 'string' || !password || !PASSWORD_REGEX.test(password)) {
        return new Response("Password format error", { status: 400 });
      }
      const normalizedRole = role === 'admin' ? 'admin' : 'user';
      const hashedPassword = await hashPassword(password, 2);
      const userId = generateId(15);
      try {
        await userModel.create({ id: userId, username, passwordHash: hashedPassword, role: normalizedRole, passwordVersion: 2 });
        return new Response(JSON.stringify({ id: userId }), { status: 201 });
      } catch (e: any) {
        console.error("[Admin] Create user failed:", e?.message || e);
        return new Response(toPublicErrorCode(e, "create_user_failed"), { status: 400 });
      }
    }

    if (request.method === 'DELETE' && pathParts[3]) {
      const targetId = pathParts[3];
      if (targetId === user.id) return new Response("Cannot delete yourself", { status: 400 });

      const { results: targetProfiles } = await env.DB
        .prepare("SELECT id FROM profiles WHERE owner_id = ?")
        .bind(targetId)
        .all<{ id: string }>();
      const profileIds = (targetProfiles || []).map((p) => p.id);

      // Check the target actually exists before reporting 204
      const targetUser = await userModel.getById(targetId);
      if (!targetUser) return new Response("User not found", { status: 404 });

      // Invalidate in-memory session cache immediately so tokens cannot be reused
      invalidateAuthUserCache(undefined, targetId);

      // Clean logs/rollups synchronously BEFORE deleting the user so orphan rows cannot
      // be left behind if the Worker is cut short during waitUntil.
      const logModel = new LogModel(env.DB, env);
      for (const pid of profileIds) {
        try {
          await logModel.deleteByProfile(pid);
        } catch (err) {
          console.error(`[Admin] Failed to clean logs/rollups for profile ${pid}:`, err);
        }
      }

      // Delete user (FK cascade removes profiles).
      await userModel.delete(targetId);

      // Clear DNS caches in the background — data already gone from D1.
      for (const pid of profileIds) {
        ctx.waitUntil(pipeline.clearCache(pid, true, env));
      }
      return new Response(null, { status: 204 });
    }
  }

  // 系统设置接口: /api/admin/settings
  if (pathParts[2] === 'settings') {
    const systemSettings = new SystemSettingsModel(env.DB);
    if (request.method === 'GET') {
      const settings = await systemSettings.getAll();
      // Redact all secrets — never expose jwt_secret or turnstile_secret_key to the client
      delete settings.jwt_secret;
      delete settings.turnstile_secret_key;
      return new Response(JSON.stringify(settings), { headers: { 'Content-Type': 'application/json' } });
    }
    if (request.method === 'PATCH') {
      let body: Record<string, unknown> = {};
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return new Response("Invalid JSON payload", { status: 400 });
      }

      const filteredSettings: Record<string, string> = {};
      for (const [key, value] of Object.entries(body)) {
        if (ALLOWED_ADMIN_SETTINGS_KEYS.has(key) && typeof value === 'string') {
          // Bound setting value length to prevent unbounded storage usage
          filteredSettings[key] = value.slice(0, 1024);
        }
      }

      // Guard: cannot enable Turnstile when no secret key is configured or being saved
      const incomingSecret = filteredSettings.turnstile_secret_key;
      const existingSecret = incomingSecret !== undefined ? incomingSecret : await systemSettings.get('turnstile_secret_key');
      const effectiveSecret = existingSecret || '';

      if (!effectiveSecret) {
        // Reject attempts to enable Turnstile without a secret — return an explicit error
        // so the UI can show a clear message instead of silently toggling off after a refresh.
        if (filteredSettings.turnstile_enabled_signup === 'true' || filteredSettings.turnstile_enabled_login === 'true') {
          return new Response("turnstile_secret_required", { status: 400 });
        }
      }

      if (Object.keys(filteredSettings).length > 0) {
        await systemSettings.setMany(filteredSettings);
      }
      return new Response(JSON.stringify({ success: true }));
    }
  }

  // 数据库管理与迁移接口: /api/admin/database
  if (pathParts[2] === 'database') {
    const isServerfull = isServerfullEnv(env);
    const dbService = getDatabaseService(env, isServerfull);
    const isTurso = dbService === 'Turso' && isTursoConfigured(env);

    if (request.method === 'GET') {
      const stats = env.DB ? await getTursoMigrationStats(env.DB as any) : null;
      return new Response(JSON.stringify({
        databaseService: dbService,
        isTurso,
        configured: Boolean(env.DB),
        migrations: stats
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'POST') {
      const action = pathParts[3];
      if (action === 'migrate') {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "Database is not configured" }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        const appliedCount = await runTursoMigrations(env.DB as any);
        const stats = await getTursoMigrationStats(env.DB as any);
        return new Response(JSON.stringify({
          success: true,
          appliedCount,
          stats
        }), { headers: { 'Content-Type': 'application/json' } });
      }
    }
  }

  return new Response("Not Found", { status: 404 });
}
