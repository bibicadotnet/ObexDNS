import React from "react";
import { Callout, Intent } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import type { AnalyticsData } from "../types";

interface AnalyticsWindowNoticeProps {
  data: AnalyticsData | null;
}

/**
 * Tells the user when the numbers do not cover the window they asked for.
 * Minute-level cache-hit data only exists for the last ~26h, so an older window edge is answered in whole hours
 * (`aligned`), and a window with no whole hour inside cannot be answered at all (`too_old`): showing "0" there
 * would be misleading.
 */
export const AnalyticsWindowNotice: React.FC<AnalyticsWindowNoticeProps> = ({ data }) => {
  const { t, i18n } = useTranslation();
  if (!data) return null;

  if (data.too_old) {
    return (
      <Callout intent={Intent.WARNING} icon="warning-sign" className="dark:bg-gray-900">
        {t("analytics.tooOldNotice")}
      </Callout>
    );
  }

  if (!data.aligned || data.aligned_since == null || data.aligned_until == null) return null;

  const format = (sec: number): string =>
    new Date(sec * 1000).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });

  return (
    <div className="text-xs text-gray-500 dark:text-gray-400 px-1" role="status">
      {t("analytics.alignedNotice", { from: format(data.aligned_since), to: format(data.aligned_until) })}
    </div>
  );
};
