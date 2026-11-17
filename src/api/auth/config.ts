import { Env } from "../../types";
import { UserModel } from "../../models/user";
import { SystemSettingsModel } from "../../models/systemSettings";
import { USERNAME_REGEX } from "../../utils/validator";

/**
 * Handle public authentication configuration and checks
 */
export async function handleAuthConfigRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userModel = new UserModel(env.DB, env);

  // 公开配置接口
  if (url.pathname === '/api/auth/config' && request.method === 'GET') {
    const settingsModel = new SystemSettingsModel(env.DB);
    const [siteKey, signupEnabled, loginEnabled, hasUsers, registrationEnabled, dbAppName, dbLogoUrl, dbFaviconUrl, dbGhEnabled, dbGhUrl] = await Promise.all([
      settingsModel.get('turnstile_site_key'),
      settingsModel.get('turnstile_enabled_signup'),
      settingsModel.get('turnstile_enabled_login'),
      userModel.isEmpty().then((empty) => !empty).catch(() => false),
      settingsModel.get('registration_enabled'),
      settingsModel.get('app_name'),
      settingsModel.get('app_logo_url'),
      settingsModel.get('app_favicon_url'),
      settingsModel.get('github_corner_enabled'),
      settingsModel.get('github_corner_url')
    ]);

    const appName = dbAppName || env.APP_NAME || 'DNS Worker';
    const appLogoUrl = dbLogoUrl || env.APP_LOGO_URL || '';
    const appFaviconUrl = dbFaviconUrl || env.APP_FAVICON_URL || '';
    const ghEnabled = dbGhEnabled !== null
      ? dbGhEnabled !== 'false'
      : (env.GITHUB_CORNER_ENABLED !== 'false' && env.GITHUB_CORNER_ENABLED !== false);
    const ghUrl = dbGhUrl || env.GITHUB_CORNER_URL || 'https://github.com/Obein/DNS-Worker';

    return new Response(JSON.stringify({
      turnstile_site_key: siteKey,
      turnstile_enabled_signup: signupEnabled === 'true',
      turnstile_enabled_login: loginEnabled === 'true',
      optional_session_expiration_days: Number(env.OPTIONAL_SESSION_EXPIRATION_DAYS) || 7,
      has_users: hasUsers,
      registration_enabled: registrationEnabled !== 'false',
      app_name: appName,
      app_logo_url: appLogoUrl,
      app_favicon_url: appFaviconUrl,
      github_corner_enabled: ghEnabled,
      github_corner_url: ghUrl
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': hasUsers ? 'public, max-age=300, s-maxage=300' : 'no-store, no-cache'
      }
    });
  }

  // 检查用户名是否存在接口
  if (url.pathname === '/api/auth/check-username' && request.method === 'GET') {
    const username = url.searchParams.get('username') || '';
    if (!USERNAME_REGEX.test(username)) {
      return new Response(JSON.stringify({ error: "Invalid username" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const exists = await userModel.getByUsername(username);
    return new Response(JSON.stringify({ exists: !!exists }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response("Not Found", { status: 404 });
}
