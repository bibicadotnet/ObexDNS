/**
 * @file iconCandidates.ts
 * @description Hostnames to try, in order, when looking up a favicon for a domain.
 *
 * The icon provider only knows sites that have a real favicon, so most subdomains (edge.microsoft.com,
 * ads.example.com, cdn.*) return 404 although their parent site has one. The lookup therefore walks up
 * towards the registrable domain, never below it. There is no public-suffix list on the edge, so the
 * common second-level suffixes (co.uk, com.vn, ...) are recognised by shape.
 */

const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac']);

/** Upper bound of upstream requests for one icon. */
export const MAX_ICON_ATTEMPTS = 4;

export function iconCandidates(domain: string): string[] {
  const host = domain.toLowerCase();
  const labels = host.split('.');
  const last = labels[labels.length - 1] ?? '';
  const secondLast = labels[labels.length - 2] ?? '';
  const minLabels = labels.length >= 3 && last.length === 2 && SECOND_LEVEL.has(secondLast) ? 3 : 2;

  const out = [host];
  for (let i = 1; labels.length - i >= minLabels; i++) {
    out.push(labels.slice(i).join('.'));
  }
  return out.slice(0, MAX_ICON_ATTEMPTS);
}
