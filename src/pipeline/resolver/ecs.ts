import { DNSQuery, ProfileSettings } from "../../types";
import {
  injectEcsIntoQuery,
  disableEcsInQuery,
  parseEcsCidr,
  formatEcsSubnet
} from "../../utils/dns";
import { ipv4ToNumeric, ipv6ToBigInt } from "../../utils/cidr";
import { isPublicInternetIP } from "../../utils/validator";
import { DEFAULT_ECS_V4_PREFIX, DEFAULT_ECS_V6_PREFIX } from "../../utils/ecsSubnet";
import { EcsApplicationResult } from "./types";

/** Cache scope used when use_client_ip is on but the client has no public IP (no ECS sent). */
const NO_ECS_SCOPE = "none";

/**
 * Normalizes a raw client IP into a plain IPv4 / IPv6 string, or null if it is not a
 * routable public address.
 *
 * - Brackets and zone ids are removed.
 * - IPv4-mapped IPv6 (::ffff:1.2.3.4, ::FFFF:1.2.3.4, ::ffff:102:304) becomes plain IPv4,
 *   so dual-stack listeners never produce a bogus "::/48" subnet.
 * - Loopback / private / reserved addresses (including the "127.0.0.1" fallback used when no
 *   header is present) return null: sending them as ECS makes the upstream pick a wrong region.
 */
export function normalizeClientIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (!ip) return null;

  if (ip.includes(":")) {
    const v = ipv6ToBigInt(ip);
    if (v === null) return null;
    if (v >> 32n === 0xffffn) {
      const n = Number(v & 0xffffffffn);
      ip = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
    }
  } else if (ipv4ToNumeric(ip) === null) {
    return null;
  }

  return isPublicInternetIP(ip) ? ip : null;
}

/**
 * Derives the masked ECS subnet (IPv4 /24, IPv6 /48 by default) of the request's client.
 * `cidr` is canonical and host bits are zeroed, so two clients in the same subnet yield the
 * same string. Returns null when the client has no usable public IP.
 */
export function clientEcsSubnet(request: Request): string | null {
  const ip = normalizeClientIp(request.headers.get("CF-Connecting-IP"));
  if (!ip) return null;
  const prefix = ip.includes(":") ? DEFAULT_ECS_V6_PREFIX : DEFAULT_ECS_V4_PREFIX;
  const subnet = parseEcsCidr(`${ip}/${prefix}`);
  return subnet ? formatEcsSubnet(subnet) : null;
}

/**
 * Cache scope of the request for per-client ECS answers.
 * Use it as a suffix of the DNS cache key: answers resolved with a client's subnet must only
 * be served to clients of the same subnet.
 */
export function ecsCacheScope(request: Request): string {
  return clientEcsSubnet(request) ?? NO_ECS_SCOPE;
}

/**
 * Evaluates and applies EDNS Client Subnet (RFC 7871) into the DNS wire-format query.
 *
 * ECS is written directly into the OPT RR of the wire format (not as a URL parameter),
 * for broad compatibility with upstreams (ControlD, NextDNS, ...).
 *
 * Guarantees:
 * - ECS disabled  -> the client's ECS is replaced by an ECS /0 opt-out (no subnet leak, and
 *                    upstreams such as Google do not add a subnet of their own).
 * - ECS enabled   -> the client's ECS is overwritten by the server-chosen subnet, or replaced
 *                    by the /0 opt-out when no valid subnet is available.
 * - Other EDNS data (DO bit, cookies, ...) is preserved.
 *
 * @param request - Inbound HTTP Request.
 * @param query - Parsed incoming DNS query.
 * @param settings - Current profile settings.
 * @returns The wire query to send, the applied subnet (for logging) and, when the answer
 *          depends on the client's own subnet, the cache scope it must be stored under.
 */
export function applyEcs(
  request: Request,
  query: DNSQuery,
  settings: ProfileSettings
): EcsApplicationResult {
  const cfg = settings.ecs;
  if (!cfg?.enabled) {
    return { queryRaw: disableEcsInQuery(query.raw) };
  }

  let ecs: string | undefined;
  let ecsScope: string | undefined;

  if (cfg.use_client_ip) {
    ecs = clientEcsSubnet(request) ?? undefined;
    ecsScope = ecs ?? NO_ECS_SCOPE;
  } else {
    const v4 = cfg.ipv4_cidr || undefined;
    const v6 = cfg.ipv6_cidr || undefined;
    if (query.type === "A") ecs = v4 || v6;
    else if (query.type === "AAAA") ecs = v6 || v4;
    else {
      // Other types (HTTPS, SVCB, ...): follow the family of the actual client.
      const clientIsV6 = (normalizeClientIp(request.headers.get("CF-Connecting-IP")) ?? "").includes(":");
      ecs = clientIsV6 ? v6 || v4 : v4 || v6;
    }
  }

  if (ecs) {
    const subnet = parseEcsCidr(ecs);
    if (subnet) {
      // Log the canonical, masked form rather than the raw input.
      ecs = formatEcsSubnet(subnet);
      return { queryRaw: injectEcsIntoQuery(query.raw, ecs), ecs, ecsScope };
    }
  }

  // No usable subnet: do not forward whatever the client attached, and tell the upstream not to add its own.
  return { queryRaw: disableEcsInQuery(query.raw), ecsScope };
}
