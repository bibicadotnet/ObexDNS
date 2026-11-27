import { useMemo, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getPresetUpstreams } from "../../services";

export const usePresetUpstreams = () => {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<{ label: string; url: string }[]>([]);

  useEffect(() => {
    getPresetUpstreams()
      .then((config) => {
        if (config && Array.isArray(config)) {
          setPresets(config.map((item: any) => ({
            label: t(item.label),
            url: item.url
          })));
        }
      })
      .catch((e) => console.warn("Failed to fetch preset upstreams from API", e));
  }, [t]);

  return presets;
};

export const useLogRetentionOptions = (_isAdmin: boolean, maxRetentionDays: number) => {
  const { t } = useTranslation();
  return useMemo(() => {
    const effectiveMax = maxRetentionDays > 0 ? maxRetentionDays : 30;
    const maxSuffix = t("settings.retentionMaxSuffix", "(Maximum)");

    const baseTiers = [
      { label: t("settings.retentionDisabled", "Disabled (Privacy Concerns)"), value: 0 },
      { label: t("settings.retention10m", "10 Minutes"), value: 0.007 },
      { label: t("settings.retention1h", "1 Hour"), value: 0.0416 },
      { label: t("settings.retention24h", "24 Hours"), value: 1 },
      { label: t("settings.retention7d", "7 Days"), value: 7 },
      { label: t("settings.retention30d", "30 Days"), value: 30 },
      { label: t("settings.retention90d", "90 Days"), value: 90 },
      { label: t("settings.retention180d", "180 Days"), value: 180 },
      { label: t("settings.retention360d", "360 Days"), value: 360 },
    ];

    const filtered = baseTiers.filter((opt) => opt.value <= effectiveMax);

    // If effectiveMax is a custom value > 0 and not among predefined tiers, add it
    if (effectiveMax > 0 && !filtered.some((opt) => opt.value === effectiveMax)) {
      filtered.push({
        label: `${effectiveMax} ${t("settings.daysUnit", "Days")}`,
        value: effectiveMax
      });
      filtered.sort((a, b) => a.value - b.value);
    }

    if (filtered.length === 0) return [baseTiers[0]];

    // Dynamically mark the maximum tier with (Maximum) / (最长)
    return filtered.map((opt) => {
      if (opt.value === effectiveMax && opt.value > 0) {
        return {
          ...opt,
          label: `${opt.label} ${maxSuffix}`
        };
      }
      return opt;
    });
  }, [t, maxRetentionDays]);
};
