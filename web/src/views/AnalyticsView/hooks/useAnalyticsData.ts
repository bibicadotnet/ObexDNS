/**
 * @file useAnalyticsData.ts
 * @description Primary orchestrator hook for analytics data aggregation, coordinating local SQLite preview,
 * authoritative server analytics retrieval, and decrypted record merging.
 */

import { isLocalDbNeeded } from "../../../services/localDbPolicy";
import { useState, useEffect, useCallback, useRef } from "react";
import type { OverlayToaster } from "@blueprintjs/core";
import type { AnalyticsData, TimeRange } from "../types";
import {
  getProfileAnalytics,
  localDb,
  e2ee,
  type AccessPoint
} from "../../../services";
import { analyticsCache } from "../utils/analyticsCache";
import {
  calculateTimeInterval,
  buildAnalyticsQueryParams,
  type TimeInterval
} from "../utils/timeInterval";
import {
  inspectServerAnalytics,
  mergeServerAnalytics,
  mergeLocalDecryptedAnalytics,
  type AnalyticsValidationFlags
} from "../utils/analyticsMerge";
import { useProfileMetadata } from "./useProfileMetadata";
import { useAnalyticsSync } from "./useAnalyticsSync";

export interface UseAnalyticsDataReturn {
  data: AnalyticsData | null;
  loading: boolean;
  syncing: boolean;
  syncProgress: number;
  range: TimeRange;
  setRange: React.Dispatch<React.SetStateAction<TimeRange>>;
  customRange: { start: string; end: string };
  setCustomRange: React.Dispatch<React.SetStateAction<{ start: string; end: string }>>;
  accessPointIdFilter: string | null;
  setAccessPointIdFilter: React.Dispatch<React.SetStateAction<string | null>>;
  accessPoints: AccessPoint[];
  logRetentionDays: number;
  fetchData: (
    selectedRange: TimeRange,
    customStart?: string,
    customEnd?: string,
    apIdFilter?: string | null,
    force?: boolean
  ) => Promise<void>;
  syncTargetRange: () => Promise<void>;
  stopSync: () => void;
}

/**
 * Hook to manage analytics data aggregation, local-first SQLite preview,
 * authoritative server analytics retrieval, and decrypted record merging.
 */
