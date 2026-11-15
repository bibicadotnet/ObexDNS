import React from "react";
import { HTMLTable, Tag, Intent, Switch, Tooltip } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "../../../utils/date";
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

export const ListsTable: React.FC<ListsTableProps> = ({ lists, onSelect, onToggleEnabled, pendingIds }) => {
  const { t } = useTranslation();

  const columns: ColumnConfig[] = [
    {
      key: "name",
      header: t("filtering.tableName", "List"),
      // whitespace-normal: the table is nowrap, but the description must wrap onto several lines
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
                  <Tag intent={Intent.PRIMARY} icon="star" minimal className="shrink-0">
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
      cellClassName: "text-xs opacity-60",
      render: (list: FilterList): React.ReactNode =>
        list.last_synced_at
          ? formatDateTime(new Date(list.last_synced_at * 1000))
          : t("filtering.neverSynced"),
    },
    {
      key: "status",
      header: t("filtering.tableStatus"),
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
          <div className="flex items-center gap-2">
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

  return (
    <div className="w-full max-w-full overflow-x-auto pb-4">
      <HTMLTable interactive striped className="w-full min-w-max whitespace-nowrap">
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
          {lists.map((list) => (
            <tr key={list.id} onClick={() => onSelect(list)} className="cursor-pointer">
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={col.cellClassName}
                  // Accent bar on the left edge of recommended lists so they stand out while scanning the table
                  style={col.key === "name" && list.is_default ? { boxShadow: "inset 3px 0 0 var(--bp6-intent-primary-color, #2d72d2)" } : undefined}
                  // Stop at the <td> (not an inner div) so the cell padding and the empty
                  // space around the switch don't open the details dialog either.
                  onClick={col.stopRowClick ? (e) => e.stopPropagation() : undefined}
                >
                  {col.render(list)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </HTMLTable>
    </div>
  );
};
