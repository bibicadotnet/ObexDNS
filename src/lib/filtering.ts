/**
 * @file filtering.ts
 * @description Local custom rule matching engine (Adblock / AdGuard Home style).
 *
 * Supported pattern syntax in Custom Rules:
 *   example.com            exact match only (unless include_subdomains is set)
 *   |example.com^          exact match only
 *   ||example.com^         example.com and all subdomains
 *   *.example.com          example.com and all subdomains (legacy form)
 *   ||ads*.example.com^    wildcard anywhere ("*" = any characters)
 *   *-ad.com               wildcard, exact (anchored) match
 *   /regex/                regular expression (case-insensitive, tested against the full domain)
 *
 * Trailing "^" and "$modifier" suffixes are ignored, a leading "@@" is tolerated
 * (the rule type ALLOW / BLOCK / REDIRECT decides what the match does).
 *
 * Performance: each rule set is compiled once and cached. Exact and suffix rules are
 * resolved through Map lookups (O(labels)); only wildcard / regex rules are iterated.
 */

import { Rule } from "../types";
import { wildcardToRegex } from "./adguard/parser";

const MAX_REGEX_LENGTH = 512;
const DEFAULT_MAX_PARSE_CACHE = 5000;

function getMaxParseCache(): number {
  if (typeof process !== "undefined" && process?.env?.RULE_PARSE_CACHE_LIMIT) {
    const val = Number(process.env.RULE_PARSE_CACHE_LIMIT);
    if (Number.isFinite(val) && val > 0) return val;
  }
  return DEFAULT_MAX_PARSE_CACHE;
}

type RuleType = Rule["type"];

type ParsedPattern =
  | { kind: "exact"; domain: string }
  | { kind: "suffix"; domain: string }
  | { kind: "regex"; re: RegExp };

/** Heuristic ReDoS guard: a group containing a quantifier that is itself quantified, e.g. (a+)+ or (.*)*. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/;

/** Returns [body, modifiersAfterClosingSlash] when the pattern is written as /regex/, otherwise null. */
function splitRegexLiteral(p: string): [string, string] | null {
  if (!p.startsWith("/") || p.length < 3) return null;
  const end = p.lastIndexOf("/");
  if (end <= 0) return null;
  return [p.slice(1, end), p.slice(end + 1)];
}

const parseCache = new Map<string, ParsedPattern | null>();

function parsePatternUncached(raw: string, includeSubdomains: boolean): ParsedPattern | null {
  let p = raw.trim();
  if (!p) return null;
  if (p.startsWith("@@")) p = p.slice(2).trim();

  // 1. Regular expression: /.../ (optionally followed by $modifiers)
  const literal = splitRegexLiteral(p);
  if (literal) {
    const [body, rest] = literal;
    if (rest && !rest.startsWith("$")) return null;
    if (!body || body.length > MAX_REGEX_LENGTH) return null;
    if (NESTED_QUANTIFIER.test(body)) return null;
    try {
      return { kind: "regex", re: new RegExp(body, "i") };
    } catch {
      return null;
    }
  }

  // 2. Domain / wildcard syntax
  p = p.toLowerCase();
  const dollar = p.indexOf("$");
  if (dollar !== -1) p = p.slice(0, dollar);

  let sub = includeSubdomains;
  if (p.startsWith("||")) {
    sub = true;
    p = p.slice(2);
  } else if (p.startsWith("|")) {
    p = p.slice(1);
  }

  const caret = p.indexOf("^");
  if (caret !== -1) p = p.slice(0, caret);
  p = p.trim().replace(/\.$/, "");
  if (!p) return null;

  if (p.includes("*")) {
    // Legacy "*.example.com" (single leading wildcard label) = domain + all subdomains
    if (p.startsWith("*.") && !p.slice(2).includes("*")) {
      const core = p.slice(2);
      return core ? { kind: "suffix", domain: core } : null;
    }
    try {
      return { kind: "regex", re: new RegExp(wildcardToRegex(p, sub), "i") };
    } catch {
      return null;
    }
  }

  return sub ? { kind: "suffix", domain: p } : { kind: "exact", domain: p };
}

function parsePattern(raw: string, includeSubdomains: boolean): ParsedPattern | null {
  const key = `${includeSubdomains ? 1 : 0}|${raw}`;
  if (parseCache.has(key)) return parseCache.get(key)!;
  const parsed = parsePatternUncached(raw, includeSubdomains);
  if (parseCache.size >= getMaxParseCache()) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  parseCache.set(key, parsed);
  return parsed;
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/\.$/, "");
}

