import React, { useState, useMemo } from "react";
import { HTMLTable, Tag, Intent } from "@blueprintjs/core";
import { ShieldX, CheckCircle, ArrowRightLeft, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import { formatDateTime } from "../../../utils/date";
import type { Rule } from "../types";

export interface RulesTableProps {
  rules: Rule[];
  startEdit: (rule: Rule) => void;
  getBlockDetail: () => string;
}

type SortField = "action" | "pattern" | "details" | "created_at";
type SortOrder = "asc" | "desc";

interface ColumnConfig {
  key: SortField;
  header: React.ReactNode;
  headerClassName?: string;
  cellClassName?: string;
  render: (rule: Rule) => React.ReactNode;
}

export const RulesTable: React.FC<RulesTableProps> = ({ rules, startEdit, getBlockDetail }) => {
  const { t } = useTranslation();
  const [sortField, setSortField] = useState<SortField>("created_at");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

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
      key: "created_at",
      header: t("rules.tableCreatedAt", "添加时间"),
      headerClassName: "w-36 sm:w-44 whitespace-nowrap text-right",
      cellClassName: "text-xs text-gray-500 align-middle whitespace-nowrap text-right",
      render: (rule: Rule): React.ReactNode => (
        rule.created_at ? formatDateTime(new Date(rule.created_at * 1000)) : "—"
      ),
    },
  ];

  return (
    <div className="w-full max-w-full overflow-x-auto pb-4">
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
                title={t("rules.clickToSort", "点击排序")}
              >
                <div
                  className={clsx(
                    "flex items-center gap-1.5",
                    col.key === "created_at" && "justify-end"
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
          {sortedRules.map((rule) => (
            <tr key={rule.id} onClick={() => startEdit(rule)} className="cursor-pointer">
              {columns.map((col) => (
                <td key={col.key} className={col.cellClassName}>
                  {col.render(rule)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </HTMLTable>
    </div>
  );
};

