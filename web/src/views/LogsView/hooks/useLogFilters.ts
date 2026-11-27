import { useState, useEffect, useCallback } from "react";
import type { TimeRange } from "../types";
import { getProfileAccessPoints } from "../../../services";
import type { AccessPoint } from "../../../services";

export function useLogFilters(profileId: string) {
  const [range, setRange] = useState<TimeRange>("1h");
  const [customRange, setCustomRange] = useState({ start: "", end: "" });
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [accessPointIdFilter, setAccessPointIdFilter] = useState<string | null>(null);
  const [accessPoints, setAccessPoints] = useState<AccessPoint[]>([]);
  const [destCountryFilter, setDestCountryFilterRaw] = useState<string | null>(null);
  const [ispFilter, setIspFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    getProfileAccessPoints(profileId)
      .then(setAccessPoints)
      .catch(console.error);
  }, [profileId]);

  // Synchronously reset ISP selection whenever the destination country changes,
  // preventing double-fetch requests in React 18.
  const setDestCountryFilter = useCallback((updater: React.SetStateAction<string | null>) => {
    setDestCountryFilterRaw((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (next !== prev) {
        setIspFilter(null);
      }
      return next;
    });
  }, []);

  return {
    range,
    setRange,
    customRange,
    setCustomRange,
    statusFilter,
    setStatusFilter,
    accessPointIdFilter,
    setAccessPointIdFilter,
    accessPoints,
    destCountryFilter,
    setDestCountryFilter,
    ispFilter,
    setIspFilter,
    searchQuery,
    setSearchQuery,
  };
}
