import type { Env } from "../types";

/**
 * Checks whether the current runtime environment is Serverfull (Node.js/standalone)
 * based on the presence of any SERVERFULL_* configuration variables.
 */
export function isServerfullEnv(env?: Env | Record<string, any> | null): boolean {
  if (!env || typeof env !== "object") return false;
  return Boolean(
    env.SERVERFULL !== undefined ||
    env.IS_SERVERFULL !== undefined ||
    env.SERVERFULL_DEFAULT_PROFILE_KEY !== undefined ||
    env.SERVERFULL_HOST !== undefined ||
    env.SERVERFULL_DOT_DOMAIN !== undefined ||
    env.SERVERFULL_HTTP_PORT !== undefined ||
    env.SERVERFULL_HTTPS_PORT !== undefined ||
    env.SERVERFULL_DB_PATH !== undefined
  );
}
