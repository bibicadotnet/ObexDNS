import React from "react";
import { Button, PopoverNext, H5, FormGroup, InputGroup, Intent } from "@blueprintjs/core";
import { Calendar } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TimeRange } from "../types";
import {
  clampCustomInput,
  customRangeIssueKey,
  retentionMinInput,
  validateCustomRange
} from "../../../utils/customRange";

export interface TimeRangeSelectorProps {
  range: TimeRange;
  setRange: (r: TimeRange) => void;
  customRange: { start: string; end: string };
  setCustomRange: (cr: { start: string; end: string }) => void;
  nowStr: string;
  fetchLogs: (range: TimeRange, initial: boolean) => void;
  isMobile: boolean;
  logRetentionDays: number;
}

export const TimeRangeSelector: React.FC<TimeRangeSelectorProps> = ({
  range,
  setRange,
  customRange,
  setCustomRange,
  nowStr,
  fetchLogs,
  isMobile,
  logRetentionDays,
}) => {
  const { t } = useTranslation();

  const RANGE_PRESETS = [
    { key: "10m", days: 0.007 },
    { key: "1h", days: 0.0416 },
    { key: "24h", days: 1 },
    { key: "7d", days: 7 },
    { key: "30d", days: 30 },
  ];
  const visibleRanges = RANGE_PRESETS.filter(r => r.days <= logRetentionDays).map(r => r.key as TimeRange);

  // Nothing older than the retention can hold logs: the pickers start there instead of letting the user ask for it.
  const minStr = retentionMinInput(logRetentionDays);
  const check = validateCustomRange(customRange.start, customRange.end, logRetentionDays);
  const issueKey = customRangeIssueKey(check.issue);

  return (
    <div className="max-w-full">
      <div className="inline-flex items-center p-0.5 bg-[#f3f4f6] rounded-lg border border-[#d0d7de] text-xs font-medium flex-wrap gap-0.5">
        {visibleRanges.map((r) => {
          const isActive = range === r;
          return (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all duration-150 cursor-pointer ${
                isActive
                  ? "bg-white text-[#111827] shadow-xs border border-[#d0d7de]/80 font-bold"
                  : "text-[#6b7280] hover:text-[#111827] hover:bg-white/50 border border-transparent"
              }`}
            >
              {r.toUpperCase()}
            </button>
          );
        })}
        <PopoverNext
          placement="bottom-end"
          content={
            <div className="p-4 space-y-3 w-64 bg-white rounded-lg">
              <H5 className="text-sm font-bold text-[#111827] m-0">{t("analytics.customRange")}</H5>
              <FormGroup label={t("analytics.startTime")} className="mb-2!">
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
              <FormGroup label={t("analytics.endTime")} className="mb-2!">
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
                <div className="text-xs text-red-600 mb-2" role="alert">
                  {t(issueKey, { days: logRetentionDays })}
                </div>
              )}
              <Button
                fill
                intent={Intent.PRIMARY}
                disabled={!check.valid}
                text={t("analytics.apply")}
                onClick={() => {
                  setRange("custom");
                  fetchLogs("custom", true);
                }}
              />
            </div>
          }
        >
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md transition-all duration-150 cursor-pointer ${
              range === "custom"
                ? "bg-white text-[#111827] shadow-xs border border-[#d0d7de]/80 font-bold"
                : "text-[#6b7280] hover:text-[#111827] hover:bg-white/50 border border-transparent"
            }`}
          >
            <Calendar size={13} />
            <span className={isMobile ? "hidden" : "inline"}>{t("analytics.custom")}</span>
          </button>
        </PopoverNext>
      </div>
    </div>
  );
};
