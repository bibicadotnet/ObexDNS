/**
 * @file activeDns.ts
 * @description Records which profile a client is actually resolving through (DoH, DoT and UDP),
 * so the Setup page can verify the connection.
 *
 * Two signals are stored:
 *  1. verify_probe:<nonce> - written when the DNS query name is "obexv-<nonce>.<anything>".
 *     The Setup page looks up a unique random name with the browser's own resolver and then asks
 *     which profile received it. This is the authoritative check (no IP / NAT / IPv4-IPv6 dependence).
 *  2. active_dns:<ip>      - last profile seen from this IP. Only a fallback for hosts where a probe
 *     is impossible (IP or localhost), so it keeps the original short TTL and a single value.
 */

import type { Env } from '../types';
import { cacheUtils } from './cache';

const PROBE_RE = /^obexv-([a-z0-9]{16,32})\./i;
export const PROBE_NONCE_RE = /^[a-z0-9]{16,32}$/i;

const DEFAULT_ACTIVE_DNS_TTL = 60;
const PROBE_TTL = 120;

export type DnsTransport = 'doh' | 'dot' | 'udp';

export interface VerifyProbeRecord {
  profileId: string;
  transport: DnsTransport;
  ip: string;
}

/** Extracts the probe nonce (lowercased) from a query name, or null when it is not a probe. */
export function extractProbeNonce(qname: string | undefined | null): string | null {
  if (!qname) return null;
  const m = PROBE_RE.exec(qname);
  return m ? m[1].toLowerCase() : null;
}

// In-process stores. cacheUtils keys depend on the "current origin", which is global mutable state
// updated by every HTTP request; in Serverfull, DoT/UDP writes (no HTTP request) could land under a
// different key than the one the Setup page later reads. A process-local map is origin-independent,
// so it is authoritative in Serverfull (single process). The Cache API copy serves Cloudflare Workers.
// Probe records live in their own small map so that spoofed-source UDP traffic filling the per-IP map
// can never evict them.
interface Entry { value: unknown; expires: number }
const ipMem = new Map<string, Entry>();
const probeMem = new Map<string, Entry>();
const IP_MEM_MAX = 2000;
const PROBE_MEM_MAX = 500;

function memGet<T>(store: Map<string, Entry>, key: string): T | null {
  const e = store.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) {
    store.delete(key);
    return null;
  }
  return e.value as T;
}

function memSet(store: Map<string, Entry>, max: number, key: string, value: unknown, ttlSec: number): void {
  const now = Date.now();
  if (!store.has(key) && store.size >= max) {
    for (const [k, v] of store) if (now > v.expires) store.delete(k);
    while (store.size >= max) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }
  store.delete(key);
  store.set(key, { value, expires: now + ttlSec * 1000 });
}

function getCache(): Cache | null {
  return typeof caches !== 'undefined' ? ((caches as any).default ?? null) : null;
}

async function cacheRead<T>(key: string): Promise<T | null> {
  try {
    return await cacheUtils.get<T>(getCache(), key);
  } catch {
    return null;
  }
}

async function cacheWrite(key: string, value: unknown, ttlSec: number): Promise<void> {
  try {
    await cacheUtils.set(getCache(), key, value, ttlSec);
  } catch {
    // Cache API copy is best-effort
  }
}

/** Last profile ID seen from this client IP (fallback signal only). */
export async function getActiveProfileId(clientIp: string): Promise<string | null> {
  const key = `active_dns:${clientIp}`;
  return memGet<string>(ipMem, key) ?? (await cacheRead<string>(key));
}

/** Result of a verification probe, or null when the nonce was not seen. */
export async function getVerifyProbe(nonce: string): Promise<VerifyProbeRecord | null> {
  const key = `verify_probe:${nonce}`;
  return memGet<VerifyProbeRecord>(probeMem, key) ?? (await cacheRead<VerifyProbeRecord>(key));
}

/**
 * Records an active connection for the client IP and, for probe names, the nonce -> profile mapping.
 * Never throws; verification data is best-effort.
 */
export async function recordActiveConnection(
  env: Env,
  clientIp: string,
  profileId: string,
  qname: string | undefined | null,
  transport: DnsTransport
): Promise<void> {
  try {
    const nonce = extractProbeNonce(qname);
    if (nonce) {
      const rec: VerifyProbeRecord = { profileId, transport, ip: clientIp };
      const key = `verify_probe:${nonce}`;
      memSet(probeMem, PROBE_MEM_MAX, key, rec, PROBE_TTL);
      await cacheWrite(key, rec, PROBE_TTL);
    }

    // Hot path (runs for every DNS query): skip when this IP is already recorded for this profile
    // with more than half of the TTL left.
    const ttl = Number(env.ACTIVE_DNS_CACHE_TTL) || DEFAULT_ACTIVE_DNS_TTL;
    const ipKey = `active_dns:${clientIp}`;
    const e = ipMem.get(ipKey);
    if (e && e.value === profileId && e.expires - Date.now() > (ttl * 1000) / 2) return;

    memSet(ipMem, IP_MEM_MAX, ipKey, profileId, ttl);
    await cacheWrite(ipKey, profileId, ttl);
  } catch {
    // best-effort only
  }
}
