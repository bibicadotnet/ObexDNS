import React from "react";
import { Card, Elevation, H5, HTMLTable, Tag, Intent } from "@blueprintjs/core";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DomainIcon } from "../../LogsView/components/DomainIcon";

export interface RankTableProps {
  title: string;
  data: { domain: string; count: number }[];
  intent: Intent;
}

interface ColumnConfig {
  key: string;
  cellClassName?: string;
  render: (row: { domain: string; count: number }, index: number) => React.ReactNode;
}

const RankTableImpl: React.FC<RankTableProps> = ({ title, data, intent }) => {
  const { t } = useTranslation();

  const columns: ColumnConfig[] = [
    {
      key: "rank",
      cellClassName: "w-8 opacity-30 font-mono text-xs",
      render: (_: { domain: string; count: number }, i: number): React.ReactNode => i + 1,
    },
    {
      key: "domain",
      cellClassName: "font-medium text-sm max-w-50",
      render: (d: { domain: string; count: number }): React.ReactNode => {
        if (d.domain === "[Encrypted]") {
          return (
            <span className="inline-flex items-center gap-1.5 text-gray-400 italic font-normal">
              <Lock size={14} className="text-amber-500 shrink-0" />
              <span>{t("logs.encryptedRecord", "[加密记录]")}</span>
            </span>
          );
        }
        if (d.domain === "[Decryption Failed]") {
          return (
            <span className="inline-flex items-center gap-1.5 text-red-400 italic font-normal">
              <Lock size={14} className="text-red-500 shrink-0" />
              <span>{t("logs.decryptionFailed", "[解密失败]")}</span>
            </span>
          );
        }
        return (
          <span className="flex items-center gap-2 min-w-0" title={d.domain}>
            <DomainIcon domain={d.domain} />
            <span className="truncate">{d.domain}</span>
          </span>
        );
      },
    },
    {
      key: "count",
      cellClassName: "text-right",
      render: (d: { domain: string; count: number }): React.ReactNode => (
        <Tag minimal intent={intent} className="font-bold">
          {d.count}
        </Tag>
      ),
    },
  ];

  return (
    <Card elevation={Elevation.ZERO} className="border border-gray-100 shadow-sm">
      <H5 className="section-title mb-4!">{title}</H5>
      <HTMLTable striped className="w-full">
        <tbody>
          {data.map((d, i) => (
            <tr key={i}>
              {columns.map((col) => (
                <td key={col.key} className={col.cellClassName}>
                  {col.render(d, i)}
                </td>
              ))}
            </tr>
          ))}
          {data.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="text-center py-8 opacity-50">
                {t("analytics.noData")}
              </td>
            </tr>
          )}
        </tbody>
      </HTMLTable>
    </Card>
  );
};

/** Re-renders only when its own rows change, not on every loading flag flip of the page. */
export const RankTable = React.memo(RankTableImpl);
