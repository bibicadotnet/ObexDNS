/**
 * @file publicError.ts
 * @description Maps arbitrary thrown errors to short, stable codes that are safe to send to clients.
 *
 * Raw `e.message` values can contain SQL, table names or file paths, so they must never be sent
 * as a response body. The full error should be logged server-side; clients only get a code.
 * The codes below are the ones the web UI knows how to translate (web/src/utils/auth.ts).
 */

const PASSTHROUGH_CODES = new Set([
  "jwt_secret_missing",
  "jwt_secret_preset",
  "jwt_secret_invalid",
  "no_users_registered",
  "username_exists",
  "database_unavailable",
  "rate_limited",
  "user_not_found",
  "invalid_credentials",
  "invalid_totp",
  "invalid_turnstile",
  "turnstile_failed",
  "geolocation_missing",
  "password_leaked",
]);

export function toPublicErrorCode(e: unknown, fallback = "internal_server_error"): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (PASSTHROUGH_CODES.has(msg)) return msg;
  if (msg.includes("UNIQUE constraint failed")) return "username_exists";
  // Cloudflare D1 quota exhaustion: the UI shows a dedicated "database quota exceeded" notice for this code.
  if (msg.includes("row read limit") || msg.includes("exceeded D1")) return "database_unavailable";
  if (msg.includes("no such table") || msg.includes("SQLITE_ERROR")) return "db_not_initialized";
  return fallback;
}
