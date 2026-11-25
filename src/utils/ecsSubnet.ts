/**
 * @file ecsSubnet.ts
 * @description Validation and normalisation of user supplied EDNS Client Subnet (RFC 7871) values.
 *
 * Users may type either a bare address ("1.2.3.4", "2001:db8::") or a full CIDR
 * ("1.2.3.0/24", "2001:db8::/32"). A bare address gets the default source prefix
 * (/24 for IPv4, /48 for IPv6 - the same defaults applied to the client IP in
 * pipeline/resolver/ecs.ts). Anything else is rejected instead of being silently stored
 * and then silently ignored at resolve time.
 */

import { isIPv4, isIPv6 } from "./cidr";

export const DEFAULT_ECS_V4_PREFIX = 24;
export const DEFAULT_ECS_V6_PREFIX = 48;

export type EcsSubnetResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validates a single ECS subnet and returns it in canonical "address/prefix" form.
 *
 * @param raw - Raw user input (non-empty).
 * @param family - Required address family.
 */
export function normalizeEcsSubnet(raw: string, family: 4 | 6): EcsSubnetResult {
  const input = String(raw ?? "").trim();
  const example = family === 4 ? "1.2.3.4 or 1.2.3.0/24" : "2001:db8:: or 2001:db8::/32";
  const label = family === 4 ? "IPv4" : "IPv6";
  const maxPrefix = family === 4 ? 32 : 128;

  if (!input) {
    return { ok: false, error: `Invalid ${label} subnet. Example: ${example}` };
  }

  const parts = input.split("/");
  if (parts.length > 2) {
    return { ok: false, error: `Invalid ${label} subnet "${input}". Example: ${example}` };
  }

  const addr = parts[0].trim();
  const validAddr = family === 4 ? isIPv4(addr) : isIPv6(addr) && addr.includes(":");
  if (!validAddr) {
    return { ok: false, error: `Invalid ${label} address "${addr}". Example: ${example}` };
  }

  let prefix: number;
  if (parts.length === 1) {
    prefix = family === 4 ? DEFAULT_ECS_V4_PREFIX : DEFAULT_ECS_V6_PREFIX;
  } else {
    const prefixStr = parts[1].trim();
    if (!/^\d{1,3}$/.test(prefixStr)) {
      return { ok: false, error: `Invalid prefix length "${prefixStr}" for ${label} subnet.` };
    }
    prefix = parseInt(prefixStr, 10);
    if (prefix > maxPrefix) {
      return { ok: false, error: `Prefix length must be between 0 and ${maxPrefix} for ${label}.` };
    }
  }

  return { ok: true, value: `${family === 6 ? addr.toLowerCase() : addr}/${prefix}` };
}

export interface EcsSettingsInput {
  enabled?: unknown;
  use_client_ip?: unknown;
  ipv4_cidr?: unknown;
  ipv6_cidr?: unknown;
}

export type EcsSettingsResult =
  | { ok: true; value: { enabled: boolean; use_client_ip: boolean; ipv4_cidr?: string; ipv6_cidr?: string } }
  | { ok: false; error: string };

/**
 * Validates the whole `ecs` block of profile settings.
 *
 * - Non-empty custom subnets must be valid for their family (and are normalised).
 * - When ECS is enabled with a custom subnet (use_client_ip = false), at least one subnet is required.
 */
export function validateEcsSettings(ecs: EcsSettingsInput): EcsSettingsResult {
  if (!ecs || typeof ecs !== "object") {
    return { ok: false, error: "Invalid ECS settings." };
  }

  const enabled = Boolean(ecs.enabled);
  const useClientIp = ecs.use_client_ip === undefined ? true : Boolean(ecs.use_client_ip);

  const out: { enabled: boolean; use_client_ip: boolean; ipv4_cidr?: string; ipv6_cidr?: string } = {
    enabled,
    use_client_ip: useClientIp,
  };

  const rawV4 = typeof ecs.ipv4_cidr === "string" ? ecs.ipv4_cidr.trim() : "";
  const rawV6 = typeof ecs.ipv6_cidr === "string" ? ecs.ipv6_cidr.trim() : "";

  if (rawV4) {
    const r = normalizeEcsSubnet(rawV4, 4);
    if (!r.ok) return r;
    out.ipv4_cidr = r.value;
  }
  if (rawV6) {
    const r = normalizeEcsSubnet(rawV6, 6);
    if (!r.ok) return r;
    out.ipv6_cidr = r.value;
  }

  if (enabled && !useClientIp && !out.ipv4_cidr && !out.ipv6_cidr) {
    return {
      ok: false,
      error: "Custom ECS subnet is enabled but no subnet was provided. Enter an IPv4 and/or IPv6 subnet.",
    };
  }

  return { ok: true, value: out };
}
