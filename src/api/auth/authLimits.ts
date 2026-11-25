/**
 * @file authLimits.ts
 * @description Admin-tunable limits for authentication endpoints (rate limiting, PIN lock, WebAuthn timeout).
 * All values are read from environment variables, falling back to the previous built-in defaults.
 */

import { Env } from "../../types";
import { envNumber } from "../../utils/envNumber";

/** Counter limit used for "penalty" increments: high enough to never short-circuit before the real limit. */
export const PENALTY_LIMIT = Number.MAX_SAFE_INTEGER;

export function getAuthLimits(env: Env) {
  return {
    /** Failed login attempts allowed per IP within the window (LOGIN_MAX_ATTEMPTS, default 10) */
    loginMax: envNumber(env.LOGIN_MAX_ATTEMPTS, 10, { min: 1 }),
    /** Login lock/sliding window in seconds (LOGIN_LOCK_WINDOW_SEC, default 900) */
    loginWindowSec: envNumber(env.LOGIN_LOCK_WINDOW_SEC, 900, { min: 1 }),
    /** Sign-ups allowed per IP within the window (SIGNUP_MAX_PER_WINDOW, default 10) */
    signupMax: envNumber(env.SIGNUP_MAX_PER_WINDOW, 10, { min: 1 }),
    /** Sign-up window in seconds (SIGNUP_WINDOW_SEC, default 60) */
    signupWindowSec: envNumber(env.SIGNUP_WINDOW_SEC, 60, { min: 1 }),
    /** Forgot-password attempts allowed per IP within the window (FORGOT_PASSWORD_MAX_ATTEMPTS, default 10) */
    forgotMax: envNumber(env.FORGOT_PASSWORD_MAX_ATTEMPTS, 10, { min: 1 }),
    /** Forgot-password window in seconds (FORGOT_PASSWORD_WINDOW_SEC, default 600) */
    forgotWindowSec: envNumber(env.FORGOT_PASSWORD_WINDOW_SEC, 600, { min: 1 }),
    /** Failed refresh-token attempts allowed per IP within the window (REFRESH_MAX_FAILURES, default 20) */
    refreshMax: envNumber(env.REFRESH_MAX_FAILURES, 20, { min: 1 }),
    /** Refresh-token failure window in seconds (REFRESH_WINDOW_SEC, default 60) */
    refreshWindowSec: envNumber(env.REFRESH_WINDOW_SEC, 60, { min: 1 }),
    /** Wrong session-unlock PIN attempts before the session is destroyed (PIN_MAX_ATTEMPTS, default 3) */
    pinMaxAttempts: envNumber(env.PIN_MAX_ATTEMPTS, 3, { min: 1 }),
    /** How long wrong-PIN attempts are tracked, in seconds (PIN_LOCK_WINDOW_SEC, default 900) */
    pinWindowSec: envNumber(env.PIN_LOCK_WINDOW_SEC, 900, { min: 1 }),
    /** WebAuthn / Passkey ceremony timeout in milliseconds (WEBAUTHN_TIMEOUT_MS, default 60000) */
    webauthnTimeoutMs: envNumber(env.WEBAUTHN_TIMEOUT_MS, 60000, { min: 1000 }),
  };
}
