import { Env } from '../types';
import { cacheUtils } from '../utils/cache';
import { PROBE_NONCE_RE, getActiveProfileId, getVerifyProbe } from '../utils/activeDns';
import { getPresetEchFrontingDomains } from '../utils/ech/constants';
import { fetchGeoIP, GeoIP } from '../utils/geoip';
import { isPublicInternetIP, isIPv4, isIPv6 } from '../utils/validator';
import { isServerfullEnv } from '../utils/serverfullEnv';
import { fetchWebsiteIcon, iconHitResponse, iconMissResponse, normalizeIconDomain } from '../utils/websiteIcon';
import {
  DEFAULT_SUBSTITUTE_DOMAIN,
  getPresetUpstreams,
  getPresetExternalFilters,
  getDefaultProfileFilterUrls
} from '../constants/presets';
import { systemListsManager } from '../lib/filtering/systemListsManager';

/**
 * Handles system/utility routes like /api/clientinfo and /api/substitute
 */
export async function handleSystemRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const cache = typeof caches !== 'undefined' ? (caches as any).default : null;

  if (url.pathname === '/api/clientinfo') {
    const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
    const connectedProfileId = await getActiveProfileId(clientIp);
    const cf = (request as any).cf;

    let country = cf?.country || request.headers.get("CF-IPCountry") || "";
    let countryCode = country;
    let region = cf?.region || request.headers.get("CF-Region") || "";
    let city = cf?.city || request.headers.get("CF-IPCity") || "";
    let timezone = cf?.timezone || request.headers.get("CF-Timezone") || "";
    let asn = cf?.asn ? Number(cf.asn) : (request.headers.get("CF-ASN") ? Number(request.headers.get("CF-ASN")) : 0);
    let asOrganization = cf?.asOrganization || request.headers.get("CF-AS-Org") || "";

    // If geolocation is missing (e.g. Serverfull mode or direct reverse proxy), resolve via GeoIP
    if (!country || country === "UNKNOWN" || country === "UN" || country === "XX") {
      if (!isPublicInternetIP(clientIp)) {
        country = "Private Network";
        countryCode = "LAN";
        region = "LAN";
        city = "Local";
        timezone = "UNKNOWN";
        asOrganization = "Private Network";
      } else {
        try {
          const geo = await fetchGeoIP(clientIp);
          if (geo) {
            country = geo.country || geo.country_code || "UNKNOWN";
            countryCode = geo.country_code || "UNKNOWN";
            region = geo.region || "UNKNOWN";
            city = geo.city || "UNKNOWN";
            timezone = geo.timezone || "UNKNOWN";
            asOrganization = geo.org || geo.isp || "UNKNOWN";
            if (!asn && geo.as) {
              const asnMatch = geo.as.match(/^AS(\d+)/i);
              if (asnMatch) asn = Number(asnMatch[1]);
            }
          }
        } catch (e) {
          console.warn(`[ClientInfo] Failed resolving geoip for ${clientIp}:`, e);
        }
      }
    }

    const isServerfull = isServerfullEnv(env);

    return new Response(JSON.stringify({
      ip: clientIp,
      country: country || "UNKNOWN",
      countryCode: countryCode || undefined,
      region: region || "UNKNOWN",
      city: city || "UNKNOWN",
      timezone: timezone || "UNKNOWN",
      asn: asn || 0,
      asOrganization: asOrganization || "UNKNOWN",
      connectedProfileId: connectedProfileId || null,
      substituteDomain: env.SUBSTITUTE_DOMAIN || DEFAULT_SUBSTITUTE_DOMAIN,
      dotDomain: env.SERVERFULL_DOT_DOMAIN || env.DOT_DOMAIN || null,
      isServerfull,
      mode: isServerfull ? 'serverfull' : 'cloudflare'
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Verification probe: which profile answered the unique "obexv-<nonce>" lookup made by the Setup page
  if (url.pathname === '/api/verify-probe') {
    const nonce = (url.searchParams.get('nonce') || '').toLowerCase();
    if (!PROBE_NONCE_RE.test(nonce)) {
      return new Response(JSON.stringify({ found: false }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const rec = await getVerifyProbe(nonce);
    return new Response(
      JSON.stringify(rec ? { found: true, profileId: rec.profileId, transport: rec.transport } : { found: false }),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
    );
  }

  if (url.pathname === '/api/substitute') {
    const subDomain = env.SUBSTITUTE_DOMAIN || DEFAULT_SUBSTITUTE_DOMAIN;
    let substituteDomainIp: string | null = null;
    let substituteDomainIpv6: string | null = null;

    const resolveRecord = async (type: 'A' | 'AAAA'): Promise<string | null> => {
      const dnsServers = [
        'https://cloudflare-dns.com/dns-query',
        'https://1.1.1.1/dns-query'
      ];
      for (const server of dnsServers) {
        try {
          const res = await fetch(`${server}?name=${subDomain}&type=${type}`, {
            headers: { 'Accept': 'application/dns-json' },
            signal: AbortSignal.timeout(3000)
          });
          if (res.ok) {
            const data = await res.json() as any;
            if (data?.Answer?.length > 0) {
              const record = data.Answer.find((a: any) => a.type === (type === 'A' ? 1 : 28));
              if (record?.data) {
                return record.data;
              }
            }
          }
        } catch (e) {
          console.error(`[Substitute Resolve] Failed resolving ${type} via ${server}:`, e);
        }
      }
      return null;
    };

    try {
      const [ip, ipv6] = await Promise.all([
        resolveRecord('A'),
        resolveRecord('AAAA')
      ]);
      substituteDomainIp = ip;
      substituteDomainIpv6 = ipv6;
    } catch (e) {
      console.error('[Substitute API] Error resolving substitute domain:', e);
    }

    return new Response(JSON.stringify({
      ip: substituteDomainIp,
      ipv6: substituteDomainIpv6
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (url.pathname === '/api/presets/upstreams') {
    const upstreams = getPresetUpstreams(env);
    return new Response(JSON.stringify(upstreams), { headers: { 'Content-Type': 'application/json' } });
  }

  if (url.pathname === '/api/presets/filters') {
    const filters = getPresetExternalFilters(env);
    // Enrich each preset with what the dropdown needs to explain it: the description parsed from the
    // list header (system lists) and whether the admin flagged it as a recommended default.
    try {
      if (env.DB) await systemListsManager.ensureLoaded(env.DB, false, env);
    } catch (e) {
      console.warn('[Presets] Failed to load system lists for preset descriptions:', e);
    }
    const defaultUrls = new Set(getDefaultProfileFilterUrls(env).map((u) => u.trim().toLowerCase()));
    const enriched = filters.map((f) => ({
      ...f,
      description: systemListsManager.getDescriptionByUrl(f.url) || null,
      is_default: defaultUrls.has(f.url.trim().toLowerCase())
    }));
    return new Response(JSON.stringify(enriched), { headers: { 'Content-Type': 'application/json' } });
  }

  if (url.pathname === '/api/presets/ech-fronting-domains') {
    const domains = getPresetEchFrontingDomains(env);
    return new Response(JSON.stringify(domains), { headers: { 'Content-Type': 'application/json' } });
  }

  if (url.pathname.startsWith('/api/icon/')) {
    // The client asks for "<domain>.ico"; the suffix is not part of the hostname.
    const host = normalizeIconDomain(url.pathname.slice('/api/icon/'.length));
    if (!host) {
      return new Response("Invalid domain format", { status: 400 });
    }

    // Both hits and misses are kept at the edge, so a busy log does not re-ask the icon providers.
    const cacheKey = new Request(`${url.origin}/api/icon/${host}.ico`);
    if (cache) {
      try {
        const cached = await cache.match(cacheKey);
        if (cached) return cached;
      } catch { /* cache unavailable: look it up */ }
    }

    const icon = await fetchWebsiteIcon(host);
    const response = icon ? iconHitResponse(icon) : iconMissResponse();
    if (cache) {
      try {
        await cache.put(cacheKey, response.clone());
      } catch { /* not cacheable here: still serve it */ }
    }
    return response;
  }

  if (url.pathname === '/api/geoip') {
    const rawIp = url.searchParams.get('ip');
    const connectingIp = request.headers.get("CF-Connecting-IP");
    const targetIp = (rawIp || connectingIp || "").trim();

    // Anything that is not a public IP must never be forwarded to the third-party provider.
    if (targetIp) {
      const isIpLiteral = isIPv4(targetIp) || isIPv6(targetIp.replace(/^\[|\]$/g, ''));
      if (targetIp.toLowerCase() === 'localhost' || (isIpLiteral && !isPublicInternetIP(targetIp))) {
        return new Response(JSON.stringify({
          success: true,
          ip: targetIp,
          city: 'Local',
          country: 'Private Network',
          flag: { emoji: '🛜' }
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (!isIpLiteral) {
        return new Response(JSON.stringify({ success: false, ip: targetIp }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    try {
      let geo: GeoIP | null = null;
      if (targetIp) {
        geo = await fetchGeoIP(targetIp);
      } else {
        // Query server's public egress IP via primary provider ip-api.com
        const res = await fetch('http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,isp,org,as,timezone,query', {
          signal: AbortSignal.timeout(3500)
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          if (data.status === 'success' && data.countryCode) {
            geo = {
              country: data.country,
              country_code: data.countryCode,
              region: data.regionName,
              city: data.city,
              isp: data.isp,
              org: data.org,
              as: data.as,
              timezone: data.timezone
            };
          }
        }
      }

      if (geo) {
        const emoji =
          geo.country_code && geo.country_code.length === 2
            ? String.fromCodePoint(...geo.country_code.toUpperCase().split('').map((c) => 127397 + c.charCodeAt(0)))
            : '';

        return new Response(
          JSON.stringify({
            success: true,
            ip: targetIp || (geo as any).query || 'server',
            country: geo.country,
            country_code: geo.country_code,
            region: geo.region,
            city: geo.city,
            timezone: { id: geo.timezone },
            connection: { org: geo.org || geo.isp, asn: geo.as },
            flag: { emoji }
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Secondary fallback: query ipwho.is if ip-api is unreachable
      const geoUrl = targetIp ? `https://ipwho.is/${encodeURIComponent(targetIp)}` : 'https://ipwho.is/';
      const geoRes = await fetch(geoUrl, {
        signal: AbortSignal.timeout(3500)
      });
      if (geoRes.ok) {
        const data = await geoRes.json();
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (e) {
      console.warn(`[System API] Failed resolving geoip for ${targetIp || 'server'}:`, e);
    }
    return new Response(JSON.stringify({ success: false, ip: targetIp || 'unknown' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (url.pathname === '/api/resolve') {
    const domain = url.searchParams.get('name') || url.searchParams.get('domain');
    if (!domain) {
      return new Response(JSON.stringify({ error: "Missing domain parameter" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Direct IPv4 check
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(domain)) {
      return new Response(JSON.stringify({ ipv4: [domain], ipv6: [] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Direct IPv6 check
    if (/^([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}$/.test(domain)) {
      return new Response(JSON.stringify({ ipv4: [], ipv6: [domain] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const resolveDoH = async (type: 'A' | 'AAAA'): Promise<string[]> => {
      const servers = ['https://cloudflare-dns.com/dns-query', 'https://1.1.1.1/dns-query'];
      for (const s of servers) {
        try {
          const res = await fetch(`${s}?name=${encodeURIComponent(domain)}&type=${type}`, {
            headers: { Accept: 'application/dns-json' },
            signal: AbortSignal.timeout(3000)
          });
          if (res.ok) {
            const data = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
            if (Array.isArray(data?.Answer) && data.Answer.length > 0) {
              const typeNum = type === 'A' ? 1 : 28;
              return data.Answer
                .filter((ans) => ans.type === typeNum && typeof ans.data === 'string')
                .map((ans) => ans.data);
            }
          }
        } catch {
          // Continue to next server
        }
      }
      return [];
    };

    try {
      let [ipv4, ipv6] = await Promise.all([
        resolveDoH('A'),
        resolveDoH('AAAA')
      ]);

      // In Node.js / Serverfull runtime, fallback to native DNS resolution if DoH returned empty
      if (ipv4.length === 0 && ipv6.length === 0 && typeof process !== 'undefined' && process.versions?.node) {
        try {
          const dnsPromises = await import('node:dns/promises');
          const [res4, res6] = await Promise.allSettled([
            dnsPromises.resolve4(domain),
            dnsPromises.resolve6(domain)
          ]);
          if (res4.status === 'fulfilled' && Array.isArray(res4.value)) {
            ipv4 = res4.value;
          }
          if (res6.status === 'fulfilled' && Array.isArray(res6.value)) {
            ipv6 = res6.value;
          }
        } catch {
          // Ignore native DNS lookup errors
        }
      }

      return new Response(JSON.stringify({ ipv4, ipv6 }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      console.error('DNS resolve failed:', e);
      return new Response(JSON.stringify({ ipv4: [], ipv6: [], error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response("Not Found", { status: 404 });
}
