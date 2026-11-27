import { Env, User, ExecutionContext } from './types';
import { ScheduledEvent } from '@cloudflare/workers-types';
import { readCsrfCookie, createCsrfCookie, generateId } from './lib/auth';
import { generateLinuxSetupScript } from './utils/linuxSetup';
import { generateWindowsSetupScript } from './utils/windowsSetup';
import { generateAppleMobileConfig, formatProfileLabel } from './utils/appleSetup';
import { ACCESS_KEY_REGEX } from './utils/validator';

// Middleware imports
import { applySecurityHeaders, getCurrentUser, validateCsrf } from './lib/middleware';

// Route handlers
import { handleAuthRequest } from './api/auth';
import { handleProfilesRequest } from './api/profiles';
import { handleAccountRequest } from './api/account';
import { handleSystemRequest } from './api/system';
import { handleDoHRequest, resolveProfileByKey } from './api/doh';
import { handleScheduled } from './cron';
import { handleMapDataRequest } from './api/mapData';
import { isUsableJwtSecret } from './lib/jwt';
import { SystemSettingsModel } from './models/systemSettings';
import { isTursoConfigured, getTursoDatabase, getDatabaseService, ensureTursoMigrations } from './lib/turso';
import { cacheUtils } from './utils/cache';
import { migrateFilterFormatIfLegacy } from './utils/sync';
import { isServerfullEnv } from './utils/serverfullEnv';

let filterMigrationChecked = false;

const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onloadTurnstileCallback';
const TURNSTILE_HINT_TTL_MS = 60_000;
let turnstileHintCache: { value: boolean; expiresAt: number } | null = null;

/**
 * Whether Turnstile is enabled for login or signup (admin setting stored in the DB).
 * Only used as a loading hint (preconnect + early script download); the frontend still treats
 * /api/auth/config as the source of truth, so a briefly stale value is harmless.
 */
