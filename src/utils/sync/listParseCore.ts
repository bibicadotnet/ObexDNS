/**
 * @file listParseCore.ts
 * @description Pure CPU + network half of a list sync: download, parse, hash, sort and serialize a filter
 * list. It touches no database and no shared module state, so it can run on a worker thread
 * (listParseWorker.ts) or inline as a fallback. Previously this code was duplicated in
 * singleListSync.ts and systemListSync.ts and ran on the DNS thread.
 */

import { FingerprintSetBuilder } from "../fingerprintSet";
import { fetchListContent, FetchListOptions } from "../listFetcher";
import { AdGuardRuleKind, AdGuardPayload, ParsedAdGuardRule } from "../../lib/adguard";

/** Plain data only: it crosses a thread boundary via structured clone. */
export interface ListParseParams {
  url: string;
  maxListBytes: number;
  timeoutMs: number;
  maxListDomains: number;
  maxRegexRules: number;
  /** Conditional-request validators; only set when the stored filter is current. */
  etag?: string | null;
  lastModified?: string | null;
  tuning: Pick<FetchListOptions, "maxRetries" | "retryDelayMs" | "maxRedirects">;
  yieldBatchSize: number;
  yieldSleepMs: number;
}

export interface ListParseResult {
  fetchError: string | null;
  truncated: boolean;
  notModified: boolean;
  etag?: string | null;
  lastModified?: string | null;
  title?: string | null;
  description?: string | null;
  /** Rules accepted (domains, exceptions, rewrites, regex). */
  count: number;
  domainLimitHit: boolean;
  regexLimitHit: boolean;
  /** Serialized FingerprintSet (standalone buffer), or null when the list produced no domains / was not built. */
  filterBytes: Uint8Array | null;
  adguardPayload: AdGuardPayload;
}

