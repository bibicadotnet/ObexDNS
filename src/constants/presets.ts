/**
 * @file presets.ts
 * @description Built-in canonical fallback presets and defaults for DNS Worker.
 * Ensures the system is fully functional out-of-the-box (zero-config) without external .env files.
 */

import { isSafeUrl } from "../utils/validator";

export interface PresetUpstream {
  label: string;
  url: string;
}

export interface PresetFilter {
  label: string;
  url: string;
}

/**
 * Built-in default preset upstream DNS servers.
 */
export const DEFAULT_PRESET_UPSTREAMS: readonly PresetUpstream[] = [
  { label: 'settings.presetCloudflareSecurity', url: 'https://security.cloudflare-dns.com/dns-query' },
  { label: 'settings.presetCloudflareFamilies', url: 'https://family.cloudflare-dns.com/dns-query' },
  { label: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { label: 'settings.presetQuad9', url: 'https://dns.quad9.net/dns-query' },
  { label: 'settings.presetQuad9Ecs', url: 'https://dns11.quad9.net/dns-query' },
  { label: 'settings.presetControlDFree', url: 'https://freedns.controld.com/no-ads-malware-typo' },
  { label: 'settings.presetControlDUncensored', url: 'https://freedns.controld.com/uncensored' },
  { label: 'settings.presetAdGuard', url: 'https://dns.adguard-dns.com/dns-query' },
  { label: 'settings.presetAdGuardFamily', url: 'https://family.adguard-dns.com/dns-query' },
  { label: 'Cloudflare Security (1.1.1.2)', url: 'tcp://1.1.1.2:53' },
  { label: 'Cloudflare (1.1.1.1)', url: 'tcp://1.1.1.1:53' },
  { label: 'Quad9 ECS (9.9.9.11)', url: 'tcp://9.9.9.11:9953' },
  { label: 'Google (8.8.8.8)', url: 'tcp://8.8.8.8:53' }
];

/**
 * Built-in default preset blocklists and external filters.
 */
export const DEFAULT_PRESET_EXTERNAL_FILTERS: readonly PresetFilter[] = [
  { label: 'filtering.presetOisdBig', url: 'https://big.oisd.nl' },
  { label: 'filtering.presetOisdNsfw', url: 'https://nsfw.oisd.nl' },
  { label: 'filtering.presetAdGuard', url: 'https://adguardteam.github.io/AdguardFilters/BaseFilter/sections/adservers.txt' },
  { label: 'filtering.presetStevenBlack', url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts' }
];

/**
 * Built-in default substitute domain for resolving DoH IPs.
 */
export const DEFAULT_SUBSTITUTE_DOMAIN = 'www.okx.com';

/**
 * Built-in default fail-open upstream address.
 */
export const DEFAULT_FAIL_OPEN_UPSTREAM = 'https://freedns.controld.com/no-ads-malware-typo';

/**
 * Resolves configured preset upstreams from environment variables or falls back to built-in presets.
 *
 * @param env - Worker or Serverfull environment bindings.
 * @returns Array of preset upstream objects.
 */
export function getPresetUpstreams(env?: { PRESET_UPSTREAMS?: string }): PresetUpstream[] {
  if (env?.PRESET_UPSTREAMS) {
    try {
      const parsed = JSON.parse(env.PRESET_UPSTREAMS);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
          .filter((item: unknown): item is PresetUpstream =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as Record<string, unknown>).url === 'string'
          )
          .map((item) => ({
            label: typeof item.label === 'string' ? item.label : item.url,
            url: item.url
          }));
      }
    } catch (e) {
      console.warn('[Presets] Failed to parse PRESET_UPSTREAMS from env:', e);
    }
  }
  return [...DEFAULT_PRESET_UPSTREAMS];
}

/**
 * Resolves the primary default upstream URL from environment PRESET_UPSTREAMS or built-in presets.
 * Used as initial upstream for newly created user profiles and default registration profiles.
 *
 * @param env - Worker or Serverfull environment bindings.
 * @returns Primary default upstream URL string.
 */
export function getDefaultUpstreamUrl(env?: { PRESET_UPSTREAMS?: string }): string {
  const upstreams = getPresetUpstreams(env);
  return upstreams[0]?.url || DEFAULT_PRESET_UPSTREAMS[0].url;
}

/**
 * Resolves configured preset external filters from environment variables or falls back to built-in presets.
 *
 * @param env - Worker or Serverfull environment bindings.
 * @returns Array of preset external filter objects.
 */
export function getPresetExternalFilters(env?: { PRESET_EXTERNAL_FILTERS?: string }): PresetFilter[] {
  if (env?.PRESET_EXTERNAL_FILTERS) {
    try {
      const parsed = JSON.parse(env.PRESET_EXTERNAL_FILTERS);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
          .filter((item: unknown): item is PresetFilter =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as Record<string, unknown>).url === 'string'
          )
          .map((item) => ({
            label: typeof item.label === 'string' ? item.label : item.url,
            url: item.url
          }));
      }
    } catch (e) {
      console.warn('[Presets] Failed to parse PRESET_EXTERNAL_FILTERS from env:', e);
    }
  }
  return [...DEFAULT_PRESET_EXTERNAL_FILTERS];
}

/**
 * Built-in default filter list URLs applied automatically to new user profiles and default registration profile.
 */
export const DEFAULT_PROFILE_FILTER_URLS: readonly string[] = [
  'https://lists.bibica.net/blocklists.txt',
  'https://lists.bibica.net/whitelist.txt',
  'https://lists.bibica.net/rewrites.txt'
];

/**
 * Resolves configured default profile filter list URLs from environment variable or falls back to built-in presets.
 * Supports comma-separated or newline-separated URL strings, or JSON array.
 *
 * @param env - Worker or Serverfull environment bindings.
 * @returns Array of sanitized filter list URL strings.
 */
export function getDefaultProfileFilterUrls(env?: { DEFAULT_PROFILE_FILTER_URLS?: string }): string[] {
  if (env?.DEFAULT_PROFILE_FILTER_URLS) {
    const raw = env.DEFAULT_PROFILE_FILTER_URLS.trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed
            .map((u: unknown) => (typeof u === 'string' ? u.trim() : ''))
            .filter((u: string) => u.length > 0 && isSafeUrl(u));
        }
      } catch (e) {
        console.warn('[Presets] Failed to parse DEFAULT_PROFILE_FILTER_URLS as JSON:', e);
      }
    }
    const splitUrls = raw
      .split(/[\r\n,]+/)
      .map((u) => u.trim())
      .filter((u) => u.length > 0 && isSafeUrl(u));
    if (splitUrls.length > 0) {
      return splitUrls;
    }
  }
  return [...DEFAULT_PROFILE_FILTER_URLS];
}
