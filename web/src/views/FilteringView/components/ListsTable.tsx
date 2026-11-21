import React from "react";
import { HTMLTable, Tag, Intent, Switch, Tooltip } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "../../../utils/date";
import { useContainerWidth } from "../../../hooks/useContainerWidth";
import type { FilterList } from "../types";
import { getListDisplay } from "../utils";
import { parseSyncStatus, limitWarningText } from "../syncStatus";

export interface ListsTableProps {
  lists: FilterList[];
  onSelect: (list: FilterList) => void;
  /** Enables or disables a list directly from the table row. */
  onToggleEnabled: (id: number, enabled: boolean) => void;
  /** Ids whose toggle request is still in flight (their switch is locked). */
  pendingIds?: ReadonlySet<number>;
}

interface ColumnConfig {
  key: string;
  header: React.ReactNode;
  headerClassName?: string;
  cellClassName?: string;
  /** Interactive cells swallow row clicks across their whole area (padding included). */
  stopRowClick?: boolean;
  render: (list: FilterList) => React.ReactNode;
}

/** Below this container width the table is replaced by cards, so there is never a horizontal scrollbar. */
const TABLE_MIN_WIDTH = 720;

export const ListsTable: React.FC<ListsTableProps> = ({ lists, onSelect, onToggleEnabled, pendingIds }) => {
  const { t } = useTranslation();
  const [containerRef, containerWidth] = useContainerWidth();
  // 0 = not measured yet (first paint): assume the wide layout, the real width arrives before the browser paints.
  const showCards = containerWidth > 0 && containerWidth < TABLE_MIN_WIDTH;

  // Built-in (admin-provided) lists first, recommended ones leading; user-added lists below.
  // Group headings only appear when both kinds exist: a single kind reads fine as a plain list.
  const builtIn = lists.filter((l) => l.is_system).sort((a, b) => Number(!!b.is_default) - Number(!!a.is_default));
  const custom = lists.filter((l) => !l.is_system);
  const groups: { key: string; title?: string; items: FilterList[] }[] =
    builtIn.length > 0 && custom.length > 0
      ? [
          { key: "builtin", title: t("filtering.groupBuiltIn", "Built-in lists"), items: builtIn },
          { key: "custom", title: t("filtering.groupCustom", "Custom lists"), items: custom },
        ]
      : [{ key: "all", items: [...builtIn, ...custom] }];

  const columns: ColumnConfig[] = [
    {
      key: "name",
      header: t("filtering.tableName", "List"),
      cellClassName: "max-w-xl whitespace-normal",
      render: (list: FilterList): React.ReactNode => {
        // The source URL is intentionally not shown here: it lives in the details dialog.
        const { name } = getListDisplay(list);
        const description = list.description?.trim();
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className="text-sm font-medium truncate">{name}</div>
              {list.is_default && (
                <Tooltip
                  content={t(
                    "filtering.defaultBadgeHint",
                    "Default list recommended by the administrator. Applied automatically to new profiles."
                  )}
                  placement="top"
                >
                  <Tag intent={Intent.PRIMARY} minimal className="shrink-0">
                    {t("filtering.defaultBadge", "Recommended")}
                  </Tag>
                </Tooltip>
              )}
            </div>
            {description && (
              <div className="text-xs opacity-70 line-clamp-3 break-words" title={description}>
                {description}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "lastSync",
      header: t("filtering.tableLastSync"),
      cellClassName: "text-xs opacity-60 whitespace-nowrap",
      render: (list: FilterList): React.ReactNode =>
        list.last_synced_at
          ? formatDateTime(new Date(list.last_synced_at * 1000))
          : t("filtering.neverSynced"),
    },
    {
      key: "status",
      header: t("filtering.tableStatus"),
      cellClassName: "whitespace-normal",
      stopRowClick: true,
      render: (list: FilterList): React.ReactNode => {
        const enabled = !!list.enabled;
        const syncStatus = parseSyncStatus(list.sync_error);
        const hasError = !!syncStatus.error;
        const hasSynced = !!list.last_synced_at;

        // Sync health only matters while the list is on: a disabled list contributes
        // nothing, so reporting freshness for it would contradict the switch.
        let problem: { text: string; intent: Intent } | null = null;
        if (enabled && hasError) {
          problem = hasSynced
            ? { text: t("filtering.statusOutdated", "Outdated"), intent: Intent.WARNING }
            : { text: t("filtering.statusMissing", "Missing"), intent: Intent.DANGER };
        }

        return (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Switch
              className="mb-0!"
              checked={enabled}
              disabled={pendingIds?.has(list.id)}
              label={enabled ? t("filtering.statusNormal", "Active") : t("filtering.statusDisabled", "Disabled")}
              onChange={(e) => onToggleEnabled(list.id, (e.target as HTMLInputElement).checked)}
            />
            {problem && (
              <Tooltip content={syncStatus.error || problem.text} placement="top">
                <Tag intent={problem.intent} minimal>
                  {problem.text}
                </Tag>
              </Tooltip>
            )}
            {enabled && syncStatus.warnings.length > 0 && (
              <Tooltip
                content={syncStatus.warnings.map((w) => limitWarningText(t, w)).join(" ")}
                placement="top"
              >
                <Tag intent={Intent.WARNING} minimal>
                  {t("filtering.statusTruncated", "Truncated")}
                </Tag>
              </Tooltip>
            )}
          </div>
        );
      },
    },
  ];

  if (showCards) {
    const nameCol = columns.find((c) => c.key === "name")!;
    const syncCol = columns.find((c) => c.key === "lastSync")!;
    const statusCol = columns.find((c) => c.key === "status")!;
    return (
      <div ref={containerRef} className="w-full min-w-0 pb-4">
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {groups.map((group) => (
            <React.Fragment key={group.key}>
              {group.title && (
                <li className="px-1 pt-2 text-xs font-semibold uppercase tracking-wide opacity-60">
                  {group.title} · {group.items.length}
                </li>
              )}
              {group.items.map((list) => (
            <li
              key={list.id}
              onClick={() => onSelect(list)}
              className="cursor-pointer rounded-lg border border-gray-200 bg-white p-3 transition-colors hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-800/60"
            >
              {nameCol.render(list)}
              <div
                className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
                // The switch must not open the details dialog
                onClick={(e) => e.stopPropagation()}
              >
                {statusCol.render(list)}
                <span className="text-xs opacity-60">
                  {t("filtering.tableLastSync")}: {syncCol.render(list)}
                </span>
              </div>
            </li>
              ))}
            </React.Fragment>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full min-w-0 pb-4">
      <HTMLTable interactive striped className="w-full">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} className={col.headerClassName}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <React.Fragment key={group.key}>
              {group.title && (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="pt-4! pb-1.5! text-xs font-semibold uppercase tracking-wide opacity-60 bg-transparent!"
                  >
                    {group.title} · {group.items.length}
                  </td>
                </tr>
              )}
              {group.items.map((list) => (
            <tr key={list.id} onClick={() => onSelect(list)} className="cursor-pointer">
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={col.cellClassName}
                  // Stop at the <td> (not an inner div) so the cell padding and the empty
                  // space around the switch don't open the details dialog either.
                  onClick={col.stopRowClick ? (e) => e.stopPropagation() : undefined}
                >
                  {col.render(list)}
                </td>
              ))}
            </tr>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </HTMLTable>
    </div>
  );
};
