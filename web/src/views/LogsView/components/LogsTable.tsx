import React, { useCallback, useMemo } from "react";
import { HTMLTable, Tag } from "@blueprintjs/core";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import type {  LogEntry  } from "../types";
import { DomainIcon } from "./DomainIcon";
import { getFlagEmoji } from "../../../utils/getFlagEmoji";

/** Which columns fit: "compact" drops Source and Reason, "medium" drops Reason, "full" shows everything. */
export type LogsTableDensity = "compact" | "medium" | "full";

export interface LogsTableProps {
  density?: LogsTableDensity;
  logs: LogEntry[];
  setSelectedLog: (log: LogEntry) => void;
  setIsDrawerOpen: (open: boolean) => void;
  lastLogElementRef: (node: HTMLDivElement | null) => void;
  prevLatestTimestamp: number | null;
  realtimeRefresh: boolean;
}

interface ColumnConfig {
  key: string;
  header: React.ReactNode;
  headerClassName?: string;
  cellClassName?: string;
  render: (log: LogEntry, idx: number) => React.ReactNode;
}

interface LogRowProps {
  log: LogEntry;
  columns: ColumnConfig[];
  idx: number;
  isNew: boolean;
  isLast: boolean;
  lastLogElementRef: (node: HTMLDivElement | null) => void;
  onSelect: (log: LogEntry) => void;
}

// A row only re-renders when its own log / highlight / position changes, so typing in the search box,
// toggling a filter or appending a page does not rebuild the hundreds of rows already on screen.
const LogRow = React.memo<LogRowProps>(({ log, columns, idx, isNew, isLast, lastLogElementRef, onSelect }) => (
  <tr
    onClick={() => onSelect(log)}
    className={clsx("cursor-pointer", { "animate-row-glow": isNew })}
    ref={isLast ? lastLogElementRef : null}
  >
    {columns.map((col) => (
      <td key={col.key} className={clsx("px-4 py-3", col.cellClassName)}>
        {col.render(log, idx)}
      </td>
    ))}
  </tr>
));
LogRow.displayName = "LogRow";

