import { DNSQuery, ProfileSettings } from "../../types";
import { injectEcsIntoQuery } from "../../utils/dns";
import { EcsApplicationResult } from "./types";

/**
 * Evaluates and applies EDNS Client Subnet (RFC 7871) into the DNS wire-format query.
 *
 * ECS is injected directly into the wire format via OPT RR rather than as a URL query
 * parameter, ensuring broad compatibility with mainstream upstreams (ControlD, NextDNS, etc.).
 *
 * @param request - Inbound HTTP Request.
 * @param query - Parsed incoming DNS query.
 * @param settings - Current profile settings.
 * @returns Object containing the resulting wire query and the applied subnet string (if any).
 */
export function applyEcs(
  request: Request,
  query: DNSQuery,
  settings: ProfileSettings
): EcsApplicationResult {
  let ecs: string | undefined;
  let queryRaw = query.raw;

  if (settings.ecs?.enabled) {
    const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
    ecs = settings.ecs.use_client_ip
      ? `${clientIp}/${clientIp.includes(":") ? 48 : 24}`
      : query.type === "AAAA"
      ? settings.ecs.ipv6_cidr || settings.ecs.ipv4_cidr
      : settings.ecs.ipv4_cidr || settings.ecs.ipv6_cidr;

    if (ecs) {
      queryRaw = injectEcsIntoQuery(query.raw, ecs);
    }
  }

  return { queryRaw, ecs };
}
