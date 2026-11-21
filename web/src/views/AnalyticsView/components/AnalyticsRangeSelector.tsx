import React from "react";
import {
  ButtonGroup,
  Button,
  PopoverNext,
  H5,
  FormGroup,
  InputGroup,
  HTMLSelect,
  Tooltip,
  Intent
} from "@blueprintjs/core";
import { Calendar } from "lucide-react";
import { RefreshButton } from "../../../components/RefreshButton";
import { useTranslation } from "react-i18next";
import type { TimeRange } from "../types";
import type { AccessPoint } from "../../../services";
import {
  clampCustomInput,
  customRangeIssueKey,
  retentionMinInput,
  toLocalInputValue,
  validateCustomRange
} from "../../../utils/customRange";

export interface AnalyticsRangeSelectorProps {
  range: TimeRange;
  setRange: (range: TimeRange) => void;
  customRange: { start: string; end: string };
  setCustomRange: React.Dispatch<React.SetStateAction<{ start: string; end: string }>>;
  logRetentionDays: number;
  accessPoints: AccessPoint[];
  accessPointIdFilter: string | null;
  setAccessPointIdFilter: (id: string | null) => void;
  loading: boolean;
  onApplyCustom: () => void;
  /** Re-requests the current range from the server, bypassing the client cache. */
  onRefresh?: () => void;
  /** Seconds left before Refresh can be used again; the button stays disabled while above 0. */
  refreshWaitSec?: number;
  syncing?: boolean;
  syncProgress?: number;
  onSync?: () => void;
  onStopSync?: () => void;
}

const RANGE_PRESETS = [
  { key: "10m", days: 0.007 },
  { key: "1h", days: 0.0416 },
  { key: "24h", days: 1 },
  { key: "7d", days: 7 },
  { key: "30d", days: 30 }
];

export const AnalyticsRangeSelector: React.FC<AnalyticsRangeSelectorProps> = ({
  range,
  setRange,
  customRange,
  setCustomRange,
  logRetentionDays,
  accessPoints,
  accessPointIdFilter,
  setAccessPointIdFilter,
  loading,
  onApplyCustom,
  onRefresh,
  refreshWaitSec = 0
}) => {
  const { t } = useTranslation();
  const nowSec = Math.floor(Date.now() / 1000);
  const nowStr = toLocalInputValue(nowSec);
  // Nothing older than the retention can hold logs: the pickers start there instead of letting the user ask for it.
  const minStr = retentionMinInput(logRetentionDays, nowSec);
  const check = validateCustomRange(customRange.start, customRange.end, logRetentionDays, nowSec);
  const issueKey = customRangeIssueKey(check.issue);

  const visibleRanges = RANGE_PRESETS.filter((r) => r.days <= logRetentionDays).map(
    (r) => r.key as TimeRange
  );

  return (
    <div className="flex flex-wrap justify-between items-center gap-2 bg-white dark:bg-gray-900 p-2 rounded-lg shadow-sm border border-gray-100 dark:border-gray-800">
      <ButtonGroup variant="minimal" className="flex-wrap">
        {visibleRanges.map((r) => (
          <Tooltip key={r} content={t(`analytics.range${r}`)} placement="bottom" hoverOpenDelay={300} compact>
            <Button
              active={range === r}
              onClick={() => setRange(r)}
              text={r.toUpperCase()}
            />
          </Tooltip>
        ))}
        <Tooltip content={t("analytics.rangeCustom")} placement="bottom" hoverOpenDelay={300} compact>
        <PopoverNext
          content={
            <div className="p-4 space-y-4 w-64">
              <H5>{t("analytics.customRange")}</H5>
              <FormGroup label={t("analytics.startTime")}>
                <InputGroup
                  type="datetime-local"
                  min={minStr}
                  max={customRange.end || nowStr}
                  value={customRange.start}
                  intent={check.issue === "startAfterEnd" ? Intent.DANGER : Intent.NONE}
                  onChange={(e) =>
                    setCustomRange({
                      ...customRange,
                      start: clampCustomInput("start", e.target.value, logRetentionDays)
                    })
                  }
                />
              </FormGroup>
              <FormGroup label={t("analytics.endTime")}>
                <InputGroup
                  type="datetime-local"
                  min={customRange.start || minStr}
                  max={nowStr}
                  value={customRange.end}
                  intent={issueKey ? Intent.DANGER : Intent.NONE}
                  onChange={(e) =>
                    setCustomRange({
                      ...customRange,
                      end: clampCustomInput("end", e.target.value, logRetentionDays)
                    })
                  }
                />
              </FormGroup>
              {issueKey && (
                <div className="text-xs text-red-600 dark:text-red-400" role="alert">
                  {t(issueKey, { days: logRetentionDays })}
                </div>
              )}
              <Button
                fill
                intent={Intent.PRIMARY}
                disabled={!check.valid}
                text={t("analytics.apply")}
                onClick={onApplyCustom}
              />
            </div>
          }
        >
          <Button
            active={range === "custom"}
            icon={<Calendar size={14} className="mr-1" />}
            text={t("analytics.custom")}
          />
        </PopoverNext>
        </Tooltip>
      </ButtonGroup>
      <div className="flex items-center gap-2 min-w-0">
        {accessPoints.length > 0 && (
          <HTMLSelect
            value={accessPointIdFilter || ""}
            onChange={(e) => setAccessPointIdFilter(e.target.value || null)}
            options={[
              { label: `${t("logs.allAccessPoint")}`, value: "" },
              ...accessPoints.map((ap) => ({ label: ap.name, value: ap.id }))
            ]}
            minimal
          />
        )}
        {onRefresh && (
          <RefreshButton onClick={onRefresh} remainingSec={refreshWaitSec} loading={loading} />
        )}
      </div>
    </div>
  );
};
