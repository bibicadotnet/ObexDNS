/**
 * @file clientIp.ts
 * @description Client IP address sanitization, extraction, and proxy header validation.
 */

import { isIPv4, isIPv6, ipInCidr } from '../../utils/cidr';
import { isPublicInternetIP } from '../../utils/validator';
import { isCloudflareIp } from '../../utils/ech/cloudflareIp';

/**
 * Normalizes and validates an IP candidate string into a clean IPv4 or IPv6 address.
 * Handles bracketed IPv6, IPv4 port suffixes, IPv4-mapped IPv6 prefixes, and whitespace.
 */
export function sanitizeClientIp(candidate?: string | null): string | null {
  if (!candidate || typeof candidate !== 'string') return null;
  let ip = candidate.trim();
  if (!ip) return null;

  // Handle bracketed IPv6 with optional port: [2001:db8::1]:8080 or [2001:db8::1]
  if (ip.startsWith('[')) {
    const closeBracket = ip.indexOf(']');
    if (closeBracket > 1) {
      ip = ip.substring(1, closeBracket);
    }
  } else if (ip.includes(':') && ip.indexOf(':') === ip.lastIndexOf(':')) {
    // Single colon in string: likely IPv4 with port, e.g. "192.168.1.1:8080"
    const [hostPart, portPart] = ip.split(':');
    if (portPart && /^\d+$/.test(portPart) && isIPv4(hostPart)) {
      ip = hostPart;
    }
  }

  // Strip IPv4-mapped IPv6 prefix
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }

  if (isIPv4(ip) || isIPv6(ip)) {
    return ip;
  }
  return null;
}

/**
 * Checks whether an IP matches the optional trusted proxies configuration.
 * Entries may be single IPs or CIDR blocks (IPv4 / IPv6).
 */
export function isTrustedProxyIp(ip: string, trustedProxies?: string | string[]): boolean {
  if (!trustedProxies) return false;
  const list = Array.isArray(trustedProxies)
    ? trustedProxies
    : trustedProxies.split(',').map((p) => p.trim()).filter(Boolean);
  return list.some((entry) => entry === ip || (entry.includes('/') && ipInCidr(ip, entry)));
}

/**
 * Resolves the real client IP address from proxy headers (CF-Connecting-IP, X-Real-IP, X-Forwarded-For)
 * only when connecting through a trusted reverse proxy (loopback, private network, or configured trusted proxies).
 * If the connection arrives directly from a public Internet address, proxy headers are ignored to prevent spoofing (SEC-01).
 *
 * @param headers - HTTP request headers.
 * @param socketRemoteAddress - Underlying TCP socket remote address.
 * @param trustedProxies - Optional list or comma-separated string of trusted proxy IPs.
 * @returns Sanitized client IP address.
 */
export function extractClientIp(
  headers: Headers,
  socketRemoteAddress?: string,
  trustedProxies?: string | string[]
): string {
  const socketIp = sanitizeClientIp(socketRemoteAddress);

  // If socket IP is a public Internet IP and not explicitly configured in trusted proxies,
  // do not trust incoming proxy headers to prevent IP spoofing (CWE-290 / SEC-01).
  if (socketIp && isPublicInternetIP(socketIp)) {
    // Trust explicitly configured proxies, or synced Cloudflare & Bunny CDN edge IPs
    // (ranges kept in sync by daily cron) so that a proxied domain still yields the real client IP.
    const isTrusted = isTrustedProxyIp(socketIp, trustedProxies) || isCloudflareIp(socketIp);
    if (!isTrusted) {
      return socketIp;
    }
  }

  // 1. Check CF-Connecting-IP (Cloudflare Edge standard)
  const cfIp = sanitizeClientIp(headers.get('CF-Connecting-IP'));
  if (cfIp) return cfIp;

  // 2. Check Bunny CDN client IP headers (bunny-client-ip or b-cdn-client-ip)
  const bunnyIp = sanitizeClientIp(headers.get('bunny-client-ip') || headers.get('b-cdn-client-ip'));
  if (bunnyIp) return bunnyIp;

  // 3. Check X-Real-IP (Caddy / Nginx direct real IP)
  const realIp = sanitizeClientIp(headers.get('X-Real-IP'));
  if (realIp) return realIp;

  // 4. Check X-Forwarded-For (standard reverse proxy chain)
  const xff = headers.get('X-Forwarded-For');
  if (xff) {
    // The leftmost IP in X-Forwarded-For is the original client
    const ips = xff.split(',');
    for (const rawIp of ips) {
      const sanitized = sanitizeClientIp(rawIp);
      if (sanitized) return sanitized;
    }
  }

  // 5. Fallback to socket remote address
  return socketIp || '127.0.0.1';
}
