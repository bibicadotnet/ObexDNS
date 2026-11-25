import React, { useEffect, useState } from "react";
import { Tag, Button, Intent, Switch, InputGroup, Alert, OverlayToaster, Tooltip } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../../../components/PageHeader";
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
  const [isCollapsed, setIsCollapsed] = useState(true);
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
        message: t("logs.clearLogsSuccess", "Logs cleared successfully"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
      fetchLogs(range, true, false, true);
    } catch (err) {
      console.error("[LogsHeader] Failed to clear profile logs:", err);
      toasterRef?.current?.show({
        message: t("logs.clearLogsError", "Failed to clear logs"),
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

  return (
    <div className="space-y-4">
      <PageHeader
        className="mb-0"
        title={
          <div className="flex flex-wrap items-center gap-2">
            <span>{t("logs.title")}</span>
            {(!isMobile || !isCollapsed) && (
              <Tag minimal round className="text-xs font-semibold">
                {range === "custom" ? t("analytics.custom") : range.toUpperCase()}
              </Tag>
            )}
            {stats && (
              <>
                <Tooltip content={t("logs.statTotal")} placement="bottom" hoverOpenDelay={200} compact>
                  <Tag minimal round className="text-xs font-mono">
                    {stats.total.toLocaleString()}
                  </Tag>
                </Tooltip>
                <Tooltip content={t("logs.statPass")} placement="bottom" hoverOpenDelay={200} compact>
                  <Tag minimal round intent={Intent.SUCCESS} className="text-xs font-mono">
                    {stats.pass.toLocaleString()}
                  </Tag>
                </Tooltip>
                <Tooltip content={t("logs.statBlock")} placement="bottom" hoverOpenDelay={200} compact>
                  <Tag minimal round intent={Intent.DANGER} className="text-xs font-mono">
                    {stats.block.toLocaleString()}
                  </Tag>
                </Tooltip>
                <Tooltip content={t("logs.statRedirect")} placement="bottom" hoverOpenDelay={200} compact>
                  <Tag minimal round intent={Intent.WARNING} className="text-xs font-mono">
                    {stats.redirect.toLocaleString()}
                  </Tag>
                </Tooltip>
                <Tooltip content={t("logs.statFail")} placement="bottom" hoverOpenDelay={200} compact>
                  <Tag minimal round className="text-xs font-mono">
                    {(stats.fail ?? 0).toLocaleString()}
                  </Tag>
                </Tooltip>
              </>
            )}
          </div>
        }
        subtitle={t("logs.subtitle")}
        actions={
          isMobile ? (
            <Button
              icon={isCollapsed ? "chevron-down" : "chevron-up"}
              variant="minimal"
              onClick={() => setIsCollapsed(!isCollapsed)}
            />
          ) : undefined
        }
      />

      {(!isMobile || !isCollapsed) && (
        <div className="bg-white p-3 sm:p-4 rounded-xl border border-[#d0d7de] shadow-xs space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
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
            <div className="flex items-center justify-end gap-2 sm:gap-3 flex-wrap">
              <Button
                icon="download"
                onClick={onExport}
                loading={exporting}
                title={t("logs.export", "Export Logs")}
                text={isMobile ? undefined : t("logs.export", "Export Logs")}
              />
              <Button
                icon="trash"
                intent={Intent.DANGER}
                minimal
                onClick={() => setIsClearAlertOpen(true)}
                loading={clearingLogs}
                title={t("logs.clearLogs", "Clear Logs")}
                text={isMobile ? undefined : t("logs.clearLogs", "Clear Logs")}
              />
              <Switch
                label={t("logs.realtime")}
                checked={realtimeRefresh}
                onChange={(e) => setRealtimeRefresh((e.target as HTMLInputElement).checked)}
                className="mb-0!"
              />
              <RefreshButton
                onClick={handleRefresh}
                remainingSec={refreshCooldown.remainingSec}
                loading={loading || syncing}
                small={isMobile}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2.5 pt-3 border-t border-gray-100">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              {hasActiveFilters && (
                <Button
                  icon="filter-remove"
                  onClick={handleClearFilters}
                  variant="minimal"
                  title={t("logs.clearFilters")}
                  text={isMobile ? t("logs.clearFilters") : undefined}
                />
              )}
              <StatusFilter
                statusFilter={statusFilter}
                setStatusFilter={setStatusFilter}
                isMobile={isMobile}
              />
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
            </div>
            <div className="flex items-center gap-2 flex-1 sm:flex-initial w-full sm:w-auto min-w-[180px] max-w-xs justify-end">
              <div className="w-full sm:w-56 md:w-60">
                <InputGroup
                  leftIcon="search"
                  placeholder={t("logs.searchPlaceholder")}
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  rightElement={searchInput ? <Button icon="cross" minimal onClick={() => setSearchInput("")} /> : undefined}
                  fill
                />
              </div>
            </div>
          </div>
        </div>
      )}

      <Alert
        isOpen={isClearAlertOpen}
        confirmButtonText={t("common.confirm", "Confirm")}
        cancelButtonText={t("common.cancel", "Cancel")}
        intent={Intent.DANGER}
        icon="trash"
        onConfirm={handleClearLogs}
        onCancel={() => setIsClearAlertOpen(false)}
        loading={clearingLogs}
      >
        <p>
          {t("logs.confirmClearLogs", "Are you sure you want to clear all resolution logs for this profile? This cannot be undone."
          )}
        </p>
      </Alert>
    </div>
  );
};
