import { useEffect } from "react";
import type { LogEntry } from "../../types";
import { logsWs } from "../../../../services";
import type { LogStats } from "./utils/stats";

export interface UseRealtimeLogsParams {
  realtimeRefresh: boolean;
  statusFilter: string | null;
  accessPointIdFilter: string | null;
  destCountryFilter: string | null;
  ispFilter: string | null;
  searchQuery: string;
  pageSize: number;
  logsRef: React.MutableRefObject<LogEntry[]>;
  setLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
  setStats: React.Dispatch<React.SetStateAction<LogStats | null>>;
  setPrevLatestTimestamp: React.Dispatch<React.SetStateAction<number | null>>;
}

/**
 * Hook to manage real-time WebSocket log streaming and live filter matching.
 */
export function useRealtimeLogs({
  realtimeRefresh,
  statusFilter,
  accessPointIdFilter,
  destCountryFilter,
  ispFilter,
  searchQuery,
  pageSize,
  logsRef,
  setLogs,
  setStats,
  setPrevLatestTimestamp
}: UseRealtimeLogsParams): void {
  useEffect(() => {
    if (!realtimeRefresh) return;

    const unsubscribe = logsWs.onNewLogs((newLogs: LogEntry[]) => {
      if (!newLogs || newLogs.length === 0) return;

      const filteredNew = newLogs.filter((log) => {
        if (statusFilter && log.action !== statusFilter) return false;
        if (accessPointIdFilter && log.access_point_id !== accessPointIdFilter) return false;
        if (
          destCountryFilter &&
          (log.dest_country_code || log.dest_country) !== destCountryFilter
        )
          return false;
        if (ispFilter && log.dest_isp !== ispFilter) return false;
        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          const domainMatch = log.domain?.toLowerCase().includes(q);
          const ipMatch = log.client_ip?.toLowerCase().includes(q);
          const reasonMatch = log.reason?.toLowerCase().includes(q);
          if (!domainMatch && !ipMatch && !reasonMatch) return false;
        }
        return true;
      });

      if (filteredNew.length === 0) return;

      // Only rows that are really new (the stream can replay after a reconnect) and that match the
      // active filters may change the list or the counters.
      const known = new Set(logsRef.current.map((l) => `${l.timestamp}-${l.id}`));
      const uniqueNew = filteredNew.filter((l) => !known.has(`${l.timestamp}-${l.id}`));
      if (uniqueNew.length === 0) return;

      const oldLatest = logsRef.current.length > 0 ? logsRef.current[0].timestamp : null;
      setPrevLatestTimestamp(oldLatest);

      setLogs((prev) => {
        const existingIds = new Set(prev.map((l) => `${l.timestamp}-${l.id}`));
        const fresh = uniqueNew.filter((l) => !existingIds.has(`${l.timestamp}-${l.id}`));
        if (fresh.length === 0) return prev;
        return [...fresh, ...prev].slice(0, pageSize);
      });

      setStats((prev) => {
        if (!prev) return prev;
        let addedPass = 0;
        let addedBlock = 0;
        let addedRedirect = 0;
        let addedFail = 0;
        for (const l of uniqueNew) {
          if (l.action === "PASS") addedPass++;
          else if (l.action === "BLOCK") addedBlock++;
          else if (l.action === "REDIRECT") addedRedirect++;
          else if (l.action === "FAIL") addedFail++;
        }
        return {
          total: prev.total + uniqueNew.length,
          pass: prev.pass + addedPass,
          block: prev.block + addedBlock,
          redirect: prev.redirect + addedRedirect,
          fail: (prev.fail ?? 0) + addedFail
        };
      });
    });

    return unsubscribe;
  }, [
    realtimeRefresh,
    statusFilter,
    accessPointIdFilter,
    destCountryFilter,
    ispFilter,
    searchQuery,
    pageSize,
    logsRef,
    setLogs,
    setStats,
    setPrevLatestTimestamp
  ]);
}
