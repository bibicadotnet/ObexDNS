/**
 * Custom error representing an upstream HTTP error response during DoH resolution.
 */
export class UpstreamHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly responseBodySnippet: string,
    public readonly cfRay?: string
  ) {
    super(`Upstream HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
    this.name = "UpstreamHttpError";
  }
}

/**
 * Transport execution outcome returned by fetchFromUpstream.
 */
export interface UpstreamTransportResult {
  /** Raw wire-format DNS answer packet. */
  answer: Uint8Array;
  /** Latency in milliseconds spent communicating with the upstream. */
  latency: number;
  /** Diagnostic string of the transport protocol used (e.g., 'POST', 'DoT', 'TCP'). */
  diagMethod: string;
  /** Diagnostic target string (URL or socket address). */
  diagTarget: string;
}

/**
 * Structured representation of a decoded DNS answer resource record.
 */
export interface ParsedDNSAnswerRecord {
  name: string;
  type: string;
  data: string;
  ttl: number;
}

/**
 * Result of applying EDNS Client Subnet to a query.
 */
export interface EcsApplicationResult {
  /** Wire-format query bytes (with ECS injected if configured). */
  queryRaw: Uint8Array;
  /** Normalized ECS subnet string for logging, if applied. */
  ecs?: string;
}

/**
 * Result of evaluating best-effort Encrypted Client Hello rewrite.
 */
export interface EchProcessResult {
  /** Effective wire-format answer packet (rewritten if ECH injected). */
  answer: Uint8Array;
  /** Parsed answer records reflecting any rewritten records. */
  parsedAnswers: ParsedDNSAnswerRecord[];
  /** Effective resolution reason (e.g. 'ECH Rewritten' or original reason). */
  effectiveReason?: string;
}
