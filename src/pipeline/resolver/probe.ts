import { buildDNSQuery } from "../../utils/dns";
import { fetchFromUpstream, resolveUpstreamEndpoint } from "./transport";
import { UpstreamHttpError } from "./types";

/** Well-known, always-resolvable name used to verify an upstream actually answers DNS queries. */
const PROBE_DOMAIN = "cloudflare.com";

export type UpstreamProbeResult =
  | { ok: true; latency: number }
  | { ok: false; error: string };

/**
 * Sends one real DNS query through the same transport the resolver uses (DoH / DoT / TCP / DNS Stamp)
 * and checks that the upstream returned a well-formed, successful DNS response.
 *
 * Used when a profile's upstream is changed so that a URL that merely *looks* valid
 * (e.g. a DoH host missing its "/dns-query" path, answering HTTP 403) is rejected
 * instead of being saved and breaking every query of the profile.
 *
 * @param rawUpstreamUrl - Upstream as typed by the user (already SSRF-checked by the caller).
 */
export async function probeUpstream(rawUpstreamUrl: string): Promise<UpstreamProbeResult> {
  const PROBE_TIMEOUT_MS = 3500;
  let timer: any = null;

  const probeExecution = async (): Promise<UpstreamProbeResult> => {
    const startedAt = Date.now();
    try {
      const endpoint = resolveUpstreamEndpoint(rawUpstreamUrl);
      const query = buildDNSQuery(PROBE_DOMAIN, "A");
      const res = await fetchFromUpstream(endpoint, query);
      const answer = res.answer;

      if (!answer || answer.length < 12) {
        return { ok: false, error: "Upstream returned an empty or malformed DNS response." };
      }
      // Transaction ID must echo our query, and QR bit must mark it as a response.
      if (answer[0] !== query[0] || answer[1] !== query[1] || (answer[2] & 0x80) === 0) {
        return { ok: false, error: "Upstream did not return a valid DNS response." };
      }
      const rcode = answer[3] & 0x0f;
      if (rcode !== 0) {
        return {
          ok: false,
          error: `Upstream answered the test query with DNS RCODE ${rcode} (expected NOERROR).`,
        };
      }
      return { ok: true, latency: Date.now() - startedAt };
    } catch (e: unknown) {
      if (e instanceof UpstreamHttpError) {
        let msg = `Upstream returned HTTP ${e.status}${e.statusText ? ` ${e.statusText}` : ""}.`;
        if (/^https?:\/\//i.test(rawUpstreamUrl)) {
          try {
            const path = new URL(rawUpstreamUrl).pathname;
            if (path === "" || path === "/") {
              msg += " The DoH URL has no path; most providers require one (for example /dns-query).";
            }
          } catch {
            // ignore parse failure, generic message is enough
          }
        }
        return { ok: false, error: msg };
      }
      const detail = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Upstream did not respond to a test query: ${detail}` };
    }
  };

  const timeoutPromise = new Promise<UpstreamProbeResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        error: "Upstream did not respond to a test query: The operation was aborted due to timeout"
      });
    }, PROBE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([probeExecution(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
