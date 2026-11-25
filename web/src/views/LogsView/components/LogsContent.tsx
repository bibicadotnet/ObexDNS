import React, { useState, useEffect, useCallback } from "react";
import { Spinner, Callout, Intent } from "@blueprintjs/core";
import { ArrowUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import type { LogEntry } from "../types";
import { LogsList } from "./LogsList";
import { LogsTable } from "./LogsTable";
import type { LogsTableDensity } from "./LogsTable";
import { useContainerWidth } from "../../../hooks/useContainerWidth";

/** Container widths (px) where the table gains columns. Below CARDS_BELOW the log list is shown as cards. */
const CARDS_BELOW = 720;
const MEDIUM_FROM = 800;
const FULL_FROM = 880;

interface LogsContentProps {
  logs: LogEntry[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  realtimeRefresh: boolean;
  isMobile: boolean;
  searchQuery: string;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  lastLogElementRef: (node: HTMLDivElement | null) => void;
  prevLatestTimestamp: number | null;
  setSelectedLog: (log: LogEntry | null) => void;
  setIsDrawerOpen: (isOpen: boolean) => void;
  logRetentionDays?: number;
}

export const LogsContent: React.FC<LogsContentProps> = ({
  logs,
  loading,
  loadingMore,
  hasMore,
  realtimeRefresh,
  isMobile,
  searchQuery,
  scrollContainerRef,
  lastLogElementRef,
  prevLatestTimestamp,
  setSelectedLog,
  setIsDrawerOpen,
  logRetentionDays,
}) => {
  const { t } = useTranslation();
  const [showScrollTop, setShowScrollTop] = useState<boolean>(false);
  const [measureRef, containerWidth] = useContainerWidth();

  // Layout follows the width actually available (the sidebar eats 256px on desktop), not the window width.
  // 0 = not measured yet: fall back to the window-based flag for the first paint.
  const showCards = containerWidth > 0 ? containerWidth < CARDS_BELOW : isMobile;
  const density: LogsTableDensity =
    containerWidth === 0
      ? (isMobile ? "compact" : "full")
      : containerWidth >= FULL_FROM
      ? "full"
      : containerWidth >= MEDIUM_FROM
      ? "medium"
      : "compact";

  const checkScroll = useCallback(() => {
    if (scrollContainerRef.current) {
      setShowScrollTop(scrollContainerRef.current.scrollTop > 300);
    }
  }, [scrollContainerRef]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    container.addEventListener("scroll", checkScroll, { passive: true });
    checkScroll();

    return () => {
      container.removeEventListener("scroll", checkScroll);
    };
  }, [scrollContainerRef, checkScroll, logs]);

  const scrollToTop = () => {
    scrollContainerRef.current?.scrollTo({
      top: 0,
      behavior: "smooth"
    });
  };

  return (
    <div className="w-full relative min-h-0">
      <div
        ref={scrollContainerRef}
        onScroll={checkScroll}
        className={clsx("w-full", showCards ? "px-1" : "px-0")}
      >
        <div ref={measureRef} className="w-full min-w-0">
        {logs.length === 0 && loading ? (
          <div className="py-20 flex items-center justify-center">
            <Spinner />
          </div>
        ) : logs.length === 0 ? (
          <div className="py-20">
            <Callout
              title={
                logRetentionDays === 0
                  ? t("logs.loggingDisabledTitle", "Logging Disabled")
                  : searchQuery
                  ? t("logs.noResults")
                  : t("logs.noRecords")
              }
              icon={logRetentionDays === 0 ? "disable" : searchQuery ? "search" : "outdated"}
              intent={logRetentionDays === 0 ? Intent.WARNING : Intent.NONE}
            >
              {logRetentionDays === 0
                ? t("logs.loggingDisabledDesc", "Log retention for this profile is set to 'Disabled'. No query logs are recorded. To view logs, enable log retention in Settings.")
                : searchQuery
                ? t("logs.noResultsDesc", { query: searchQuery })
                : t("logs.noRecordsDesc")}
            </Callout>
          </div>
        ) : showCards ? (
          <LogsList
            logs={logs}
            setSelectedLog={setSelectedLog}
            setIsDrawerOpen={setIsDrawerOpen}
            lastLogElementRef={lastLogElementRef}
            prevLatestTimestamp={prevLatestTimestamp}
            realtimeRefresh={realtimeRefresh}
          />
        ) : (
          <LogsTable
            density={density}
            logs={logs}
            setSelectedLog={setSelectedLog}
            setIsDrawerOpen={setIsDrawerOpen}
            lastLogElementRef={lastLogElementRef}
            prevLatestTimestamp={prevLatestTimestamp}
            realtimeRefresh={realtimeRefresh}
          />
        )}
        </div>

        <div className="p-6 flex flex-col items-center">
          {loadingMore ? (
            <Spinner size={16} />
          ) : realtimeRefresh ? (
            logs.length > 0 && <span className="text-[10px] opacity-30 italic">{t("logs.realtimeLoadMoreTip")}</span>
          ) : (
            !hasMore &&
            logs.length > 0 && <span className="text-[10px] opacity-30 italic">{t("logs.loadedAll", { count: logs.length })}</span>
          )}
        </div>
      </div>

      {/* Semi-Transparent Scroll-to-Top Button */}
      <div
        className={clsx(
          "absolute z-30 pointer-events-none transition-all duration-300 ease-out",
          isMobile ? "bottom-20 right-3" : "bottom-6 right-6",
          showScrollTop
            ? "opacity-100 translate-y-0"
            : "opacity-0 translate-y-3"
        )}
      >
        <button
          type="button"
          onClick={scrollToTop}
          aria-label={t("logs.scrollToTop")}
          title={t("logs.scrollToTop")}
          className={clsx(
            "pointer-events-auto group inline-flex items-center gap-1.5 rounded-full select-none",
            "backdrop-blur-md bg-white/70 hover:bg-white/90",
            "border border-gray-200/80 hover:border-gray-300",
            "text-gray-700 hover:text-gray-950",
            "shadow-sm hover:shadow active:scale-95 transition-all duration-200 cursor-pointer",
            isMobile ? "px-2.5 py-1.5 text-[11px]" : "px-3.5 py-2 text-xs"
          )}
        >
          <ArrowUp
            size={isMobile ? 13 : 15}
            strokeWidth={2.4}
            className="transition-transform duration-200 group-hover:scale-105"
          />
        </button>
      </div>
    </div>
  );
};