export const LogsTable: React.FC<LogsTableProps> = ({
  density = "full",
  logs,
  setSelectedLog,
  setIsDrawerOpen,
  lastLogElementRef,
  prevLatestTimestamp,
  realtimeRefresh,
}) => {
  const { t } = useTranslation();

  const onSelect = useCallback(
    (log: LogEntry) => {
      setSelectedLog(log);
      setIsDrawerOpen(true);
    },
    [setSelectedLog, setIsDrawerOpen]
  );

  // Rebuilt only when the language changes, which keeps the rows' `columns` prop stable.
  const columns: ColumnConfig[] = useMemo(() => [
    {
      key: "time",
      header: t("logs.tableTime"),
      headerClassName: "w-28 whitespace-nowrap rounded-tl-xl",
      cellClassName: "font-mono text-[11px] opacity-60 whitespace-nowrap",
      render: (log: LogEntry): React.ReactNode =>
        new Date(log.timestamp * 1000).toLocaleTimeString([], { hour12: false }),
    },
    {
      key: "domain",
      header: t("logs.tableDomain"),
      headerClassName: "w-[26%]",
      render: (log: LogEntry): React.ReactNode => {
        const isEncrypted = (log.encrypt_version ?? 0) > 0 || Boolean(log.kem_key_id || log.encrypted_payload);
        const isEncryptedLocked = isEncrypted && (!log.domain || log.domain === "[Encrypted]");
        const isEncryptedUnlocked = isEncrypted && Boolean(log.domain && log.domain !== "[Encrypted]");

        return (
          <div className="flex items-center gap-2 truncate">
            {isEncryptedLocked ? (
              <Lock size={14} className="text-amber-500 shrink-0" />
            ) : (
              <DomainIcon domain={log.domain} />
            )}
            <span
              className={clsx("font-bold text-sm truncate", {
                "italic text-gray-400": isEncryptedLocked,
              })}
            >
              {isEncryptedLocked ? t("logs.encryptedRecord", "[Encrypted Record]") : log.domain}
            </span>
            {isEncryptedUnlocked && (
              <span title={t("settings.e2eeEnabled", "Enabled")} className="inline-flex items-center">
                <Lock size={12} className="text-emerald-500 shrink-0 opacity-80" />
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "answer",
      header: t("logs.tableAnswer"),
      headerClassName: "w-36 md:w-44",
      cellClassName: "truncate font-mono text-[11px] opacity-70",
      render: (log: LogEntry): React.ReactNode => log.answer || "-",
    },
    {
      key: "source",
      header: t("logs.tableSource"),
      headerClassName: "w-24 md:w-28",
      render: (log: LogEntry): React.ReactNode => (
        <div className="flex items-center gap-2">
          <Tag minimal className="font-mono text-[10px]" title={log.geo_country || "Unknown"}>
            {getFlagEmoji(log.geo_country)}
          </Tag>
          {log.access_point_name && (
            <span className="text-xs opacity-70 truncate max-w-20" title={log.access_point_name}>
              {log.access_point_name}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "type",
      header: t("logs.tableType"),
      headerClassName: "w-16",
      cellClassName: "text-center",
      render: (log: LogEntry): React.ReactNode => <code className="text-[10px]">{log.record_type}</code>,
    },
    {
      key: "status",
      header: t("logs.tableStatus"),
      headerClassName: "w-24",
      cellClassName: "text-center",
      render: (log: LogEntry): React.ReactNode => (
        <span
          className={clsx("bp6-tag", "bp6-fill", "bp6-minimal", "bp6-round", {
            "bp6-intent-success": log.action === "PASS",
            "bp6-intent-danger": log.action === "BLOCK",
            "bp6-intent-warning": log.action === "REDIRECT",
          })}
        >
          <span className="bp6-text-overflow-ellipsis bp6-fill text-center">{log.action}</span>
        </span>
      ),
    },
    {
      key: "reason",
      header: t("logs.tableReason"),
      headerClassName: "w-auto rounded-tr-xl",
      cellClassName: "text-xs text-gray-500 italic truncate",
      render: (log: LogEntry): React.ReactNode => log.reason || "-",
    },
  ], [t]);

  // Hidden columns are removed (not just visually hidden) so the table never needs a horizontal scrollbar.
  const visibleColumns = useMemo(
    () =>
      columns
        .filter((col) => {
          if (col.key === "source") return density === "full";
          if (col.key === "reason") return density !== "compact";
          return true;
        })
        // Rounded header corners follow whichever columns are first/last.
        .map((col, i, arr) => ({
          ...col,
          headerClassName: clsx(
            col.headerClassName?.replace(/rounded-t[lr]-xl/g, "").trim(),
            i === 0 && "rounded-tl-xl",
            i === arr.length - 1 && "rounded-tr-xl"
          ),
        })),
    [columns, density]
  );

  return (
    <div className="w-full min-w-0 align-middle py-0">
      <div className="bg-white rounded-xl border border-[#d0d7de] shadow-xs overflow-x-auto">
        <HTMLTable interactive striped className="w-full table-fixed">
          <thead className="sticky top-0 z-20 backdrop-blur-md">
            <tr>
              {visibleColumns.map((col) => (
                <th
                  key={col.key}
                  className={clsx(
                    "px-4 py-3 text-xs font-bold uppercase text-gray-500 bg-white/80 border-b border-gray-100 whitespace-nowrap",
                    col.headerClassName
                  )}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {logs.map((log, idx) => (
              <LogRow
                key={log.id}
                log={log}
                columns={visibleColumns}
                idx={idx}
                isNew={realtimeRefresh && prevLatestTimestamp !== null && log.timestamp > prevLatestTimestamp}
                isLast={idx === logs.length - 1}
                lastLogElementRef={lastLogElementRef}
                onSelect={onSelect}
              />
            ))}
          </tbody>
        </HTMLTable>
      </div>
    </div>
  );
};
