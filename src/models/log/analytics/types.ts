/**
 * Summary count for a specific DNS action (PASS, BLOCK, REDIRECT, FAIL).
 */
export interface ActionCountResult {
  action: string;
  count: number;
}

/**
 * Data point in a time-series query aggregated by time bucket.
 */
export interface TimeSeriesTrendPoint {
  timestamp: number;
  action: string;
  count: number;
}

/**
 * Frequency count for a specific queried domain.
 */
export interface DomainCountResult {
  domain: string;
  count: number;
}

/**
 * Frequency count and geo information for a querying client IP.
 */
export interface ClientCountResult {
  client_ip: string;
  geo_country: string | null;
  count: number;
}

/**
 * Resolution query count aggregated by destination country.
 */
export interface DestinationCountResult {
  country_code: string;
  country: string;
  count: number;
}

/**
 * Query count aggregated by destination/upstream ISP name.
 */
export interface ISPCountResult {
  name: string;
  count: number;
}

/**
 * Comprehensive dashboard analytics dataset assembled from all sub-queries.
 */
export interface DashboardAnalyticsResult {
  summary: ActionCountResult[];
  trend: TimeSeriesTrendPoint[];
  top_allowed: DomainCountResult[];
  top_blocked: DomainCountResult[];
  clients: ClientCountResult[];
  destinations: DestinationCountResult[];
}
