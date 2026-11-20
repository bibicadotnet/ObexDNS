/**
 * @file useProfileMetadata.ts
 * @description Hook managing access points and log retention settings for an active profile.
 */

import { useState, useEffect } from "react";
import {
  getMe,
  getProfileAccessPoints,
  getProfileDetails,
  type AccessPoint
} from "../../../services";
import { effectiveRetentionDays } from "../../../utils/customRange";

export interface UseProfileMetadataReturn {
  accessPoints: AccessPoint[];
  logRetentionDays: number;
}

/**
 * Loads access points and parsed profile settings (such as logRetentionDays) for a given profile.
 *
 * @param profileId - Profile identifier.
 * @returns Object with accessPoints list and logRetentionDays setting.
 */
export function useProfileMetadata(profileId: string): UseProfileMetadataReturn {
  const [accessPoints, setAccessPoints] = useState<AccessPoint[]>([]);
  const [logRetentionDays, setLogRetentionDays] = useState<number>(30);

  useEffect(() => {
    let active = true;
    getProfileAccessPoints(profileId)
      .then((res) => {
        if (active) setAccessPoints(res);
      })
      .catch((e) => console.error("[useProfileMetadata] Failed to load access points:", e));

    return () => {
      active = false;
    };
  }, [profileId]);

  useEffect(() => {
    let active = true;
    Promise.all([getProfileDetails(profileId), getMe().catch(() => null)])
      .then(([res, me]) => {
        if (!active) return;
        try {
          const settings = JSON.parse(res.settings || "{}");
          setLogRetentionDays(effectiveRetentionDays(settings.log_retention_days, me?.max_log_retention_days));
        } catch (e) {
          console.error("[useProfileMetadata] Failed to parse settings:", e);
        }
      })
      .catch((e) => console.error("[useProfileMetadata] Failed to fetch profile settings:", e));

    return () => {
      active = false;
    };
  }, [profileId]);

  return { accessPoints, logRetentionDays };
}