async function isTurnstileConfigured(env: Env): Promise<boolean> {
  const now = Date.now();
  if (turnstileHintCache && turnstileHintCache.expiresAt > now) return turnstileHintCache.value;
  let value = false;
  try {
    const settings = new SystemSettingsModel(env.DB);
    const [siteKey, onLogin, onSignup] = await Promise.all([
      settings.get('turnstile_site_key'),
      settings.get('turnstile_enabled_login'),
      settings.get('turnstile_enabled_signup')
    ]);
    value = !!siteKey && (onLogin === 'true' || onSignup === 'true');
  } catch {
    value = false;
  }
  turnstileHintCache = { value, expiresAt: now + TURNSTILE_HINT_TTL_MS };
  return value;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const isServerfull = isServerfullEnv(env);
    // Serverfull (Node) shares one process across all hosts, so a per-request global origin
    // causes cache key mismatches between concurrent requests on different domains.
    if (!isServerfull) {
      cacheUtils.setOrigin(new URL(request.url).origin);
    }
    const dbService = getDatabaseService(env, isServerfull);
    if (dbService === 'Turso' && isTursoConfigured(env)) {
      env.DB = getTursoDatabase(env);
    }

    if (!filterMigrationChecked && env.DB) {
      filterMigrationChecked = true;
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(migrateFilterFormatIfLegacy(env).catch(() => {}));
      }
    }

    const nonceBytes = new Uint8Array(16);
    crypto.getRandomValues(nonceBytes);
    const nonce = Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    let currentUser: User | null = null;

    const handleRequest = async (): Promise<Response> => {
      const url = new URL(request.url);

      // Map Data API Proxy
      if (url.pathname === '/world-110m.json') {
        return handleMapDataRequest(request, env, ctx);
      }

      // Business API Router
      if (url.pathname.startsWith('/api/')) {
        let isDbMissing = false;
        let dbErrorMessage = '';

        if (dbService === 'Turso') {
          if (!isTursoConfigured(env) || !env.DB) {
            isDbMissing = true;
            dbErrorMessage = 'DATABASE_SERVICE is set to Turso, but TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is not configured.';
          }
        } else if (dbService === 'File') {
          if (!isServerfull) {
            isDbMissing = true;
            dbErrorMessage = "DATABASE_SERVICE='File' is not supported in Cloudflare Workers. Please configure D1 database binding or use DATABASE_SERVICE='Turso'.";
          } else if (!env.DB) {
            isDbMissing = true;
            dbErrorMessage = 'Database file is missing. Please restart the service or verify file permissions.';
          }
        } else {
          // Default: 'D1'
          if (isServerfull) {
            isDbMissing = true;
            dbErrorMessage = "DATABASE_SERVICE='D1' is designed for Cloudflare Workers. In Serverfull mode, please set DATABASE_SERVICE='File' or 'Turso'.";
          } else {
            try {
              isDbMissing = !env.DB;
            } catch (e) {
              isDbMissing = true;
            }
          }
        }

        const isJwtSecretMissing = !isUsableJwtSecret(env.JWT_SECRET);

        if (isDbMissing || isJwtSecretMissing) {
          return new Response(JSON.stringify({
            error: "configuration_error",
            isDbMissing,
            isJwtSecretMissing,
            databaseService: dbService,
            message: dbErrorMessage || "DNS Worker is not fully configured. Please configure the database and JWT_SECRET secret variable."
          }), {
            status: 503,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }

        // Authenticate request
        currentUser = await getCurrentUser(request, env, ctx);

        const isPublicRoute = [
          '/api/auth/login', 
          '/api/auth/signup', 
          '/api/auth/prelogin', 
          '/api/auth/check-username',
          '/api/auth/config',
          '/api/auth/refresh',
          '/api/auth/logout',
          '/api/auth/unlock-session',
          '/api/clientinfo',
          '/api/verify-probe',
          '/api/substitute',
          '/api/resolve',
          '/api/geoip'
        ].includes(url.pathname) || 
        url.pathname.startsWith('/api/icon/') || 
        url.pathname.startsWith('/api/presets/') ||
        url.pathname.startsWith('/api/auth/forgot-password');

        // Check authentication boundary
        if (!currentUser && !isPublicRoute) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Handle paused sessions: block all routes except unlock, logout, refresh, and locale preference update
        if (currentUser && currentUser.isPaused) {
          const isAllowedWhilePaused = [
            '/api/auth/unlock-session',
            '/api/auth/logout',
            '/api/auth/refresh'
          ].includes(url.pathname) || (url.pathname === '/api/account/me' && request.method === 'PATCH');
          if (!isAllowedWhilePaused) {
            return new Response("session_paused", { status: 403 });
          }
        }

        // Validate CSRF for mutating requests
        if (currentUser && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !isPublicRoute) {
          if (!validateCsrf(request)) {
            return new Response("CSRF validation failed", { status: 403 });
          }
        }

        // Route requests to handlers
        if (url.pathname.startsWith('/api/auth/')) {
          return handleAuthRequest(request, env, ctx);
        }
        if (
          url.pathname === '/api/clientinfo' ||
          url.pathname === '/api/verify-probe' ||
          url.pathname === '/api/substitute' ||
          url.pathname === '/api/resolve' ||
          url.pathname === '/api/geoip' ||
          url.pathname.startsWith('/api/presets/') ||
          url.pathname.startsWith('/api/icon/')
        ) {
          return handleSystemRequest(request, env);
        }
        if (url.pathname.startsWith('/api/profiles')) {
          return handleProfilesRequest(request, env, currentUser, ctx);
        }
        if (url.pathname.startsWith('/api/account') || url.pathname.startsWith('/api/admin')) {
          return handleAccountRequest(request, env, currentUser!, ctx);
        }
        return new Response("API Not Found", { status: 404 });
      }

      // Linux Setup Script Route
      if (url.pathname === '/setup.sh') {
        const key = url.searchParams.get('key');
        if (!key || !ACCESS_KEY_REGEX.test(key)) {
          return new Response('Missing or invalid key parameter', { status: 400 });
        }
        const appName = url.searchParams.get('appName') || env.APP_NAME || 'DNS Shield';
        const script = generateLinuxSetupScript(url.origin, key, appName);
        return new Response(script, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache'
          }
        });
      }

      // Apple macOS / iOS / iPadOS / tvOS Setup Profile (.mobileconfig) Route
      if (url.pathname === '/apple' || url.pathname === '/setup.mobileconfig' || url.pathname === '/apple.mobileconfig') {
        const key = url.searchParams.get('key') || undefined;
        if (key && !ACCESS_KEY_REGEX.test(key)) {
          return new Response('Invalid key parameter', { status: 400 });
        }
        const appName = url.searchParams.get('appName') || env.APP_NAME || 'DNS Shield';
        let profileName = url.searchParams.get('name') || undefined;
        let accessPointName = url.searchParams.get('ap') || undefined;

        if (key && (!profileName || !accessPointName)) {
          try {
            const matchedProfile = await resolveProfileByKey(key, env, ctx);
            if (matchedProfile) {
              profileName = profileName || matchedProfile.name;
              accessPointName = accessPointName || matchedProfile.access_point_name || undefined;
            }
          } catch {
            // ignore lookup error
          }
        }

        const origin = url.searchParams.get('origin') || url.origin;
        const xml = generateAppleMobileConfig({
          origin,
          key,
          profileName,
          accessPointName,
          appName
        });
        const appPrefix = appName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        const domain = new URL(origin).hostname;
        const label = formatProfileLabel(profileName, accessPointName, appName);
        const fileTag =
          (label || domain)
            .replace(/[^\p{L}\p{N}_-]/gu, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '') || 'profile';
        const filename = key
          ? `${appPrefix}-${fileTag}-${key}.mobileconfig`
          : `${appPrefix}-default.mobileconfig`;

        return new Response(xml, {
          headers: {
            'Content-Type': 'application/x-apple-aspen-config; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-cache'
          }
        });
      }

      // Windows Setup PowerShell Script Route
      if (url.pathname === '/setup.ps1') {
        // key is optional: without it the script installs the default profile (DoH /dns-query + DoT on dot.<domain>).
        const key = url.searchParams.get('key') || undefined;
        if (key && !ACCESS_KEY_REGEX.test(key)) {
          return new Response('# Invalid key parameter', { status: 400 });
        }
        const origin = url.searchParams.get('origin') || url.origin;
        // DoT hostname follows the domain the user opened (same as the DoH upstream), so the installed config
        // is consistent. SERVERFULL_DOT_DOMAIN is only the fallback when the origin is an IP / localhost.
        // The TLS certificate must cover <key>.<that domain> (wildcard SAN) and bare <that domain>.
        let dotDomain = '';
        try {
          const h = new URL(origin).hostname.toLowerCase();
          if (h.includes('.') && !h.includes(':') && !/^[\d.]+$/.test(h)) dotDomain = h;
        } catch { /* invalid origin: fall back to env below */ }
        if (!dotDomain) dotDomain = env.SERVERFULL_DOT_DOMAIN || env.DOT_DOMAIN || '';
        const toolsUrl = env.WINDOWS_TOOLS_URL || 'https://github.com/bibicadotnet/ObexDNS/releases/download/windows-tools-setup/windows-tools-setup.zip';
        // Hosts whose earlier Windows installs (C:\<host-slug>-doh) are removed before the new install.
        const cleanupHosts = (env.WINDOWS_CLEANUP_HOSTS || 'user.bibica.net,dns.bibica.net,doh.bibica.net')
          .split(',').map((h: string) => h.trim()).filter(Boolean);
        const script = generateWindowsSetupScript({
          origin,
          key,
          dotDomain,
          packageUrl: toolsUrl,
          cleanupHosts
        });
        return new Response(script, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache'
          }
        });
      }

      // Dynamic PWA Web Manifest Route (reflects runtime APP_NAME)
      if (url.pathname === '/manifest.webmanifest') {
        const appName = env.APP_NAME || 'DNS Shield';
        const manifestObj = {
          name: appName,
          short_name: appName,
          theme_color: '#1a1b26',
          icons: []
        };
        return new Response(JSON.stringify(manifestObj), {
          headers: {
            'Content-Type': 'application/manifest+json; charset=utf-8',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      }

      // DNS-over-HTTPS (DoH) Route: /<5-12 char profile key or access point token> or canonical /dns-query
      const rawKey = url.pathname.slice(1); 
      const isKeyValid = ACCESS_KEY_REGEX.test(rawKey);
      const isDnsQueryPath = url.pathname === '/dns-query';
      const isDoHRequest = request.method === 'POST' || 
                           url.searchParams.has('dns') || 
                           request.headers.get('accept')?.includes('dns-message');
                            
      if ((isKeyValid || isDnsQueryPath) && (isDoHRequest || request.method === 'OPTIONS')) {
        if (request.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Accept',
              'Access-Control-Max-Age': '86400'
            }
          });
        }
        return handleDoHRequest(request, env, ctx, isDnsQueryPath ? '' : rawKey);
      }

      // Static Assets Hosting with Single Page App (SPA) fallback
      try {
        let response = await (env as any).ASSETS.fetch(request);
        if (response.status === 404 && !url.pathname.startsWith('/assets/') && (request.method === 'GET' || request.method === 'HEAD')) {
          response = await (env as any).ASSETS.fetch(new Request(url.origin + '/', {
            method: request.method,
            headers: request.headers
          }));
        }

        // Ensure WASM binary assets are served with the standard MIME type
        if (url.pathname.endsWith('.wasm')) {
          const wasmHeaders = new Headers(response.headers);
          wasmHeaders.set('Content-Type', 'application/wasm');
          wasmHeaders.set('Cross-Origin-Resource-Policy', 'same-origin');
          wasmHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: wasmHeaders
          });
        }

        // Cache hashed assets aggressively
        if (url.pathname.startsWith('/assets/')) {
          const assetHeaders = new Headers(response.headers);
          assetHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: assetHeaders
          });
        }

        const contentType = response.headers.get('Content-Type') || '';
        if (contentType.includes('text/html')) {
          let isDbMissing = false;
          if (dbService === 'Turso') {
            isDbMissing = !isTursoConfigured(env) || !env.DB;
          } else if (dbService === 'File') {
            isDbMissing = !isServerfull || !env.DB;
          } else {
            isDbMissing = isServerfull || !env.DB;
          }
          const isJwtSecretMissing = !isUsableJwtSecret(env.JWT_SECRET);

          let configStr = "{}";
          try {
             configStr = JSON.stringify({
               nonce,
               isDbMissing,
               isJwtSecretMissing,
               isServerfull,
               databaseService: dbService,
               isTurso: dbService === 'Turso',
               mode: isServerfull ? 'serverfull' : 'cloudflare',
               appName: env.APP_NAME || 'DNS Shield',
               appLogoUrl: env.APP_LOGO_URL || '',
               appFaviconUrl: env.APP_FAVICON_URL || '/favicon.png',
               githubCornerEnabled: env.GITHUB_CORNER_ENABLED !== 'false' && env.GITHUB_CORNER_ENABLED !== false,
               githubCornerUrl: env.GITHUB_CORNER_URL || 'https://github.com/bibicadotnet/ObexDNS'
             });
          } catch (e) { }
          
          // Visitors without a session are about to see the login/signup form. If Turnstile is enabled,
          // start connecting to and downloading it right away (in parallel with the app bundle) instead
          // of waiting for the app to boot and fetch /api/auth/config first.
          let turnstileHead = '';
          if (!isDbMissing && !isJwtSecretMissing && !readCsrfCookie(request.headers.get('Cookie'))) {
            if (await isTurnstileConfigured(env)) {
              turnstileHead =
                `<link rel="preconnect" href="https://challenges.cloudflare.com">` +
                `<script nonce="${nonce}">window.onloadTurnstileCallback=function(){};</script>` +
                `<script nonce="${nonce}" src="${TURNSTILE_SCRIPT_URL}" async defer></script>`;
            }
          }

          return new HTMLRewriter()
            .on('head', {
              element(element) {
                element.prepend(`<script nonce="${nonce}">window.DNS_WORKER_CONFIG = ${configStr};</script>${turnstileHead}`, { html: true });
              }
            })
            .transform(response);
        }

        return response;
      } catch (e) {
        return new Response("Asset Fetch Error", { status: 500 });
      }
    };

    let response = await handleRequest().catch((err: any) => {
      console.error("[Worker] Unhandled error in handleRequest:", err?.message || err);
      return new Response(JSON.stringify({ error: "internal_server_error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    });
    
    // Ensure CSRF token is set in cookies if authenticated but cookie is missing from the request
    const finalUser = currentUser as User | null;
    if (finalUser && !readCsrfCookie(request.headers.get("Cookie"))) {
      const isKeepLoggedIn = finalUser.sessionId?.startsWith("k_");
      try {
        const csrfToken = generateId(32);
        response.headers.append("Set-Cookie", createCsrfCookie(csrfToken, env, isKeepLoggedIn));
      } catch (e) {
        // If headers are immutable (e.g. from static asset fetch), clone the response and set the header
        const newHeaders = new Headers(response.headers);
        const csrfToken = generateId(32);
        newHeaders.append("Set-Cookie", createCsrfCookie(csrfToken, env, isKeepLoggedIn));
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      }
    }

    // DoH binary responses must not be constrained by HTML CSP/COOP/COEP
    if (response.headers.get('Content-Type')?.includes('application/dns-message')) {
      const dohHeaders = new Headers(response.headers);
      dohHeaders.set('Access-Control-Allow-Origin', '*');
      dohHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      dohHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: dohHeaders
      });
    }

    return applySecurityHeaders(response, nonce, new URL(request.url).hostname);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.SUBSTITUTE_DOMAIN && !isServerfullEnv(env)) {
      cacheUtils.setOrigin(`https://${env.SUBSTITUTE_DOMAIN}`);
    }
    const dbService = getDatabaseService(env, false);
    if (dbService === 'Turso' && isTursoConfigured(env)) {
      env.DB = getTursoDatabase(env);
      try {
        await ensureTursoMigrations(env.DB as any);
      } catch (err: any) {
        console.warn('[Turso] Scheduled migration check notice:', err.message || err);
      }
    }
    await migrateFilterFormatIfLegacy(env);
    await handleScheduled(event, env, ctx);
  }
};