class CompiledRuleSet {
  private exact = new Map<string, Rule>();
  private suffix = new Map<string, Rule>();
  private regex: Array<{ re: RegExp; rule: Rule }> = [];

  add(rule: Rule): void {
    const parsed = parsePattern(rule.pattern || "", Boolean(rule.include_subdomains));
    if (!parsed) return;
    // The first rule in list order wins when several rules share the same target.
    if (parsed.kind === "exact") {
      if (!this.exact.has(parsed.domain)) this.exact.set(parsed.domain, rule);
    } else if (parsed.kind === "suffix") {
      if (!this.suffix.has(parsed.domain)) this.suffix.set(parsed.domain, rule);
    } else {
      this.regex.push({ re: parsed.re, rule });
    }
  }

  find(d: string): Rule | null {
    const hit = this.exact.get(d);
    if (hit) return hit;

    if (this.suffix.size > 0) {
      let s = d;
      for (;;) {
        const r = this.suffix.get(s);
        if (r) return r;
        const dot = s.indexOf(".");
        if (dot === -1) break;
        s = s.slice(dot + 1);
      }
    }

    for (const item of this.regex) {
      if (item.re.test(d)) return item.rule;
    }
    return null;
  }
}

interface CompiledRules {
  ALLOW: CompiledRuleSet;
  BLOCK: CompiledRuleSet;
  REDIRECT: CompiledRuleSet;
}

// The rules array is cached per profile by the pipeline, so its identity is stable between queries.
const compiledCache = new WeakMap<Rule[], CompiledRules>();

function compile(rules: Rule[]): CompiledRules {
  let compiled = compiledCache.get(rules);
  if (compiled) return compiled;
  compiled = { ALLOW: new CompiledRuleSet(), BLOCK: new CompiledRuleSet(), REDIRECT: new CompiledRuleSet() };
  for (const rule of rules) {
    if (rule.enabled === false || (rule.enabled as any) === 0) continue;
    compiled[rule.type]?.add(rule);
  }
  compiledCache.set(rules, compiled);
  return compiled;
}

export class DNSFilter {
  /**
   * Normalizes a pattern for storage. Domain patterns are lower-cased; regex patterns
   * (/.../) keep their case because lower-casing would change escapes such as \S, \D, \W, \B.
   */
  static normalizePattern(pattern: string | undefined | null): string {
    const p = (pattern || "").trim();
    return splitRegexLiteral(p) ? p : p.toLowerCase();
  }

  /** Returns an error message when the pattern is unusable, otherwise null. */
  static validatePattern(pattern: string): string | null {
    const p = (pattern || "").trim();
    if (!p) return "Domain pattern cannot be empty";
    if (parsePatternUncached(p, false)) return null;
    return splitRegexLiteral(p)
      ? `Invalid or unsafe regular expression (max ${MAX_REGEX_LENGTH} chars, no nested quantifiers like (a+)+)`
      : "Invalid domain pattern";
  }

  /** Finds the first rule of the given type matching the queried domain, using the compiled cache. */
  static findByType(rules: Rule[], type: RuleType, domain: string): Rule | null {
    if (!rules || rules.length === 0) return null;
    return compile(rules)[type].find(normalizeDomain(domain));
  }

  /**
   * Checks whether a domain matches a single pattern or rule.
   *
   * @param domain - Queried domain (e.g. "sub.example.com")
   * @param patternOrRule - Rule object or pattern string
   * @param explicitIncludeSubdomains - Optional include-subdomains switch (string patterns only)
   */
  static isMatch(
    domain: string,
    patternOrRule: string | Rule,
    explicitIncludeSubdomains?: boolean
  ): boolean {
    if (typeof patternOrRule === "object") {
      if (patternOrRule.enabled === false || (patternOrRule.enabled as any) === 0) return false;
    }
    const d = normalizeDomain(domain);
    const raw = typeof patternOrRule === "string" ? patternOrRule : patternOrRule.pattern || "";
    const sub = typeof patternOrRule === "string"
      ? Boolean(explicitIncludeSubdomains)
      : Boolean(patternOrRule.include_subdomains);

    const parsed = parsePattern(raw, sub);
    if (!parsed) return false;
    if (parsed.kind === "exact") return d === parsed.domain;
    if (parsed.kind === "suffix") return d === parsed.domain || d.endsWith(`.${parsed.domain}`);
    return parsed.re.test(d);
  }

  /** Finds the first matching rule in the given list (compat helper; prefer findByType). */
  static findMatch(domain: string, rules: Rule[]): Rule | null {
    for (const rule of rules) {
      if (rule.enabled === false || (rule.enabled as any) === 0) continue;
      if (this.isMatch(domain, rule)) return rule;
    }
    return null;
  }
}
