import React, { useEffect, useState } from "react";
import { Tag, Button, Intent, Switch, InputGroup, Alert, OverlayToaster, Tooltip, Menu, MenuItem, MenuDivider, PopoverNext } from "@blueprintjs/core";
import { MoreHorizontal, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TimeRange } from "../types";
import type { AccessPoint } from "../../../types/auth";
import { clearProfileLogs } from "../../../services";
import { TimeRangeSelector } from "./TimeRangeSelector";
import { StatusFilter } from "./StatusFilter";
import { AccessPointFilter } from "./AccessPointFilter";
import { DestCountryFilter } from "./DestCountryFilter";
import { IspFilter } from "./IspFilter";
import { RefreshButton } from "../../../components/RefreshButton";
import { useRefreshCooldown } from "../../../hooks/useRefreshCooldown";

export interface LogsHeaderProps {
  profileId: string;
  range: TimeRange;
  setRange: (r: TimeRange) => void;
  customRange: { start: string; end: string };
  setCustomRange: (cr: { start: string; end: string }) => void;
  nowStr: string;
  fetchLogs: (range: TimeRange, initial: boolean, isAutoRefresh?: boolean, forceSync?: boolean, manualRefresh?: boolean) => void;
  isMobile: boolean;
  realtimeRefresh: boolean;
  setRealtimeRefresh: (val: boolean) => void;
  statusFilter: string | null;
  setStatusFilter: (val: string | null) => void;
  accessPointIdFilter: string | null;
  setAccessPointIdFilter: (val: string | null) => void;
  accessPoints: AccessPoint[];
  destCountryFilter: string | null;
  setDestCountryFilter: (val: string | null) => void;
  ispFilter: string | null;
  setIspFilter: (val: string | null) => void;
  searchQuery: string;
  setSearchQuery: (val: string) => void;
  stats: { total: number; pass: number; block: number; redirect: number; fail?: number } | null;
  logRetentionDays: number;
  onExport: () => void;
  exporting: boolean;
  loading?: boolean;
  syncing?: boolean;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

export const LogsHeader: React.FC<LogsHeaderProps> = ({
  profileId,
  range,
  setRange,
  customRange,
  setCustomRange,
  nowStr,
  fetchLogs,
  isMobile,
  realtimeRefresh,
  setRealtimeRefresh,
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
  stats,
  logRetentionDays,
  onExport,
  exporting,
  loading = false,
  syncing = false,
  toasterRef,
}) => {
  const { t } = useTranslation();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [isClearAlertOpen, setIsClearAlertOpen] = useState(false);
  const [clearingLogs, setClearingLogs] = useState(false);
  // The Refresh button re-reads from the server past every cache, so it can only be used once per pause.
  const refreshCooldown = useRefreshCooldown(`logs:${profileId}`);

  const handleRefresh = () => {
    if (refreshCooldown.active) return;
    refreshCooldown.start();
    fetchLogs(range, true, false, true, true);
  };

  // Typing is kept in local state and only committed (trimmed) after a short pause: every committed value
  // triggers a server query, and every keystroke used to re-render the whole logs view as well.
  const [searchInput, setSearchInput] = useState(searchQuery);
  useEffect(() => {
    const next = searchInput.trim();
    if (next === searchQuery) return;
    const timer = setTimeout(() => setSearchQuery(next), next === "" ? 0 : 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new input restarts the pause
  }, [searchInput]);

  const handleClearLogs = async () => {
    setClearingLogs(true);
    try {
      await clearProfileLogs(profileId);
      setIsClearAlertOpen(false);
      toasterRef?.current?.show({
        message: t("logs.clearLogsSuccess"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
      fetchLogs(range, true, false, true);
    } catch (err) {
      console.error("[LogsHeader] Failed to clear profile logs:", err);
      toasterRef?.current?.show({
        message: t("logs.clearLogsError"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setClearingLogs(false);
    }
  };

  const hasActiveFilters = statusFilter !== null || accessPointIdFilter !== null || destCountryFilter !== null || ispFilter !== null;

  const handleClearFilters = () => {
    setStatusFilter(null);
    setAccessPointIdFilter(null);
    setDestCountryFilter(null);
    setIspFilter(null);
  };

  const activeFilterCount = [statusFilter, accessPointIdFilter, destCountryFilter, ispFilter].filter(Boolean).length;
  const rangeLabel = range === "custom" ? t("analytics.custom") : range.toUpperCase();

  const statChips: Array<{ key: string; label: string; value: number; dot: string }> = stats
    ? [
        { key: "total", label: t("logs.statTotal"), value: stats.total, dot: "bg-gray-400" },
        { key: "pass", label: t("logs.statPass"), value: stats.pass, dot: "bg-green-600" },
        { key: "block", label: t("logs.statBlock"), value: stats.block, dot: "bg-red-600" },
        { key: "redirect", label: t("logs.statRedirect"), value: stats.redirect, dot: "bg-amber-500" },
        { key: "fail", label: t("logs.statFail"), value: stats.fail ?? 0, dot: "bg-gray-300" },
      ]
    : [];

  return (
    <div className="shrink-0 border-b border-gray-200 bg-white px-4 py-3 md:px-6 md:py-4">
      <div className="space-y-3">
        {/* 1. What page is this, and the two things you do most: go live, refresh */}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="page-title">{t("logs.title")}</h1>
            {!isMobile && <p className="page-subtitle">{t("logs.subtitle")}</p>}
          </div>
          <Switch
            label={t("logs.realtime")}
            checked={realtimeRefresh}
            onChange={(e) => setRealtimeRefresh((e.target as HTMLInputElement).checked)}
            className="mb-0! shrink-0"
          />
          <RefreshButton
            onClick={handleRefresh}
            remainingSec={refreshCooldown.remainingSec}
            loading={loading || syncing}
            small={false}
          />
          {/* Rare and destructive actions live behind "...", away from the everyday buttons */}
          <PopoverNext
            placement="bottom-end"
            content={
              <Menu>
                <MenuItem
                  icon="download"
                  text={t("logs.export", "Export Logs")}
                  disabled={exporting}
                  onClick={onExport}
                />
                <MenuDivider />
                <MenuItem
                  icon="trash"
                  intent={Intent.DANGER}
                  text={t("logs.clearLogs", "Clear logs")}
                  onClick={() => setIsClearAlertOpen(true)}
                />
              </Menu>
            }
          >
            <Button
              variant="minimal"
              icon={<MoreHorizontal size={18} />}
              loading={exporting || clearingLogs}
              aria-label={t("common.moreActions", "More actions")}
              title={t("common.moreActions", "More actions")}
            />
          </PopoverNext>
        </div>

        {/* 2. The numbers for the current view */}
        {stats && (
          <ul className="m-0 flex list-none items-center gap-2 overflow-x-auto p-0 pb-0.5 text-sm">
            <li className="shrink-0">
              <Tooltip content={t(`analytics.range${range === "custom" ? "Custom" : range}`)} placement="bottom" compact>
                <Tag minimal round>{rangeLabel}</Tag>
              </Tooltip>
            </li>
            {statChips.map((c) => (
              <li key={c.key} className="tabular flex shrink-0 items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1">
                <span className={`h-2 w-2 rounded-full ${c.dot}`} aria-hidden="true" />
                <span className="text-gray-600">{c.label}</span>
                <span className="font-semibold text-gray-900">{c.value.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}

        {/* 3. Find something: search first, filters one tap away */}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 sm:max-w-md">
            <InputGroup
              leftIcon="search"
              type="search"
              placeholder={t("logs.searchPlaceholder")}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              rightElement={
                searchInput ? (
                  <Button icon="cross" variant="minimal" onClick={() => setSearchInput("")} aria-label={t("logs.clearFilters")} />
                ) : undefined
              }
              fill
            />
          </div>
          <Button
            icon={<SlidersHorizontal size={16} />}
            active={filtersOpen}
            onClick={() => setFiltersOpen(!filtersOpen)}
            aria-expanded={filtersOpen}
            text={
              <span className="inline-flex items-center gap-1.5">
                <span className="hidden sm:inline">{t("logs.filters", "Filters")}</span>
                {activeFilterCount > 0 && (
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1 text-xs font-bold text-white">
                    {activeFilterCount}
                  </span>
                )}
              </span>
            }
            aria-label={t("logs.filters", "Filters")}
          />
        </div>

        {filtersOpen && (
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 md:p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <TimeRangeSelector
                  range={range}
                  setRange={setRange}
                  customRange={customRange}
                  setCustomRange={setCustomRange}
                  nowStr={nowStr}
                  fetchLogs={fetchLogs}
                  isMobile={isMobile}
                  logRetentionDays={logRetentionDays}
                />
              </div>
              <div className="grid min-w-0 grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
                <StatusFilter statusFilter={statusFilter} setStatusFilter={setStatusFilter} isMobile={isMobile} />
                {accessPoints.length > 0 && (
                  <AccessPointFilter
                    accessPointIdFilter={accessPointIdFilter}
                    setAccessPointIdFilter={setAccessPointIdFilter}
                    accessPoints={accessPoints}
                    isMobile={isMobile}
                  />
                )}
                <DestCountryFilter
                  destCountryFilter={destCountryFilter}
                  setDestCountryFilter={setDestCountryFilter}
                  isMobile={isMobile}
                />
                <IspFilter
                  profileId={profileId}
                  range={range}
                  customRange={customRange}
                  destCountryFilter={destCountryFilter}
                  accessPointIdFilter={accessPointIdFilter}
                  ispFilter={ispFilter}
                  setIspFilter={setIspFilter}
                  isMobile={isMobile}
                />
                {hasActiveFilters && (
                  <Button
                    icon="filter-remove"
                    variant="minimal"
                    onClick={handleClearFilters}
                    text={t("logs.clearFilters")}
                    className="col-span-2 sm:col-auto"
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <Alert
        isOpen={isClearAlertOpen}
        confirmButtonText={t("common.confirm")}
        cancelButtonText={t("common.cancel")}
        intent={Intent.DANGER}
        icon="trash"
        onConfirm={handleClearLogs}
        onCancel={() => setIsClearAlertOpen(false)}
        loading={clearingLogs}
      >
        <p>{t("logs.confirmClearLogs")}</p>
      </Alert>
    </div>
  );
};
