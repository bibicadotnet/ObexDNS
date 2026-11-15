import { useTranslation } from "react-i18next";
import { useState, useEffect } from "react";
import { getPresetFilters } from "../../services";

export interface PresetList {
  label: string;
  url: string;
  /** Description parsed from the list header, when the list has been synced. */
  description?: string | null;
  /** Recommended default (DEFAULT_PROFILE_FILTER_URLS). */
  is_default?: boolean;
}

export const usePresetLists = () => {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<PresetList[]>([]);

  useEffect(() => {
    getPresetFilters()
      .then((config) => {
        if (config && Array.isArray(config)) {
          setPresets(config.map((item: any) => ({
            label: t(item.label),
            url: item.url,
            description: item.description || null,
            is_default: !!item.is_default
          })));
        }
      })
      .catch((e) => console.warn("Failed to fetch preset filters from API", e));
  }, [t]);

  return presets;
};
