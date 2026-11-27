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

  // 备份与 S3 存储管理接口: /api/admin/backup
  if (pathParts[2] === 'backup') {
    const isServerfull = isServerfullEnv(env);
    if (!isServerfull) {
      return new Response(JSON.stringify({ configured: false, error: "Backup is only supported in Serverfull / Docker environment" }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const nodeFs = await import('node:fs');
    const nodeCp = await import('node:child_process');

    const parseEnvFile = (filePath: string) => {
      const cfg: Record<string, string> = {};
      try {
        if (nodeFs.existsSync(filePath)) {
          const content = nodeFs.readFileSync(filePath, 'utf-8');
          for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx !== -1) {
              const k = trimmed.slice(0, eqIdx).trim();
              let v = trimmed.slice(eqIdx + 1).trim();
              if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
                v = v.slice(1, -1);
              }
              cfg[k] = v;
            }
          }
        }
      } catch {}
      return cfg;
    };

    const fileConfig = {
      ...parseEnvFile('/data/.env'),
      ...parseEnvFile('/data/config/.env')
    };

    const getVal = (key: string, fallback = '') => process.env[key] || fileConfig[key] || fallback;

    const endpoint = getVal('BACKUP_S3_ENDPOINT');
    const bucket = getVal('BACKUP_S3_BUCKET');
    const region = getVal('BACKUP_S3_REGION', 'auto');
    const prefix = getVal('BACKUP_S3_PREFIX', 'obexdns').replace(/^\/+|\/+$/g, '');
    const accessKeyId = getVal('BACKUP_S3_ACCESS_KEY_ID', getVal('BACKUP_S3_ACCESS_KEY'));
    const secretAccessKey = getVal('BACKUP_S3_SECRET_ACCESS_KEY', getVal('BACKUP_S3_SECRET_KEY'));
    const cronExpr = getVal('BACKUP_CRON', getVal('BACKUP_CRON_EXPR', '0 2 * * *'));
    const keepDays = parseInt(getVal('BACKUP_KEEP_DAYS', '30'), 10) || 30;

    const isConfigured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

    // GET /api/admin/backup -> status
    if (request.method === 'GET' && !pathParts[3]) {
      return new Response(JSON.stringify({
        configured: isConfigured,
        endpoint: endpoint || null,
        bucket: bucket || null,
        region: region || 'auto',
        prefix: prefix || 'obexdns',
        cron: cronExpr,
        keepDays
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // POST /api/admin/backup/test -> test S3 connection
    if (request.method === 'POST' && pathParts[3] === 'test') {
      if (!isConfigured) {
        return new Response(JSON.stringify({
          success: false,
          error: "S3 backup is not configured (missing endpoint, bucket, or credentials)."
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const s3Script = '/app/s3-client.mjs';
      if (!nodeFs.existsSync(s3Script)) {
        return new Response(JSON.stringify({ success: false, error: "s3-client.mjs script not found." }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Promise<Response>((resolve) => {
        const bin = process.execPath || 'node';
        nodeCp.execFile(bin, [s3Script, 'test'], { timeout: 15000 }, (err, stdout, stderr) => {
          if (err) {
            const errMsg = stderr?.trim() || stdout?.trim() || err.message;
            return resolve(new Response(JSON.stringify({
              success: false,
              error: errMsg.replace(/^\[S3-Backup\]\s*/, '')
            }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            }));
          }
          let parsed = { success: true, message: `Connected to S3 bucket '${bucket}' successfully.` };
          try {
            parsed = JSON.parse(stdout.trim());
          } catch {}
          return resolve(new Response(JSON.stringify(parsed), {
            headers: { 'Content-Type': 'application/json' }
          }));
        });
      });
    }

    // POST /api/admin/backup/run -> trigger immediate backup
    if (request.method === 'POST' && pathParts[3] === 'run') {
      const backupScript = '/app/backup.sh';
      if (!nodeFs.existsSync(backupScript)) {
        return new Response(JSON.stringify({ success: false, error: "backup.sh script not found." }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Promise<Response>((resolve) => {
        nodeCp.exec(`nice -n 19 /bin/sh "${backupScript}"`, { timeout: 120000 }, (err, stdout, stderr) => {
          if (err) {
            const errMsg = stderr?.trim() || stdout?.trim() || err.message;
            return resolve(new Response(JSON.stringify({
              success: false,
              error: errMsg
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            }));
          }
          return resolve(new Response(JSON.stringify({
            success: true,
            message: "Backup completed successfully.",
            output: stdout.trim()
          }), {
            headers: { 'Content-Type': 'application/json' }
          }));
        });
      });
    }

    // GET /api/admin/backup/download -> generate local snapshot and stream file
    if (request.method === 'GET' && pathParts[3] === 'download') {
      const backupScript = '/app/backup.sh';
      if (!nodeFs.existsSync(backupScript)) {
        return new Response(JSON.stringify({ error: "backup.sh script not found." }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const tempFile = `/tmp/obexdns_manual_${Date.now()}.tar.gz`;
      return new Promise<Response>((resolve) => {
        nodeCp.exec(`nice -n 19 /bin/sh "${backupScript}" --local-only --output "${tempFile}"`, { timeout: 60000 }, (err, stdout, stderr) => {
          if (err || !nodeFs.existsSync(tempFile)) {
            const errMsg = stderr?.trim() || stdout?.trim() || err?.message || "Snapshot generation failed.";
            return resolve(new Response(JSON.stringify({ error: errMsg }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            }));
          }

          try {
            const fileBuffer = nodeFs.readFileSync(tempFile);
            nodeFs.unlinkSync(tempFile);
            const dateStr = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
            return resolve(new Response(fileBuffer, {
              headers: {
                'Content-Type': 'application/gzip',
                'Content-Disposition': `attachment; filename="obexdns_backup_${dateStr}.tar.gz"`,
                'Content-Length': String(fileBuffer.length)
              }
            }));
          } catch (e: any) {
            return resolve(new Response(JSON.stringify({ error: e.message }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            }));
          }
        });
      });
    }
  }

  return new Response("Not Found", { status: 404 });
}
