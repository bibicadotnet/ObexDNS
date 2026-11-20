/**
 * @file localDbPolicy.ts
 * @description Decides whether the client-side SQLite copy of the logs is needed for a profile.
 *
 * The local copy was introduced to spare the server (D1 request limits). On a self-hosted server it is pure
 * overhead for a plain profile: it lags behind, lacks the DNS cache hits that the server counts, and its totals
 * differ from the server's. The only thing the server cannot do is read E2EE profiles (domains, client IPs
 * and countries are encrypted for it), so only those need the decrypted local copy.
 */

import { e2ee } from "./e2ee";

const TTL_MS = 60_000;
const cache = new Map<string, { needed: boolean; at: number }>();

/**
 * True when the profile has E2EE enabled, i.e. the local decrypted copy is the only readable source.
 * The answer is cached for a minute per profile; if the status cannot be read the server is used.
 */
export async function isLocalDbNeeded(profileId: string): Promise<boolean> {
  const hit = cache.get(profileId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.needed;
  let needed = false;
  try {
    const status = await e2ee.getStatus(profileId);
    needed = Boolean(status.enabled || status.hasKeys);
  } catch {
    needed = false;
  }
  cache.set(profileId, { needed, at: Date.now() });
  return needed;
}

/** Forget the cached answer (call after E2EE is enabled or disabled for the profile). */
export function resetLocalDbPolicy(profileId?: string): void {
  if (profileId) cache.delete(profileId);
  else cache.clear();
}
