import { useState, useEffect } from "react";
import { getMe, getProfileDetails } from "../../../../services";
import { effectiveRetentionDays } from "../../../../utils/customRange";

/**
 * Hook to retrieve the log retention (in days) that really applies to a profile: its own setting, capped by
 * the limit of the user's role.
 */
export function useProfileRetention(profileId: string): number {
  const [logRetentionDays, setLogRetentionDays] = useState<number>(30);

  useEffect(() => {
    let active = true;
    Promise.all([getProfileDetails(profileId), getMe().catch(() => null)])
      .then(([data, me]) => {
        if (!active) return;
        try {
          const settings = JSON.parse(data.settings || "{}");
          setLogRetentionDays(effectiveRetentionDays(settings.log_retention_days, me?.max_log_retention_days));
        } catch (e) {
          console.error("[useProfileRetention] Failed to parse settings:", e);
        }
      })
      .catch((e) =>
        console.error("[useProfileRetention] Failed to fetch profile details:", e)
      );
    return () => {
      active = false;
    };
  }, [profileId]);

  return logRetentionDays;
}
