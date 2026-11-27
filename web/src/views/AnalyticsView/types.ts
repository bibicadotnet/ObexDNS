export interface AnalyticsData {
  summary: { action: string; count: number }[];
  trend: { timestamp: number; action: string; count: number }[];
  top_allowed: { domain: string; count: number }[];
  top_blocked: { domain: string; count: number }[];
  clients: { client_ip: string; geo_country: string; count: number }[];
  destinations: { country_code: string; country: string; count: number }[];
  /** Set by the server: the numbers cover a whole-hour window instead of the requested one. */
  aligned?: boolean;
  /** Set by the server: the window is too old and holds no whole hour, so no exact answer exists. */
  too_old?: boolean;
  /** First / last second the numbers really cover (null when `too_old`). */
  aligned_since?: number | null;
  aligned_until?: number | null;
}

export type TimeRange = "10m" | "1h" | "24h" | "7d" | "30d" | "custom";
