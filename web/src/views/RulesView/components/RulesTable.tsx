import React, { useState, useMemo } from "react";
import { HTMLTable, Tag, Intent, HTMLSelect, Button, Switch, Tooltip } from "@blueprintjs/core";
import { ShieldX, CheckCircle, ArrowRightLeft, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import { CompactDateTime } from "../../../components/CompactDateTime";
import { useContainerWidth } from "../../../hooks/useContainerWidth";
import { useIsMobile } from "../../../hooks/useIsMobile";
import type { Rule, RulesTableProps } from "../types";

type SortField = "status" | "action" | "pattern" | "details" | "created_at";

/** Below this container width the table is replaced by cards, so there is never a horizontal scrollbar. */
const TABLE_MIN_WIDTH = 640;
type SortOrder = "asc" | "desc";

interface ColumnConfig {
  key: SortField;
  header: React.ReactNode;
  headerClassName?: string;
  cellClassName?: string;
  stopRowClick?: boolean;
  render: (rule: Rule) => React.ReactNode;
}

export const RulesTable: React.FC<RulesTableProps> = ({
  rules,
  startEdit,
  getBlockDetail,
  onToggleEnabled,
  pendingIds,
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [sortField, setSortField] = useState<SortField>("created_at");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [containerRef, containerWidth] = useContainerWidth();
  const showCards = containerWidth > 0 ? containerWidth < TABLE_MIN_WIDTH : isMobile;

  const handleHeaderClick = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder(field === "created_at" ? "desc" : "asc");
    }
  };

  const getRuleDetailString = (rule: Rule): string => {
    if (rule.type === "REDIRECT") {
      return [rule.v_a, rule.v_aaaa, rule.v_cname, rule.v_txt].filter(Boolean).join(" ");
    }
    if (rule.type === "BLOCK") {
      return getBlockDetail();
    }
    return t("rules.detailAllow", "Forward to upstream");
  };

  const sortedRules = useMemo(() => {
    return [...rules].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "status": {
          const aEnabled = a.enabled !== false && (a.enabled as any) !== 0 ? 1 : 0;
          const bEnabled = b.enabled !== false && (b.enabled as any) !== 0 ? 1 : 0;
          cmp = aEnabled - bEnabled;
          break;
        }
        case "action":
          cmp = a.type.localeCompare(b.type);
          break;
        case "pattern":
          cmp = a.pattern.localeCompare(b.pattern);
          break;
        case "details":
          cmp = getRuleDetailString(a).localeCompare(getRuleDetailString(b));
          break;
        case "created_at": {
          const timeA = a.created_at ?? a.id;
          const timeB = b.created_at ?? b.id;
          cmp = timeA - timeB;
          break;
        }
      }
      if (cmp === 0) {
        cmp = a.id - b.id;
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });
  }, [rules, sortField, sortOrder, getBlockDetail, t]);

  const columns: ColumnConfig[] = [
    {
      key: "action",
      header: t("rules.tableAction"),
      headerClassName: "w-28 whitespace-nowrap",
      cellClassName: "whitespace-nowrap align-middle",
      render: (rule: Rule): React.ReactNode => (
        <>
          {rule.type === "BLOCK" && (
            <Tag intent={Intent.DANGER} minimal icon={<ShieldX size={12} className="mr-1" />}>
              {t("rules.labelBlock")}
            </Tag>
          )}
          {rule.type === "ALLOW" && (
            <Tag intent={Intent.SUCCESS} minimal icon={<CheckCircle size={12} className="mr-1" />}>
              {t("rules.labelAllow")}
            </Tag>
          )}
          {rule.type === "REDIRECT" && (
            <Tag intent={Intent.WARNING} minimal icon={<ArrowRightLeft size={12} className="mr-1" />}>
              {t("rules.labelRedirect")}
            </Tag>
          )}
        </>
      ),
    },
    {
      key: "pattern",
      header: t("rules.tablePattern"),
      headerClassName: "min-w-[180px] max-w-sm md:max-w-md",
      cellClassName: "font-mono font-bold break-all align-middle text-xs sm:text-sm",
      render: (rule: Rule): React.ReactNode => (
        <span className="break-all" title={rule.pattern}>
          {rule.pattern}
        </span>
      ),
    },
    {
      key: "details",
      header: t("rules.tableDetails"),
      headerClassName: "min-w-[140px]",
      cellClassName: "py-2 align-middle break-all",
      render: (rule: Rule): React.ReactNode => (
        <>
          {rule.type === "REDIRECT" ? (
            <div className="flex flex-wrap gap-1.5">
              {rule.v_a && (
                <Tag minimal className="font-mono text-[10px] break-all">
                  A: {rule.v_a}
                </Tag>
              )}
              {rule.v_aaaa && (
                <Tag minimal className="font-mono text-[10px] break-all">
                  AAAA: {rule.v_aaaa}
                </Tag>
              )}
              {rule.v_cname && (
                <Tag minimal className="font-mono text-[10px] break-all">
                  CNAME: {rule.v_cname}
                </Tag>
              )}
              {rule.v_txt && (
                <Tag minimal className="font-mono text-[10px] break-all">
                  TXT: {rule.v_txt}
                </Tag>
              )}
            </div>
          ) : rule.type === "BLOCK" ? (
            <div className="flex items-center gap-2">
              <span className="text-gray-400 text-xs italic">{t("rules.detailBlock")}</span>
              <Tag minimal round className="text-[9px] px-1.5 opacity-70">
                {getBlockDetail()}
              </Tag>
            </div>
          ) : (
            <span className="text-gray-400 text-xs italic">{t("rules.detailAllow")}</span>
          )}
        </>
      ),
    },
    {
      key: "status",
      header: t("rules.tableStatus", "Status"),
      headerClassName: "w-20 text-center whitespace-nowrap",
      cellClassName: "w-20 text-center align-middle whitespace-nowrap",
      stopRowClick: true,
      render: (rule: Rule): React.ReactNode => {
        const enabled = rule.enabled !== false && (rule.enabled as any) !== 0;
        return (
          <div className="flex justify-center items-center" onClick={(e) => e.stopPropagation()}>
            <Tooltip
              content={enabled ? t("rules.statusNormal", "Active") : t("rules.statusDisabled", "Disabled")}
              placement="top"
              hoverOpenDelay={200}
            >
              <Switch
                className="mb-0! cursor-pointer"
                checked={enabled}
                disabled={pendingIds?.has(rule.id)}
                onChange={(e) => {
                  onToggleEnabled?.(rule.id, (e.target as HTMLInputElement).checked);
                }}
              />
            </Tooltip>
          </div>
        );
      },
    },
    {
      key: "created_at",
      header: t("rules.tableCreatedAt", "Added Time"),
      headerClassName: "w-36 sm:w-44 whitespace-nowrap text-right",
      cellClassName: "align-middle whitespace-nowrap text-right",
      render: (rule: Rule): React.ReactNode => (
        <CompactDateTime timestamp={rule.created_at} align="right" />
      ),
    },
  ];

  const column = (key: SortField) => columns.find((c) => c.key === key)!;

  const sortOptions = columns.map((col) => ({ value: col.key, label: String(col.header) }));

  if (showCards) {
    return (
      <div ref={containerRef} className="w-full min-w-0 pb-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <HTMLSelect
            minimal
            value={sortField}
            options={sortOptions}
            onChange={(e) => {
              const field = e.target.value as SortField;
              setSortField(field);
              setSortOrder(field === "created_at" ? "desc" : "asc");
            }}
            aria-label={t("rules.clickToSort", "Click to sort")}
          />
          <Button
            variant="minimal"
            icon={sortOrder === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
            onClick={() => setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"))}
            aria-label={t("rules.clickToSort", "Click to sort")}
          />
        </div>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {sortedRules.map((rule) => {
            const enabled = rule.enabled !== false && (rule.enabled as any) !== 0;
            return (
              <li key={rule.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => startEdit(rule)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") startEdit(rule);
                  }}
                  className={clsx(
                    "w-full min-w-0 cursor-pointer rounded-lg border border-gray-200 bg-white p-3 text-left transition-colors hover:bg-gray-50",
                    !enabled && "opacity-60 bg-gray-50/60"
                  )}
                >
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 shrink-0">
                      <div>{column("action").render(rule)}</div>
                      <div onClick={(e) => e.stopPropagation()}>
                        <Tooltip
                          content={enabled ? t("rules.statusNormal", "Active") : t("rules.statusDisabled", "Disabled")}
                          placement="top"
                          hoverOpenDelay={200}
                        >
                          <Switch
                            className="mb-0! cursor-pointer scale-90 origin-left"
                            checked={enabled}
                            disabled={pendingIds?.has(rule.id)}
                            onChange={(e) => {
                              onToggleEnabled?.(rule.id, (e.target as HTMLInputElement).checked);
                            }}
                          />
                        </Tooltip>
                      </div>
                    </div>
                    <span className="truncate text-xs text-gray-500">{column("created_at").render(rule)}</span>
                  </div>
                  <div className="break-all font-mono text-sm font-bold">{rule.pattern}</div>
                  <div className="mt-1.5 min-w-0 break-all">{column("details").render(rule)}</div>
                </div>
              </li>
            );
          })}
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
              <th
                key={col.key}
                onClick={() => handleHeaderClick(col.key)}
                className={clsx(
                  col.headerClassName,
                  "cursor-pointer select-none transition-colors hover:text-blue-500"
                )}
                title={t("rules.clickToSort", "Click to sort")}
              >
                <div
                  className={clsx(
                    "flex items-center gap-1.5",
                    col.key === "created_at" && "justify-end",
                    col.key === "status" && "justify-center"
                  )}
                >
                  <span>{col.header}</span>
                  {sortField === col.key ? (
                    sortOrder === "asc" ? (
                      <ArrowUp size={13} className="text-blue-500 shrink-0" />
                    ) : (
                      <ArrowDown size={13} className="text-blue-500 shrink-0" />
                    )
                  ) : (
                    <ArrowUpDown size={12} className="opacity-30 hover:opacity-75 shrink-0" />
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRules.map((rule) => {
            const enabled = rule.enabled !== false && (rule.enabled as any) !== 0;
            return (
              <tr
                key={rule.id}
                onClick={() => startEdit(rule)}
                className={clsx("cursor-pointer", !enabled && "opacity-60")}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={col.cellClassName}
                    onClick={col.stopRowClick ? (e) => e.stopPropagation() : undefined}
                  >
                    {col.render(rule)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </HTMLTable>
    </div>
  );
};
