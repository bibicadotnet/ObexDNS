import React, { useCallback, useMemo } from "react";
import { HTMLTable, Tag } from "@blueprintjs/core";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import type {  LogEntry  } from "../types";
import { DomainIcon } from "./DomainIcon";
import { EventBadge } from "./EventBadge";
import { answerWithChange } from "../utils/logEvent";
import { getFlagEmoji } from "../../../utils/getFlagEmoji";

export interface LogsTableProps {
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
      header: (
        <span title={t("logs.tableTimeHint")} className="cursor-help">
          {t("logs.tableTime")}
        </span>
      ),
      headerClassName: "w-24 rounded-tl-xl",
      cellClassName: "font-mono text-[11px] opacity-60",
      render: (log: LogEntry): React.ReactNode =>
        new Date(log.timestamp * 1000).toLocaleTimeString([], { hour12: false }),
    },
    {
      key: "domain",
      header: t("logs.tableDomain"),
      headerClassName: "w-1/4",
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
                "italic text-gray-400 dark:text-gray-500": isEncryptedLocked,
              })}
            >
              {isEncryptedLocked ? t("logs.encryptedRecord", "[加密记录]") : log.domain}
            </span>
            {isEncryptedUnlocked && (
              <span title={t("settings.e2eeEnabled", "已加密")} className="inline-flex items-center">
                <Lock size={12} className="text-emerald-500 shrink-0 opacity-80" />
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "event",
      header: t("logs.tableEvent"),
      headerClassName: "w-28",
      cellClassName: "text-center",
      render: (log: LogEntry): React.ReactNode => <EventBadge log={log} />,
    },
    {
      key: "answer",
      header: t("logs.tableAnswer"),
      headerClassName: "w-1/4",
      cellClassName: "truncate font-mono text-[11px] opacity-70",
      render: (log: LogEntry): React.ReactNode => {
        const text = answerWithChange(log);
        return <span title={log.prev_answer ? `${log.prev_answer} → ${log.answer || ""}` : log.answer || undefined}>{text}</span>;
      },
    },
    {
      key: "source",
      header: t("logs.tableSource"),
      headerClassName: "w-32",
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
      headerClassName: "w-20",
      cellClassName: "text-center",
      render: (log: LogEntry): React.ReactNode => <code className="text-[10px]">{log.record_type}</code>,
    },
    {
      key: "status",
      header: t("logs.tableStatus"),
      headerClassName: "w-28",
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
      headerClassName: "rounded-tr-xl",
      cellClassName: "text-xs text-gray-500 italic truncate",
      render: (log: LogEntry): React.ReactNode => log.reason || "-",
    },
  ], [t]);

  return (
    <div className="min-w-full inline-block align-middle py-0">
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm overflow-visible">
        <HTMLTable interactive striped className="w-full table-fixed">
          <thead className="sticky top-0 z-20 backdrop-blur-md">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={clsx(
                    "px-4 py-3 text-xs font-bold uppercase text-gray-500 bg-white/80 dark:bg-gray-900/80 border-b border-gray-100 dark:border-gray-800",
                    col.headerClassName
                  )}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {logs.map((log, idx) => (
              <LogRow
                key={log.id}
                log={log}
                columns={columns}
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