export function useAnalyticsData(
  profileId: string,
  toasterRef?: React.RefObject<OverlayToaster | null>
): UseAnalyticsDataReturn {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [range, setRange] = useState<TimeRange>("1h");
  const [customRange, setCustomRange] = useState<{ start: string; end: string }>({ start: "", end: "" });
  const [accessPointIdFilter, setAccessPointIdFilter] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  // Query scope (profile + range + access point) that the dataset in `data` belongs to.
  // The E2EE merge fallbacks reuse the previous dataset, which is only valid within the same scope.
  const dataScopeRef = useRef<string | null>(null);
  const serverFlagsRef = useRef<AnalyticsValidationFlags>({
    serverHasValidClients: false,
    serverHasValidTopAllowed: false,
    serverHasValidTopBlocked: false,
    serverHasDestinations: false
  });

  const { accessPoints, logRetentionDays } = useProfileMetadata(profileId);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  /**
   * Refreshes local decrypted analytics into the active dataset during progressive sync.
   */
  const refreshLocalData = useCallback(
    async (interval: TimeInterval): Promise<void> => {
      try {
        const freshLocal = await localDb.queryAnalytics({
          profileId,
          since: interval.since,
          until: interval.until,
          bucketSec: interval.bucketSec,
          accessPointId: accessPointIdFilter || undefined
        });

        setData((curr) => mergeLocalDecryptedAnalytics(curr, freshLocal, serverFlagsRef.current));
      } catch {
        // Non-critical local aggregation query error
      }
    },
    [profileId, accessPointIdFilter]
  );

  const { syncing, syncProgress, syncTargetRange, stopSync } = useAnalyticsSync({
    profileId,
    range,
    customRange,
    accessPointIdFilter,
    toasterRef,
    onRefreshLocal: refreshLocalData
  });

  const fetchData = useCallback(
    async (
      selectedRange: TimeRange,
      customStart?: string,
      customEnd?: string,
      apIdFilter?: string | null,
      force = false
    ): Promise<void> => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const signal = controller.signal;

      const cacheKey = analyticsCache.buildKey(
        profileId,
        selectedRange,
        customStart,
        customEnd,
        apIdFilter
      );

      if (force) {
        analyticsCache.invalidateProfile(profileId);
      } else {
        // Step -1: Check L1 in-memory client cache for instant preview (0ms latency, 0 server reads)
        // The cached dataset is only a preview: it is always revalidated below. Skipping the
        // request for "fresh" entries made the Analytics tab show old numbers after switching
        // away and back, or after toggling 10M / 1H / 24H.
        const cached = analyticsCache.get(cacheKey);
        if (cached && !signal.aborted) {
          dataScopeRef.current = cacheKey;
          setData(cached.data);
          setLoading(false);
        }
      }

      // Switching access point / range: drop the previous scope's dataset so that the
      // "keep previous value when the server returns nothing readable" fallbacks (E2EE)
      // cannot leak another device's top domains and clients into this view.
      if (dataScopeRef.current !== cacheKey) {
        dataScopeRef.current = cacheKey;
        serverFlagsRef.current = {
          serverHasValidClients: false,
          serverHasValidTopAllowed: false,
          serverHasValidTopBlocked: false,
          serverHasDestinations: false
        };
        setData(null);
      }

      setLoading(true);

      const interval = calculateTimeInterval(selectedRange, customStart, customEnd);

      // Start the authoritative server request right away so it overlaps the local SQLite work.
      const queryParams = buildAnalyticsQueryParams(selectedRange, interval, apIdFilter, force);
      const loadServerAnalytics = async (): Promise<AnalyticsData> => {
        try {
          return await getProfileAnalytics(profileId, "", queryParams, { signal });
        } catch (unifiedErr) {
          if (signal.aborted) throw unifiedErr;
          // Fallback to separate endpoints if unified endpoint fails
          const [summary, trend, topAllowed, topBlocked, clients, destinations] =
            await Promise.all([
              getProfileAnalytics(profileId, "summary", queryParams, { signal }),
              getProfileAnalytics(profileId, "trend", queryParams, { signal }),
              getProfileAnalytics(profileId, "top_allowed", queryParams, { signal }),
              getProfileAnalytics(profileId, "top_blocked", queryParams, { signal }),
              getProfileAnalytics(profileId, "clients", queryParams, { signal }),
              getProfileAnalytics(profileId, "destinations", queryParams, { signal })
            ]);
          return { summary, trend, top_allowed: topAllowed, top_blocked: topBlocked, clients, destinations };
        }
      };
      const serverRequest = loadServerAnalytics();
      serverRequest.catch(() => {
        // Handled where the result is awaited below
      });

      // The local SQLite copy only serves E2EE profiles; a plain profile is answered by the server alone.
      const useLocal = await isLocalDbNeeded(profileId);
      if (signal.aborted) return;

      // Step 0: Ensure local encrypted logs are re-decrypted if E2EE is unlocked
      try {
        if (useLocal && (e2ee.isProfileUnlocked(profileId) || e2ee.isUnlocked())) {
          await localDb.reDecryptLocalLogs(profileId);
        }
      } catch {
        // Non-critical local decryption check
      }

      // Step 1: Aggregate the local SQLite copy. It is NOT shown as a preview: it holds no DNS
      // cache hits (and may be partially synced), so its totals differ from the server's and used to
      // flash wrong numbers. It only backs the fields the server cannot read (E2EE) and acts as
      // the fallback when the server is unreachable.
      let localPreview: AnalyticsData | null = null;
      try {
        const isDbReady = useLocal && (await localDb.init());
        if (isDbReady && !signal.aborted) {
          localPreview = await localDb.queryAnalytics({
            profileId,
            since: interval.since,
            until: interval.until,
            bucketSec: interval.bucketSec,
            accessPointId: apIdFilter || undefined
          });
        }
      } catch (localErr) {
        console.warn("[useAnalyticsData] Local SQLite aggregation failed:", localErr);
      }
      if (signal.aborted) return;

      // Step 2: Fetch Authoritative Analytics from Server
      try {
        const serverAnalytics: AnalyticsData | null = await serverRequest;

        if (serverAnalytics && !signal.aborted) {
          const flags = inspectServerAnalytics(serverAnalytics);
          serverFlagsRef.current = flags;

          // Fallback fields come from this request's own local aggregation, never from the
          // previously displayed (cached, possibly older) dataset.
          const nextData = mergeServerAnalytics(serverAnalytics, localPreview, flags);
          analyticsCache.set(cacheKey, nextData, selectedRange, customEnd);
          setData(nextData);
        }
      } catch (e) {
        if (!signal.aborted) {
          console.error("[useAnalyticsData] Failed to fetch server analytics:", e);
          // Server unreachable: show the local copy rather than nothing.
          if (localPreview && localPreview.summary.some((s) => s.count > 0)) {
            setData((curr) => curr ?? localPreview);
          }
        }
      } finally {
        if (!signal.aborted) {
          setLoading(false);
        }
      }

      // Step 3: Download missing time intervals into local SQLite and refresh aggregations
      if (!useLocal) return;
      try {
        const isUnlocked = e2ee.isProfileUnlocked(profileId) || e2ee.isUnlocked();

        const updateFromFreshLocal = async (): Promise<void> => {
          if (signal.aborted) return;
          try {
            const freshLocal = await localDb.queryAnalytics({
              profileId,
              since: interval.since,
              until: interval.until,
              bucketSec: interval.bucketSec,
              accessPointId: apIdFilter || undefined
            });

            if (!signal.aborted) {
              setData((curr) => {
                const updated = mergeLocalDecryptedAnalytics(curr, freshLocal, serverFlagsRef.current);
                analyticsCache.set(cacheKey, updated, selectedRange, customEnd);
                return updated;
              });
            }
          } catch {
            // Ignore re-query errors
          }
        };

        const inserted = await localDb.syncMissingIntervals(
          profileId,
          interval.since,
          interval.until,
          signal,
          () => {
            updateFromFreshLocal();
          }
        );

        if (!signal.aborted && (inserted > 0 || isUnlocked)) {
          await updateFromFreshLocal();
        }
      } catch (syncErr) {
        if ((syncErr as Error)?.name !== "AbortError") {
          console.warn("[useAnalyticsData] Missing intervals sync error:", syncErr);
        }
      }
    },
    [profileId]
  );

  useEffect(() => {
    if (range !== "custom") {
      fetchData(range, undefined, undefined, accessPointIdFilter);
    }
  }, [range, accessPointIdFilter, fetchData]);

  return {
    data,
    loading,
    syncing,
    syncProgress,
    range,
    setRange,
    customRange,
    setCustomRange,
    accessPointIdFilter,
    setAccessPointIdFilter,
    accessPoints,
    logRetentionDays,
    fetchData,
    syncTargetRange,
    stopSync
  };
}
