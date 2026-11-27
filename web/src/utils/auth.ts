declare global {
  interface Window {
    onloadTurnstileCallback: () => void;
    turnstile: any;
  }
}

/**
 * Username validation regular expression.
 * Requirements: 5-15 alphanumeric characters only.
 */
export const USERNAME_REGEX = /^[a-z_][a-z0-9_-]{4,31}$/;
/**
 * Password validation regular expression.
 * Requirements: 12-100 characters containing letters, numbers, and special characters.
 */
export const PASSWORD_REGEX = /^[a-zA-Z\d~`!@#$%^&*()_\-+={[}\]|\\:;"'<,>.?\/]{12,100}$/;
/**
 * Access key validation regular expression.
 * Requirements: 5-12 alphanumeric characters only (supporting 5-char z-base-32 tokens).
 */
export const ACCESS_KEY_REGEX = /^[a-zA-Z0-9]{5,12}$/;
/**
 * TOTP token validation regular expression.
 * Requirements: exactly 6 digits.
 */
export const TOTP_TOKEN_REGEX = /^\d{6}$/;
/**
 * Profile name validation regular expression.
 * Requirements: 1-30 Unicode characters, disallowing control characters and whitespace-only names.
 */
export const PROFILE_NAME_REGEX = /^(?!\s+$)[^\p{Cc}]{1,30}$/u;
/**
 * Access Point (AP) name validation regular expression.
 * Requirements: 1-30 Unicode characters, disallowing control characters and whitespace-only names.
 */
export const AP_NAME_REGEX = /^(?!\s+$)[^\p{Cc}]{1,30}$/u;
/**
 * Passkey name validation regular expression.
 * Requirements: 1-30 Unicode characters, disallowing control characters and whitespace-only names (same as AP_NAME_REGEX).
 */
export const PASSKEY_NAME_REGEX = /^(?!\s+$)[^\p{Cc}]{1,30}$/u;
/**
 * PIN validation regular expression.
 * Requirements: exactly 4 digits.
 */
export const PIN_REGEX = /^\d{4}$/;

/**
 * Validates whether a passkey name matches the required format (1-30 characters, alphanumeric, underscore, hyphen).
 *
 * @param name - The passkey name to validate.
 * @returns True if valid.
 */
export function validatePasskeyName(name: string): boolean {
  return PASSKEY_NAME_REGEX.test(name.trim());
}

/**
 * Validates whether a username matches the required alphanumeric 5-15 character format.
 *
 * @param username - The username to validate.
 * @returns True if valid.
 */
export function validateUsername(username: string): boolean {
  return USERNAME_REGEX.test(username);
}

/**
 * Validates whether a password matches the required alphanumeric 12+ character format.
 *
 * @param password - The password to validate.
 * @returns True if valid.
 */
export function validatePassword(password: string): boolean {
  return PASSWORD_REGEX.test(password);
}

/**
 * Checks if a response or its text content indicates a password breach/leak
 * (either returned explicitly from backend API or caught/blocked by custom WAF rules).
 *
 * @param res - The fetch Response object.
 * @param bodyText - The raw response body text.
 * @returns True if a password leak warning is detected.
 */
export function isPasswordLeaked(res: Response, bodyText: string): boolean {
  if (bodyText === "password_leaked") return true;
  if (res.status === 403 && (bodyText.includes("password_leaked") || bodyText.includes("password breached"))) {
    return true;
  }
  return false;
}

export interface CloudflareErrorInfo {
  isCf: boolean;
  isHtml: boolean;
  errorCode: string | null;
  errorDesc: string | null;
  rayId: string | null;
}

/**
 * Detects and parses Cloudflare error pages or HTML error responses.
 */
export function parseCloudflareError(bodyText?: string | null): CloudflareErrorInfo | null {
  if (!bodyText || typeof bodyText !== "string") return null;

  const trimmed = bodyText.trim();
  const isHtml = trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || /<[a-z][\s\S]*>/i.test(trimmed);
  const isCf = trimmed.includes("cf-error-details") || 
               trimmed.includes("cf-wrapper") || 
               trimmed.includes("cf.errors.css") || 
               trimmed.includes("Cloudflare Ray ID") || 
               /Worker threw exception/i.test(trimmed);

  if (!isHtml && !isCf) return null;

  // Extract Code (e.g. 1101, 1020, 520, etc.)
  const codeMatch = trimmed.match(/class=["']cf-error-code["'][^>]*>([^<]+)</i) || 
                    trimmed.match(/Error\s+([0-9]{3,4})/i);
  const errorCode = codeMatch ? codeMatch[1].trim() : null;

  // Extract Description / Headline
  const descMatch = trimmed.match(/data-translate=["']error_desc["'][^>]*>([^<]+)</i) ||
                    trimmed.match(/class=["']cf-subheadline["'][^>]*>([^<]+)</i) ||
                    trimmed.match(/<title>([^<|]+)/i);
  const errorDesc = descMatch ? descMatch[1].trim() : null;

  // Extract Ray ID
  const rayMatch = trimmed.match(/Ray ID:\s*<strong[^>]*>([a-f0-9]+)<\/strong>/i) ||
                   trimmed.match(/Ray ID:\s*([a-f0-9]+)/i) ||
                   trimmed.match(/Cloudflare Ray ID:\s*<strong[^>]*>([a-f0-9]+)<\/strong>/i);
  const rayId = rayMatch ? rayMatch[1].trim() : null;

  return {
    isCf,
    isHtml,
    errorCode,
    errorDesc,
    rayId
  };
}

/**
 * Formats API errors into concise, user-friendly messages.
 * Automatically intercepts Cloudflare error pages and converts them to 1-2 sentence prompts.
 */
export function formatApiErrorMessage(err: any, t: (key: string, options?: any) => string): string {
  if (!err) return t("auth.authFailed", "Authentication failed");

  const bodyText = typeof err === "string" ? err : err.bodyText || err.message || "";
  let cleanText = bodyText;
  if (typeof cleanText === "string" && cleanText.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(cleanText);
      cleanText = parsed.message || parsed.error || cleanText;
    } catch {}
  }

  const cfError = parseCloudflareError(cleanText);

  if (cfError) {
    const rayIdSuffix = cfError.rayId ? ` (Ray ID: ${cfError.rayId})` : "";
    if (cfError.errorCode && cfError.errorDesc) {
      return t("auth.cfErrorWithDetails", {
        defaultValue: `Cloudflare Edge error (Error ${cfError.errorCode}: ${cfError.errorDesc}). Service is temporarily unavailable, please try again later.${rayIdSuffix}`,
        code: cfError.errorCode,
        desc: cfError.errorDesc,
        rayId: rayIdSuffix
      });
    }
    if (cfError.errorCode) {
      return t("auth.cfErrorCodeOnly", {
        defaultValue: `Cloudflare Edge error (Error ${cfError.errorCode}). Service is temporarily unavailable, please try again later.${rayIdSuffix}`,
        code: cfError.errorCode,
        rayId: rayIdSuffix
      });
    }
    if (cfError.isCf) {
      return t("auth.cfErrorGeneric", {
        defaultValue: `Cloudflare Edge error, service is temporarily unavailable. Please try again later.${rayIdSuffix}`,
        rayId: rayIdSuffix
      });
    }
    return t("auth.htmlErrorGeneric", {
      defaultValue: `Server returned an unexpected page response (HTTP ${err.status || 500}). Please try again later.`,
      status: err.status || 500
    });
  }

  const errName = err?.name || "";
  const lowerBody = (cleanText || "").toLowerCase();

  // WebAuthn / Passkey DOMExceptions & Client cancellations
  if (
    errName === "NotAllowedError" ||
    lowerBody.includes("timed out or was not allowed") ||
    lowerBody.includes("privacy-considerations-client") ||
    lowerBody.includes("not allowed by the user agent") ||
    lowerBody.includes("authentication was cancelled") ||
    lowerBody.includes("creation was cancelled") ||
    lowerBody.includes("assertion was cancelled") ||
    lowerBody.includes("user cancelled") ||
    lowerBody.includes("user denied")
  ) {
    return t("auth.passkeyCancelledOrTimeout", "Passkey operation was cancelled or timed out.");
  }

  if (
    errName === "AbortError" ||
    lowerBody.includes("operation was aborted") ||
    lowerBody === "abort" ||
    lowerBody.includes("aborted")
  ) {
    return t("auth.passkeyAborted", "Passkey operation was aborted.");
  }

  if (
    errName === "InvalidStateError" ||
    lowerBody.includes("already registered")
  ) {
    return t("auth.passkeyAlreadyRegistered", "This Passkey is already registered.");
  }

  if (
    errName === "NotSupportedError" ||
    lowerBody.includes("not supported")
  ) {
    return t("auth.passkeyNotSupported", "Passkeys are not supported on this browser or device.");
  }

  if (
    errName === "SecurityError" ||
    lowerBody.includes("security error")
  ) {
    return t("auth.passkeySecurityError", "WebAuthn security error, please verify HTTPS connection or domain.");
  }

  // Rate Limiting
  if (
    err?.status === 429 ||
    lowerBody.includes("too many") ||
    cleanText === "rate_limited"
  ) {
    return t("auth.tooManyAttempts", {
      defaultValue: "Too many requests or attempts, temporarily rate limited. Please try again later."
    });
  }

  // D1 / Database quota or not initialized
  if (lowerBody.includes("row read limit") || lowerBody.includes("exceeded d1") || cleanText === "database_unavailable") {
    return t("auth.dbQuotaExceeded", {
      defaultValue: "Database daily read quota has been exceeded. Please wait for the daily reset or upgrade."
    });
  }

  if (
    cleanText === "db_not_initialized" ||
    lowerBody.includes("no such table") ||
    lowerBody.includes("sqlite_error")
  ) {
    return t("auth.dbNotInitialized", {
      defaultValue: "Database is not initialized or missing tables. Please run npm run db:migrate:prod in terminal."
    });
  }

  if (
    cleanText === "no_users_registered" ||
    lowerBody.includes("no_users_registered")
  ) {
    return t("auth.noUsersRegistered", "No accounts registered yet. Please sign up to become an administrator.");
  }

  // Parse remaining attempts if present (e.g. "4 attempts remaining")
  const remainingMatch = cleanText.match(/(\d+)\s+attempt/i);
  const remaining = remainingMatch ? parseInt(remainingMatch[1], 10) : undefined;

  // TOTP errors
  if (lowerBody.includes("invalid totp") || cleanText === "invalid_totp") {
    if (remaining !== undefined) {
      return t("auth.invalidTotpRemaining", {
        defaultValue: `Invalid TOTP verification code. ${remaining} attempts remaining.`,
        count: remaining
      });
    }
    return t("auth.invalidTotp", "Invalid TOTP verification code.");
  }

  if (lowerBody.includes("totp code") && lowerBody.includes("already used")) {
    return t("auth.totpAlreadyUsed", "TOTP code already used, please wait for next code.");
  }

  if (lowerBody.includes("totp is already enabled")) {
    return t("account.totp.alreadyEnabled", "TOTP is already enabled.");
  }

  if (lowerBody.includes("totp is not enabled")) {
    return t("account.totp.notEnabled", "TOTP is not enabled.");
  }

  if (lowerBody.includes("missing secret or token")) {
    return t("auth.totpFormatError", "Please enter a valid 6-digit code");
  }

  // Recovery Key errors
  if (lowerBody.includes("invalid recovery") || cleanText === "invalid_recovery_key") {
    if (remaining !== undefined) {
      return t("auth.invalidRecoveryKeyRemaining", {
        defaultValue: `Invalid emergency recovery key. ${remaining} attempts remaining.`,
        count: remaining
      });
    }
    return t("auth.invalidRecoveryKey", "Invalid emergency recovery key.");
  }

  if (lowerBody.includes("recovery token is required")) {
    return t("auth.recoveryKeyRequired", "Please enter your recovery key");
  }

  if (lowerBody.includes("recovery session expired")) {
    return t("auth.sessionExpiredNotice", "Session expired or invalid. Please log in again.");
  }

  if (lowerBody.includes("recovery key rotation only permits")) {
    return t("account.recoveryKey.rotateConfirmDesc", "Rotating the recovery key will immediately invalidate the old recovery key and re-derive the envelope encryption key. Only verification via existing Passkey or original recovery key is allowed. Continue?");
  }

  // Passkey backend responses
  if (lowerBody.includes("passkey not recognized")) {
    return t("auth.passkeyNotRecognized", "Passkey was not recognized.");
  }

  if (lowerBody.includes("invalid passkey signature")) {
    if (remaining !== undefined) {
      return t("auth.invalidPasskeySignatureRemaining", {
        defaultValue: `Invalid Passkey signature. ${remaining} attempts remaining.`,
        count: remaining
      });
    }
    return t("auth.invalidPasskeySignature", "Invalid Passkey signature.");
  }

  if (lowerBody.includes("invalid passkey")) {
    if (remaining !== undefined) {
      return t("auth.invalidPasskeyRemaining", {
        defaultValue: `Invalid Passkey. ${remaining} attempts remaining.`,
        count: remaining
      });
    }
    return t("auth.invalidPasskey", "Invalid Passkey.");
  }

  if (lowerBody.includes("passkey verification failed")) {
    return t("account.passkey.testFailed", "Passkey verification failed");
  }

  if (lowerBody.includes("passkey registration failed")) {
    return t("account.passkey.regFailed", "Registration failed");
  }

  if (lowerBody.includes("no passkeys registered")) {
    return t("account.passkey.noPasskeys", "No passkeys registered.");
  }

  if (lowerBody.includes("target passkey not found") || lowerBody.includes("passkey not found")) {
    return t("account.passkey.notFound", "Passkey not found.");
  }

  if (lowerBody.includes("invalid passkey name format")) {
    return t("account.passkey.formatTip", "1-30 characters, letters, numbers, hyphens and underscores allowed");
  }

  // Missing MFA verification
  if (lowerBody.includes("missing mfa verification") || lowerBody.includes("no valid mfa credential")) {
    if (remaining !== undefined) {
      return t("auth.missingMfaRemaining", {
        defaultValue: `Missing MFA verification. ${remaining} attempts remaining.`,
        count: remaining
      });
    }
    return t("auth.noMfaProvided", "No valid MFA credentials provided.");
  }

  if (lowerBody.includes("mfa is not enabled")) {
    return t("account.mfa.notEnabled", "MFA is not enabled.");
  }

  // E2EE specific errors
  if (lowerBody.includes("no passkeys have been enrolled in e2ee")) {
    return t("account.e2ee.noPasskeysEnrolled", "No passkeys have been enrolled in E2EE yet. Please unlock with Recovery Key or reset the keypair.");
  }

  if (lowerBody.includes("invalid recovery key or corrupted data")) {
    return t("account.e2ee.recoveryUnlockFailed", "Invalid Recovery Key or decryption failed.");
  }

  if (lowerBody.includes("failed to decrypt private key with this passkey")) {
    return t("account.e2ee.passkeyDecryptFailed", "Failed to decrypt private key with this Passkey. Please unlock using your Recovery Key.");
  }

  if (lowerBody.includes("wrapped key not found")) {
    return t("account.e2ee.keyNotFound", "Wrapped key not found for this passkey.");
  }

  // User & Password credentials
  if (lowerBody.includes("invalid password")) {
    if (remaining !== undefined) {
      return t("auth.invalidPasswordRemaining", {
        defaultValue: `Incorrect password. ${remaining} attempts remaining.`,
        count: remaining
      });
    }
    return t("auth.authFailed", "Authentication failed, please check your username or password.");
  }

  if (lowerBody.includes("password format error")) {
    return t("auth.formatTipPassword", "Password must be at least 8 characters.");
  }

  if (lowerBody.includes("password is required")) {
    return t("auth.passwordRequired", "Password is required.");
  }

  if (cleanText === "invalid_credentials" || cleanText === "user_not_found" || lowerBody.includes("user not found")) {
    return t("auth.userNotFound", "User not found.");
  }

  if (
    cleanText === "username_exists" ||
    lowerBody.includes("the username is already taken") ||
    lowerBody.includes("username already exists")
  ) {
    return t("auth.usernameExists", "This username is already taken. Please try another one.");
  }

  if (lowerBody.includes("username format error") || lowerBody.includes("invalid username format")) {
    return t("auth.formatTipUsername", "1-30 characters, letters, numbers, hyphens and underscores allowed");
  }

  if (lowerBody.includes("username is required")) {
    return t("auth.usernameRequired", "Username is required.");
  }

  if (lowerBody.includes("cannot delete yourself")) {
    return t("account.cannotDeleteSelf", "Cannot delete your own account.");
  }

  if (lowerBody.includes("pin not configured")) {
    return t("auth.pinNotConfigured", "PIN not configured.");
  }

  if (lowerBody.includes("incorrect pin") || lowerBody.includes("invalid pin")) {
    return t("auth.pinIncorrect", "Incorrect PIN");
  }

  if (cleanText === "password_leaked") {
    return t("auth.passwordLeaked", "Your password has been leaked.");
  }

  if (cleanText === "invalid_turnstile" || cleanText === "turnstile_failed") {
    return t("auth.turnstileRequired", "Please complete Turnstile verification.");
  }

  if (cleanText === "turnstile_secret_required") {
    return t("account.turnstileSecretRequired", "Please enter a Turnstile Secret Key before enabling verification.");
  }

  if (cleanText === "geolocation_missing") {
    return t("auth.geolocationRequired", "Geolocation retrieval failed, please re-enter.");
  }

  // Sessions and resets
  if (
    lowerBody.includes("session expired") ||
    lowerBody.includes("session missing or expired") ||
    lowerBody.includes("pre-auth session") ||
    lowerBody.includes("test session expired") ||
    lowerBody.includes("registration session expired") ||
    lowerBody.includes("challenge expired")
  ) {
    return t("auth.sessionExpiredNotice", "Session expired or invalid. Please try again.");
  }

  if (lowerBody.includes("reset token and new password are required")) {
    return t("auth.resetTokenRequired", "Reset token and new password are required.");
  }

  if (lowerBody.includes("unauthorized") || err?.status === 401) {
    return t("auth.unauthorized", "Unauthorized request. Please log in again.");
  }

  if (lowerBody.includes("forbidden") || err?.status === 403) {
    return t("auth.forbidden", "Access denied: You do not have permission to perform this action.");
  }

  // Network / fetch errors
  if (
    (errName === "TypeError" && lowerBody.includes("fetch")) ||
    lowerBody.includes("networkerror") ||
    lowerBody.includes("failed to fetch")
  ) {
    return t("common.errorNetwork", "Network error, please try again later.");
  }

  // Profile and Access Point errors
  if (lowerBody.includes("profile name already exists")) {
    return t("dash.profileNameExists", "The profile name already exists");
  }

  if (lowerBody.includes("invalid profile name format")) {
    return t("dash.profileNameFormatError", "Invalid Profile Name format");
  }

  if (lowerBody.includes("access point name already exists")) {
    return t("setup.accessPointNameExists", "Access Point name already exists");
  }

  if (lowerBody.includes("invalid access point name format")) {
    return t("setup.accessPointNameFormatError", "Invalid Access Point name format");
  }

  // JWT Secret config errors
  if (
    cleanText === "jwt_secret_preset" ||
    cleanText.includes("jwt_secret_preset") ||
    cleanText.includes("is a documentation placeholder")
  ) {
    return t("auth.jwtSecretPreset", "Default preset JWT_SECRET detected. Please update and customize JWT_SECRET in environment variables before deploying.");
  }
  if (
    cleanText === "jwt_secret_missing" ||
    cleanText.includes("jwt_secret_missing") ||
    cleanText.includes("isJwtSecretMissing") ||
    cleanText.includes("JWT_SECRET is missing") ||
    cleanText.includes("JWT_SECRET secret variable")
  ) {
    return t("auth.jwtSecretMissing", "JWT_SECRET is missing. Please configure a secure key in environment variables before deploying.");
  }
  if (cleanText === "jwt_secret_invalid") {
    return t("auth.jwtSecretInvalid", "JWT_SECRET format is invalid, please check configuration.");
  }

  if (cleanText === "internal_server_error" || cleanText === "registration_failed") {
    return t("auth.serverError", "Server error, please try again later.");
  }

  // If cleanText is short and doesn't contain HTML markup, return it directly
  if (cleanText && cleanText.length < 200 && !cleanText.includes("<") && !cleanText.includes(">")) {
    return cleanText;
  }

  return t("auth.authFailed", "Authentication failed, please check your username or password.");
}

/**
 * Dynamically injects the Cloudflare Turnstile verification script into the document head.
 * Ensures the callback is registered and the script is loaded only once.
 *
 * @param onLoad - Callback function to invoke when Turnstile SDK is loaded and ready.
 */
export function loadTurnstileScript(onLoad: () => void): void {
  if (window.turnstile) {
    onLoad();
    return;
  }
  window.onloadTurnstileCallback = onLoad;
  if (!document.querySelector('script[src*="turnstile/v0/api.js"]')) {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onloadTurnstileCallback";
    script.async = true;
    script.defer = true;
    const nonce = (window as any).DNS_WORKER_CONFIG?.nonce;
    if (nonce) {
      script.nonce = nonce;
    }
    document.head.appendChild(script);
  }
}

/**
 * Hashes a TOTP token code with a given UUID salt using SHA-256 for secure transport.
 *
 * @param token - The 6-digit TOTP token.
 * @param salt - The random UUID salt.
 * @returns Hex-encoded SHA-256 hash string.
 */
export async function hashTotpToken(token: string, salt: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(token + salt);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Hashes a password on the client side using PBKDF2 with SHA-256 (600,000 iterations).
 *
 * @param password - The raw password.
 * @param salt - The salt (usually the username, lowercase).
 * @param iterations - The number of iterations (default 600000).
 * @returns Hex-encoded client hash string (length 64, >= 256 bits).
 */
export async function hashPasswordClient(password: string, salt: string, iterations: number = 600000): Promise<string> {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);
  const saltBuffer = encoder.encode(salt.toLowerCase());

  const baseKey = await crypto.subtle.importKey(
    "raw",
    passwordBuffer,
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"]
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBuffer,
      iterations: iterations,
      hash: "SHA-256"
    },
    baseKey,
    256
  );

  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Converts a hexadecimal string to a Uint8Array.
 */
export function hexToUint8Array(hexString: string): Uint8Array {
  const bytes = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexString.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Derives the stored hash from the client hash using PBKDF2 with 100,000 iterations.
 * This matches the backend hashPassword(clientHash, 2) implementation.
 */
export async function deriveStoredHashClient(clientHash: string, saltHex: string): Promise<string> {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(clientHash);
  const salt = hexToUint8Array(saltHex);

  const baseKey = await crypto.subtle.importKey(
    "raw",
    passwordBuffer,
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"]
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as any,
      iterations: 100000,
      hash: "SHA-256"
    },
    baseKey,
    256
  );

  const combined = new Uint8Array(salt.length + hashBuffer.byteLength);
  combined.set(salt);
  combined.set(new Uint8Array(hashBuffer), salt.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Computes the HMAC-SHA256 signature of the given data using the specified key.
 * Returns a hex-encoded signature.
 */
export async function hmacSha256(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyBuffer = encoder.encode(key);
  const dataBuffer = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, dataBuffer);
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Computes the PBKDF2 client hash of a 4-digit PIN for session locking,
 * reusing the client-side password hashing scheme (600,000 iterations).
 */
export async function hashPin(pin: string, salt: string): Promise<string> {
  return hashPasswordClient(pin, salt);
}

/**
 * Hashes the client pinHash with a nonce challenge.
 * Uses 10,000 iterations to be fully compatible with Cloudflare Workers limits.
 */
export async function hashChallenge(pinHash: string, nonce: string): Promise<string> {
  return hashPasswordClient(pinHash, nonce, 10000);
}

/**
 * Validates a single 6-digit recovery key group using the Modulo 11 check algorithm.
 * Returns true if the 6-digit number is divisible by 11 with remainder 0.
 *
 * @param group - 6-digit numeric string
 * @returns boolean indicating validity
 */
export function validateRecoveryGroup(group: string): boolean {
  if (!/^\d{6}$/.test(group.trim())) return false;
  const num = parseInt(group.trim(), 10);
  return num % 11 === 0;
}

/**
 * Formats a raw 30-digit recovery string into 5 groups of 6 digits separated by hyphens.
 *
 * @param raw - Raw numeric string
 * @returns Formatted recovery key
 */
export function formatRecoveryKey(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 30);
  const groups: string[] = [];
  for (let i = 0; i < digits.length; i += 6) {
    groups.push(digits.slice(i, i + 6));
  }
  return groups.join('-');
}

