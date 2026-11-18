/**
 * @file ecs.ts
 * @description Client-side validation of EDNS Client Subnet input. Mirrors src/utils/ecsSubnet.ts
 * (the server remains the source of truth) so the UI can flag a bad value inline and show the
 * normalised form (default /24 or /48 appended to a bare IP) without a failed save round trip.
 */

export const DEFAULT_ECS_V4_PREFIX = 24;
export const DEFAULT_ECS_V6_PREFIX = 48;

export type EcsFamily = 4 | 6;

export type EcsCheck = { ok: true; value: string } | { ok: false };

function isIPv4(addr: string): boolean {
  const parts = addr.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && String(Number(p)) === p && Number(p) <= 255);
}

function isIPv6(addr: string): boolean {
  if (!addr.includes(":") || !/^[0-9a-fA-F:.]+$/.test(addr)) return false;
  const dbl = addr.split("::");
  if (dbl.length > 2) return false;

  let tailV4 = false;
  const groupsOf = (s: string): string[] | null => {
    if (s === "") return [];
    const gs = s.split(":");
    if (gs.some((g) => g === "")) return null;
    return gs;
  };
  const left = groupsOf(dbl[0]);
  const right = dbl.length === 2 ? groupsOf(dbl[1]) : [];
  if (!left || !right) return false;

  const all = dbl.length === 2 ? [...left, ...right] : left;
  const last = all[all.length - 1];
  if (last && last.includes(".")) {
    if (!isIPv4(last)) return false;
    tailV4 = true;
    all.pop();
  }
  if (!all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false;

  const count = all.length + (tailV4 ? 2 : 0);
  return dbl.length === 2 ? count <= 7 : count === 8;
}

/**
 * Validates a custom ECS subnet. A bare IP gets /24 (IPv4) or /48 (IPv6) appended.
 * Empty input is reported as `{ ok: true, value: "" }` so callers can decide whether it is allowed.
 */
export function checkEcsSubnet(raw: string, family: EcsFamily): EcsCheck {
  const input = raw.trim();
  if (!input) return { ok: true, value: "" };

  const parts = input.split("/");
  if (parts.length > 2) return { ok: false };

  const addr = parts[0].trim();
  if (family === 4 ? !isIPv4(addr) : !isIPv6(addr)) return { ok: false };

  const maxPrefix = family === 4 ? 32 : 128;
  let prefix = family === 4 ? DEFAULT_ECS_V4_PREFIX : DEFAULT_ECS_V6_PREFIX;
  if (parts.length === 2) {
    const p = parts[1].trim();
    if (!/^\d{1,3}$/.test(p)) return { ok: false };
    prefix = parseInt(p, 10);
    if (prefix > maxPrefix) return { ok: false };
  }

  return { ok: true, value: `${family === 6 ? addr.toLowerCase() : addr}/${prefix}` };
}
