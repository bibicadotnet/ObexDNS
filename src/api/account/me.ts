import { Env, User, ExecutionContext } from "../../types";
import { createBlankRefreshTokenCookie, readRefreshTokenCookie, parseRefreshTokenString, isUsableJwtSecret, isStrongJwtSecret } from "../../lib/auth";
import { UserModel } from "../../models/user";
import { LogModel } from "../../models/log";
import { PasskeyModel } from "../../models/passkey";
import { USERNAME_REGEX } from "../../utils/validator";
import { verifyUserReauth, ReauthPayload } from "./security/reauth";
import { scheduleSpaceReclaim } from "../../utils/dbMaintenance";
import { pipeline } from "../../pipeline";

/**
 * Handle requests to /api/account/me, /api/account/logs, /api/account/delete
 */
export async function handleMeRequest(
  request: Request,
  env: Env,
  user: User,
  pathParts: string[],
  ctx: ExecutionContext
): Promise<Response> {
  const userModel = new UserModel(env.DB, env);
  const logModel = new LogModel(env.DB, env);
  const action = pathParts[2];

  // GET /api/account/me & PATCH /api/account/me
  if (action === 'me') {
    if (request.method === 'GET') {
      const dbUser = await userModel.getById(user.id);
      const globalMaxRetention = env.MAX_LOG_RETENTION_DAYS !== undefined && env.MAX_LOG_RETENTION_DAYS !== ''
        ? Number(env.MAX_LOG_RETENTION_DAYS)
        : 30;
      const adminMaxRetention = env.ADMIN_USER_MAX_LOG_RETENTION_DAYS !== undefined && env.ADMIN_USER_MAX_LOG_RETENTION_DAYS !== ''
        ? Math.min(Number(env.ADMIN_USER_MAX_LOG_RETENTION_DAYS), globalMaxRetention)
        : globalMaxRetention;
      const normalUserMax = env.NORMAL_USER_MAX_LOG_RETENTION_DAYS !== undefined && env.NORMAL_USER_MAX_LOG_RETENTION_DAYS !== ''
        ? Math.min(Number(env.NORMAL_USER_MAX_LOG_RETENTION_DAYS), globalMaxRetention)
        : Math.min(7, globalMaxRetention);

      const profileInactivityDays = env.INACTIVITY_THRESHOLD_DAYS !== undefined && env.INACTIVITY_THRESHOLD_DAYS !== ''
        ? Number(env.INACTIVITY_THRESHOLD_DAYS)
        : 30;
      const userInactivityDays = env.INACTIVITY_USER_DAYS !== undefined && env.INACTIVITY_USER_DAYS !== ''
        ? Number(env.INACTIVITY_USER_DAYS)
        : 90;

      const passkeyModel = new PasskeyModel(env.DB);
      const passkeysCount = await passkeyModel.countByUser(user.id);
      const mfaEnabled = !!(dbUser?.totp_enabled) || passkeysCount > 0;

      let hasRecoveryKeys = false;
      if (dbUser?.totp_recovery_keys) {
        try {
          const parsed = typeof dbUser.totp_recovery_keys === 'string' ? JSON.parse(dbUser.totp_recovery_keys) : dbUser.totp_recovery_keys;
          if (Array.isArray(parsed) && parsed.length > 0) {
            hasRecoveryKeys = true;
          }
        } catch {
          hasRecoveryKeys = true;
        }
      } else if (dbUser?.totp_recovery_keys_encrypted) {
        hasRecoveryKeys = true;
      }

      const jwtSecretWarning = user.role === 'admin'
        ? isUsableJwtSecret(env.JWT_SECRET) && !isStrongJwtSecret(env.JWT_SECRET)
        : false;

      return new Response(JSON.stringify({
        id: user.id,
        username: dbUser?.username || "",
        role: user.role,
        totp_enabled: !!(dbUser?.totp_enabled),
        totp_skip_password: !!(dbUser?.totp_skip_password),
        passkeys_count: passkeysCount,
        mfa_enabled: mfaEnabled,
        has_recovery_keys: hasRecoveryKeys,
        recovery_keys_encrypted: !!(dbUser?.totp_recovery_keys_encrypted),
        timezone: dbUser?.timezone || null,
        locale: dbUser?.locale || "en-US",
        password_version: dbUser?.password_version ?? 1,
        pin_enabled: !!(dbUser?.pin_hash),
        session_lock_timeout: dbUser?.session_lock_timeout ?? 15,
        max_log_retention_days: user.role === 'admin' ? adminMaxRetention : normalUserMax,
        jwt_secret_warning: jwtSecretWarning,
        inactivity_threshold_days: profileInactivityDays,
        inactivity_user_days: userInactivityDays,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'PATCH') {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return new Response("Invalid JSON payload", { status: 400 });
      }
      try {
        if (user.isPaused) {
          if (body.locale !== undefined) {
            const newLocale = body.locale;
            if (newLocale !== null && typeof newLocale === 'string' && newLocale !== '') {
              try {
                Intl.DateTimeFormat(newLocale);
              } catch (e) {
                return new Response("Invalid locale format", { status: 400 });
              }
            }
            await userModel.updateLocale(user.id, newLocale || "en-US");
            return new Response(JSON.stringify({ success: true }));
          }
          return new Response("session_paused", { status: 403 });
        }

        // Validate all fields BEFORE any writes to avoid partial/dangling updates
        let validatedTimeout: number | undefined;
        if (body.session_lock_timeout !== undefined) {
          const timeout = Number(body.session_lock_timeout);
          if (!Number.isFinite(timeout) || timeout < 0) {
            return new Response("Invalid session_lock_timeout value", { status: 400 });
          }
          validatedTimeout = timeout;
        }

        let validatedUsername: string | undefined;
        let newStoredPasswordHash: string | undefined;
        if (body.username !== undefined) {
          const newUsername = body.username;
          if (typeof newUsername !== 'string' || !newUsername || !USERNAME_REGEX.test(newUsername)) {
            return new Response("Username format error", { status: 400 });
          }
          const dbUser = await userModel.getById(user.id);
          // Only re-hash if username is actually changing
          if (dbUser && newUsername !== dbUser.username) {
            if ((dbUser.password_version ?? 1) === 2) {
              // Security: changing the username re-derives the password hash (username is PBKDF2 salt).
              // Both the new hash AND the current hash are REQUIRED so we can verify the caller
              // actually knows the current password before the re-hash is accepted.
              // Note: unlike /account/password this path only verifies via password, not passkey/TOTP,
              // and does not write an activity log — a known limitation, not a regression vs. the original.
              const newPasswordHash = body.new_password_hash;
              const currentPasswordHash = body.current_password_hash;
              if (!newPasswordHash || typeof newPasswordHash !== 'string') {
                return new Response("new_password_hash required when changing username", { status: 400 });
              }
              if (!currentPasswordHash || typeof currentPasswordHash !== 'string') {
                return new Response("current_password_hash required when changing username", { status: 400 });
              }
              // Verify the caller knows the current password before allowing the re-hash
              const { verifyPassword } = await import("../../utils/crypto");
              const isCurrentValid = await verifyPassword(currentPasswordHash, dbUser.hashed_password, 2);
              if (!isCurrentValid) {
                return new Response("Incorrect current password", { status: 400 });
              }
              const { hashPassword } = await import("../../utils/crypto");
              newStoredPasswordHash = await hashPassword(newPasswordHash, 2);
            }
            validatedUsername = newUsername;
          }
        }

        let validatedTimezone: string | null | undefined;
        if (body.timezone !== undefined) {
          const newTimezone = body.timezone;
          if (newTimezone !== null && typeof newTimezone === 'string' && newTimezone !== '') {
            try {
              Intl.DateTimeFormat(undefined, { timeZone: newTimezone });
            } catch (e) {
              return new Response("Invalid timezone format", { status: 400 });
            }
          }
          validatedTimezone = newTimezone || null;
        }

        let validatedLocale: string | undefined;
        if (body.locale !== undefined) {
          const newLocale = body.locale;
          if (newLocale !== null && typeof newLocale === 'string' && newLocale !== '') {
            try {
              Intl.DateTimeFormat(newLocale);
            } catch (e) {
              return new Response("Invalid locale format", { status: 400 });
            }
          }
          validatedLocale = newLocale || "en-US";
        }

        // All validations passed — apply updates
        if (validatedTimeout !== undefined) {
          await userModel.updateSessionLockTimeout(user.id, validatedTimeout);
        }
        if (validatedUsername !== undefined) {
          // Atomically update username and (if v2) password hash in a single D1 batch
          // so a UNIQUE collision on username never leaves the password hash in an
          // inconsistent state (which would lock the user out).
          const stmts: any[] = [
            env.DB.prepare("UPDATE users SET username = ? WHERE id = ?").bind(validatedUsername, user.id),
          ];
          if (newStoredPasswordHash) {
            stmts.push(
              env.DB.prepare("UPDATE users SET hashed_password = ?, password_version = 2 WHERE id = ?")
                .bind(newStoredPasswordHash, user.id)
            );
          }
          await env.DB.batch(stmts);
        }
        if (validatedTimezone !== undefined) {
          await userModel.updateTimezone(user.id, validatedTimezone);
        }
        if (validatedLocale !== undefined) {
          await userModel.updateLocale(user.id, validatedLocale);
        }

        return new Response(JSON.stringify({ success: true }));
      } catch (e: any) {
        if (e.message?.includes("UNIQUE constraint failed")) return new Response("The username is already taken", { status: 400 });
        return new Response("Failed to update settings", { status: 500 });
      }
    }

    return new Response("Method Not Allowed", { status: 405 });
  }


  // DELETE /api/account/logs
  if (action === 'logs' && request.method === 'DELETE') {
    await logModel.deleteByOwner(user.id);
    // Give the freed pages back to the disk in the background (never blocks DNS or this response).
    scheduleSpaceReclaim(env.DB, ctx);
    return new Response(JSON.stringify({ success: true }));
  }

  // POST /api/account/delete or DELETE /api/account/me (delete account with step-up reauthentication)
  if ((action === 'delete' && request.method === 'POST') || (action === 'me' && request.method === 'DELETE')) {
    const dbUser = await userModel.getById(user.id);
    if (!dbUser) return new Response("User not found", { status: 404 });

    // Prevent last admin from deleting themselves
    if (user.role === 'admin') {
      const adminCount = await env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").first<number>('count');
      if ((adminCount ?? 0) <= 1) {
        return new Response("Cannot delete the last administrator account", { status: 400 });
      }
    }

    let body: ReauthPayload = {};
    try {
      if (request.headers.get("content-type")?.includes("application/json")) {
        body = (await request.json()) as ReauthPayload;
      }
    } catch {}

    const authResult = await verifyUserReauth(dbUser, body, env, request);
    if (!authResult.success) {
      return new Response(authResult.error || "Authentication failed", { status: 400 });
    }

    // Collect profile IDs before deletion for cache clearing
    const { results: userProfiles } = await env.DB
      .prepare("SELECT id FROM profiles WHERE owner_id = ?")
      .bind(user.id)
      .all<{ id: string }>();
    const profileIds = (userProfiles || []).map((p) => p.id);

    // Invalidate current session immediately
    const { invalidateSession } = await import("../../lib/auth");
    const cookieHeader = request.headers.get("Cookie") || "";
    const refreshToken = readRefreshTokenCookie(cookieHeader);
    const sessionId = refreshToken ? parseRefreshTokenString(refreshToken)?.sid || null : null;
    if (sessionId) await invalidateSession(env, sessionId);

    // Also sweep all in-memory cache entries for this user (invalidateSession above only
    // clears the one known sessionId; other concurrent sessions share the same user cache).
    const { invalidateAuthUserCache } = await import("../../lib/middleware");
    invalidateAuthUserCache(undefined, user.id);

    // Clean logs/rollups synchronously BEFORE deleting the user.
    // The original code relied on ProfileModel.deleteByOwner (also synchronous) to do this;
    // we do it explicitly here because the patch no longer calls that helper.
    for (const pid of profileIds) {
      try {
        await logModel.deleteByProfile(pid);
      } catch (err) {
        console.error(`[Me] Failed to clean logs/rollups for profile ${pid}:`, err);
      }
    }

    // Delete user (FK cascade removes profiles).
    await userModel.delete(user.id);

    // Clear DNS caches in the background — safe to defer because the data
    // is already gone from D1 and stale cache is merely cosmetic.
    for (const pid of profileIds) {
      ctx.waitUntil(pipeline.clearCache(pid, true, env));
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Set-Cookie": createBlankRefreshTokenCookie(), "Content-Type": "application/json" }
    });
  }

  return new Response("Not Found", { status: 404 });
}
