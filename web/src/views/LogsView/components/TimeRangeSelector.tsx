import React from "react";
import { ButtonGroup, Button, PopoverNext, H5, FormGroup, InputGroup, Intent } from "@blueprintjs/core";
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
    <div className="overflow-x-auto pb-1 -mx-4 px-4 md:mx-0 md:px-0">
      <ButtonGroup minimal={isMobile} variant={isMobile ? undefined : "minimal"}>
        {visibleRanges.map((r) => (
          <Button key={r} active={range === r} onClick={() => setRange(r)} text={r.toUpperCase()} small={isMobile} />
        ))}
        <PopoverNext
          content={
            <div className="p-4 space-y-2 w-64">
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
                onClick={() => {
                  setRange("custom");
                  fetchLogs("custom", true);
                }}
              />
            </div>
          }
        >
          <Button active={range === "custom"} icon={<Calendar size={14} />} text={isMobile ? "" : t("analytics.custom")} small={isMobile} />
        </PopoverNext>
      </ButtonGroup>
    </div>
  );
};
