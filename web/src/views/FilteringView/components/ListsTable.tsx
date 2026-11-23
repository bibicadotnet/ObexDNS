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
  /** Admin cap on custom lists; shown as "n/max" on the custom group heading. */
  maxCustomLists?: number;
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
const TABLE_MIN_WIDTH = 768;

export const ListsTable: React.FC<ListsTableProps> = ({ lists, maxCustomLists, onSelect, onToggleEnabled, pendingIds }) => {
  const { t } = useTranslation();
  const [containerRef, containerWidth] = useContainerWidth();
  const showCards = containerWidth > 0 && containerWidth < TABLE_MIN_WIDTH;

  // Built-in (admin-provided) lists first, recommended ones leading; user-added lists below.
  const builtIn = lists.filter((l) => l.is_system).sort((a, b) => Number(!!b.is_default) - Number(!!a.is_default));
  const custom = lists.filter((l) => !l.is_system);
  const groups: { key: string; title?: string; items: FilterList[]; max?: number }[] =
    builtIn.length > 0 && custom.length > 0
      ? [
          { key: "builtin", title: t("filtering.groupBuiltIn", "Built-in lists"), items: builtIn },
          { key: "custom", title: t("filtering.groupCustom", "Custom lists"), items: custom, max: maxCustomLists },
        ]
      : [{ key: "all", items: [...builtIn, ...custom] }];

  const countLabel = (g: { items: FilterList[]; max?: number }) => (g.max ? `${g.items.length}/${g.max}` : g.items.length);
  const countIntent = (g: { items: FilterList[]; max?: number }) =>
    g.max && g.items.length >= g.max ? Intent.WARNING : Intent.PRIMARY;

  const columns: ColumnConfig[] = [
    {
      key: "name",
      header: t("filtering.tableName", "List"),
      headerClassName: "w-full text-left font-semibold text-xs text-gray-500 uppercase tracking-wider py-3",
      cellClassName: "w-full align-middle py-3 pr-4 min-w-0",
      render: (list: FilterList): React.ReactNode => {
        const { name } = getListDisplay(list, t);
        const description = list.description?.trim();
        const enabled = !!list.enabled;
        const syncStatus = parseSyncStatus(list.sync_error);
        const hasError = !!syncStatus.error;
        const hasSynced = !!list.last_synced_at;

        let problem: { text: string; intent: Intent } | null = null;
        if (enabled && hasError) {
          problem = hasSynced
            ? { text: t("filtering.statusOutdated", "Outdated"), intent: Intent.WARNING }
            : { text: t("filtering.statusMissing", "Missing"), intent: Intent.DANGER };
        }

        return (
          <div className="min-w-0 pr-2">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <span className="text-sm font-semibold text-[#111827] truncate" title={name}>
                {name}
              </span>
              {list.is_default && (
                <Tooltip
                  content={t(
                    "filtering.defaultBadgeHint",
                    "Default list recommended by the administrator. Applied automatically to new profiles."
                  )}
                  placement="top"
                >
                  <Tag intent={Intent.PRIMARY} minimal className="shrink-0 text-[10px] font-semibold">
                    {t("filtering.defaultBadge", "Recommended")}
                  </Tag>
                </Tooltip>
              )}
              {enabled && syncStatus.warnings.length > 0 && (
                <Tooltip
                  content={syncStatus.warnings.map((w) => limitWarningText(t, w)).join(" ")}
                  placement="top"
                >
                  <Tag intent={Intent.WARNING} minimal className="shrink-0 text-[10px] font-semibold">
                    {t("filtering.statusTruncated", "Truncated")}
                  </Tag>
                </Tooltip>
              )}
              {problem && (
                <Tooltip content={syncStatus.error || problem.text} placement="top">
                  <Tag intent={problem.intent} minimal className="shrink-0 text-[10px] font-semibold">
                    {problem.text}
                  </Tag>
                </Tooltip>
              )}
            </div>
            {description && (
              <div className="text-xs text-[#6b7280] line-clamp-2 break-words mt-1 leading-relaxed" title={description}>
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
      headerClassName: "w-px whitespace-nowrap text-left font-semibold text-xs text-gray-500 uppercase tracking-wider py-3 px-4",
      cellClassName: "w-px whitespace-nowrap align-middle text-xs text-[#6b7280] py-3 px-4",
      render: (list: FilterList): React.ReactNode =>
        list.last_synced_at
          ? formatDateTime(new Date(list.last_synced_at * 1000))
          : t("filtering.neverSynced"),
    },
    {
      key: "status",
      header: t("filtering.tableStatus"),
      headerClassName: "w-32 min-w-[120px] text-center font-semibold text-xs text-gray-500 uppercase tracking-wider py-3 px-3 whitespace-nowrap",
      cellClassName: "w-32 min-w-[120px] align-middle text-center whitespace-nowrap py-3 px-3",
      stopRowClick: true,
      render: (list: FilterList): React.ReactNode => {
        const enabled = !!list.enabled;

        return (
          <div className="flex justify-center items-center">
            <Tooltip
              content={enabled ? t("filtering.statusNormal", "Active") : t("filtering.statusDisabled", "Disabled")}
              placement="top"
              hoverOpenDelay={200}
            >
              <Switch
                className="mb-0! cursor-pointer"
                checked={enabled}
                disabled={pendingIds?.has(list.id)}
                onChange={(e) => onToggleEnabled(list.id, (e.target as HTMLInputElement).checked)}
              />
            </Tooltip>
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
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {groups.map((group) => (
            <React.Fragment key={group.key}>
              {group.title && (
                <li className="flex items-center gap-2 px-1 pt-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{group.title}</span>
                  <Tag minimal round intent={countIntent(group)} className="text-xs">
                    {countLabel(group)}
                  </Tag>
                </li>
              )}
              {group.items.map((list) => (
                <li
                  key={list.id}
                  onClick={() => onSelect(list)}
                  className="cursor-pointer rounded-xl border border-[#d0d7de] bg-white p-4 shadow-xs transition-colors hover:bg-gray-50"
                >
                  {nameCol.render(list)}
                  <div
                    className="mt-3 flex items-center justify-between gap-3 pt-2.5 border-t border-gray-100"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="text-xs text-gray-500 whitespace-nowrap">
                      {syncCol.render(list)}
                    </span>
                    <div className="shrink-0">
                      {statusCol.render(list)}
                    </div>
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
    <div ref={containerRef} className="w-full min-w-0 pb-4 overflow-x-auto">
      <HTMLTable interactive striped className="w-full border-collapse">
        <thead>
          <tr className="border-b border-[#d0d7de]">
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
                  <td colSpan={columns.length} className="pt-4! pb-1.5! bg-transparent! border-none!">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{group.title}</span>
                      <Tag minimal round intent={countIntent(group)} className="text-xs">
                        {countLabel(group)}
                      </Tag>
                    </div>
                  </td>
                </tr>
              )}
              {group.items.map((list) => (
                <tr key={list.id} onClick={() => onSelect(list)} className="cursor-pointer hover:bg-gray-50/70 transition-colors">
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={col.cellClassName}
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