export async function parseListCore(p: ListParseParams): Promise<ListParseResult> {
  const filterBuilder = new FingerprintSetBuilder();
  const adguardPayload: AdGuardPayload = { exceptions: [], rewrites: {}, patterns: [] };

  let count = 0;
  let domainsSinceYield = 0;
  let domainLimitHit = false;
  let regexLimitHit = false;
  const { maxListDomains, maxRegexRules, yieldBatchSize, yieldSleepMs } = p;

  // Fast-path: hash simple ||domain^ and plain domain lines directly without parseAdGuardLine
  const fastPath = (line: string): boolean => {
    if (line.length === 0) return true; // skip empty

    const first = line.charCodeAt(0);

    // Skip comments: '!' (33), '#' (35), '[' (91) — no need for parser
    if (first === 33 || first === 35 || first === 91) return true;

    // Skip exceptions: '@@' (64, 64) — need parser for adguardPayload
    if (first === 64 && line.charCodeAt(1) === 64) return false;

    // Skip regex: '/' (47) — need parser
    if (first === 47) return false;

    // Skip cosmetic: '##' — need parser to mark as UNSUPPORTED
    if (first === 35 && line.charCodeAt(1) === 35) return false;
    // Also check for '#@#' and '#?#'
    if (line.includes('##') || line.includes('#@#') || line.includes('#?#')) return false;

    if (count >= maxListDomains) {
      domainLimitHit = true;
      return true; // handled (skip)
    }

    // ||domain^ fast path
    if (first === 124 && line.charCodeAt(1) === 124) {
      // Check for $, *, #, /, \ in the rest — if found, need parser
      let end = line.length;
      let hasSpecial = false;
      for (let j = 2; j < line.length; j++) {
        const c = line.charCodeAt(j);
        if (c === 94) { end = j; break; }  // '^'
        if (c === 36 || c === 42 || c === 35 || c === 47 || c === 92) { hasSpecial = true; break; }
      }
      if (!hasSpecial && end > 2) {
        filterBuilder.addPipePipeFromLine(line, 2, end);
        count++;
        return true;
      }
      return false; // complex || rule — need parser
    }

    // Single pipe | — rare, let parser handle
    if (first === 124) return false;

    // Hosts format: digit + space + domain (e.g., "0.0.0.0 example.com")
    if (first >= 48 && first <= 57) {
      let spaceIdx = -1;
      for (let j = 0; j < line.length; j++) {
        if (line.charCodeAt(j) === 32) { spaceIdx = j; break; }
      }
      if (spaceIdx === -1) return false; // no space — might be plain domain starting with digit
      // Check if prefix is IP-like (has dots and digits only)
      let isIpLike = true;
      for (let j = 0; j < spaceIdx; j++) {
        const c = line.charCodeAt(j);
        if (c !== 46 && (c < 48 || c > 57) && c !== 58) { isIpLike = false; break; }
      }
      if (isIpLike && spaceIdx > 6) {
        // Find domain end (next whitespace or \r or end)
        let dEnd = line.length;
        for (let j = spaceIdx + 1; j < line.length; j++) {
          const c = line.charCodeAt(j);
          if (c === 32 || c === 13) { dEnd = j; break; }
        }
        if (dEnd > spaceIdx + 1) {
          // Check for localhost/0.0.0.0/127.0.0.1 — skip those
          const d = line.substring(spaceIdx + 1, dEnd).toLowerCase();
          if (d !== 'localhost' && d !== '0.0.0.0' && d !== '127.0.0.1') {
            filterBuilder.addFromLine(line, spaceIdx + 1, dEnd);
            count++;
          }
          return true;
        }
      }
      // Not hosts format — fall through to plain domain check
    }

    // Plain domain fast path
    let end = line.length;
    let hasSpecial = false;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c === 94 || c === 36) { end = j; break; }  // '^' or '$'
      if (c === 42 || c === 35 || c === 47 || c === 92 || c === 124) { hasSpecial = true; break; }
    }
    if (!hasSpecial && end > 0) {
      filterBuilder.addFromLine(line, 0, end);
      count++;
      return true;
    }

    return false; // complex — need parser
  };

  const { error: fetchError, truncated, notModified, etag, lastModified, title, description } = await fetchListContent(
    p.url,
    p.maxListBytes,
    p.timeoutMs,
    (rule: ParsedAdGuardRule) => {
      if (count < maxListDomains) {
        if (rule.kind === AdGuardRuleKind.BLOOM_DOMAIN && rule.domain) {
          if (rule.includeSubdomains) {
            filterBuilder.addPipePipe(rule.domain);
          } else {
            filterBuilder.add(rule.domain);
          }
          count++;
        } else if (rule.kind === AdGuardRuleKind.EXCEPTION && rule.domain) {
          adguardPayload.exceptions.push({
            domain: rule.domain,
            includeSubdomains: Boolean(rule.includeSubdomains),
            raw: rule.raw
          });
          count++;
        } else if (rule.kind === AdGuardRuleKind.DNS_REWRITE && rule.domain && rule.rewrite) {
          adguardPayload.rewrites[rule.domain] = {
            ...rule.rewrite,
            includeSubdomains: Boolean(rule.includeSubdomains),
            raw: rule.raw
          };
          count++;
        } else if (rule.kind === AdGuardRuleKind.COMPLEX_PATTERN && rule.patternRegex) {
          if (adguardPayload.patterns.length < maxRegexRules) {
            adguardPayload.patterns.push({
              pattern: rule.patternRegex,
              apexIndex: rule.apexIndex,
              raw: rule.raw
            });
            count++;
          } else {
            regexLimitHit = true;
          }
        }

        domainsSinceYield++;
        if (domainsSinceYield >= yieldBatchSize) {
          domainsSinceYield = 0;
          return new Promise<void>((resolve) => setTimeout(resolve, yieldSleepMs));
        }
      } else {
        domainLimitHit = true;
      }
    },
    {
      ...(p.etag || p.lastModified ? { etag: p.etag, lastModified: p.lastModified } : {}),
      ...p.tuning,
      fastPath,
      fastPathYieldBatch: yieldBatchSize,
      fastPathYieldSleep: yieldSleepMs,
      onRetry: () => {
        filterBuilder.clear();
        adguardPayload.exceptions = [];
        adguardPayload.rewrites = {};
        adguardPayload.patterns = [];
        count = 0;
        domainsSinceYield = 0;
        domainLimitHit = false;
        regexLimitHit = false;
      }
    }
  );

  let filterBytes: Uint8Array | null = null;
  if (!notModified && !fetchError) {
    const listFilter = await filterBuilder.build();
    if (!listFilter.isEmpty()) {
      const u8 = listFilter.toUint8Array();
      // Standalone buffer: transferable to the main thread and safe to hand to the DB layer as an ArrayBuffer.
      filterBytes = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8 : u8.slice();
    }
  }

  return {
    fetchError,
    truncated: Boolean(truncated),
    notModified: Boolean(notModified),
    etag,
    lastModified,
    title,
    description,
    count,
    domainLimitHit,
    regexLimitHit,
    filterBytes,
    adguardPayload
  };
}
