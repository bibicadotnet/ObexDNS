/**
 * @file stats.ts
 * @description Shared summary-stats shape and parser for the Query Logs header counters.
 */

export interface LogStats {
  total: number;
  pass: number;
  block: number;
  redirect: number;
  /** Failed resolutions (upstream errors, timeouts). */
  fail?: number;
}

/**
 * Folds `[{ action, count }]` rows from the analytics summary endpoint into header counters.
 * `total` is the sum of every action so it always equals the number of matching log rows.
 */
export function summarizeActionCounts(items: Array<{ action: string; count: number }>): LogStats {
  const summary: LogStats = { total: 0, pass: 0, block: 0, redirect: 0, fail: 0 };
  for (const item of items) {
    const count = Number(item.count) || 0;
    summary.total += count;
    if (item.action === "PASS") summary.pass += count;
    else if (item.action === "BLOCK") summary.block += count;
    else if (item.action === "REDIRECT") summary.redirect += count;
    else if (item.action === "FAIL") summary.fail = (summary.fail ?? 0) + count;
  }
  return summary;
}

/** Query-string params for the summary endpoint; always `exact` so the numbers match the log list. */
export function buildSummaryParams(opts: {
  range: string;
  since: number;
  until: number;
  searchQuery: string;
  statusFilter: string | null;
  accessPointIdFilter: string | null;
  destCountryFilter: string | null;
  ispFilter: string | null;
}): URLSearchParams {
  const params = new URLSearchParams({ range: opts.range });
  if (opts.range === "custom") {
    params.set("start", String(opts.since));
    params.set("end", String(opts.until));
  }
  // Counts rows of the raw log table with exact time boundaries (rollups are hour-granular
  // and include cache hits that never appear in the log list).
  params.set("exact", "true");
  if (opts.searchQuery) params.set("search", opts.searchQuery);
  if (opts.statusFilter) params.set("status", opts.statusFilter);
  if (opts.accessPointIdFilter) params.set("access_point_id", opts.accessPointIdFilter);
  if (opts.destCountryFilter) params.set("dest_country", opts.destCountryFilter);
  if (opts.ispFilter) params.set("isp", opts.ispFilter);
  return params;
}
