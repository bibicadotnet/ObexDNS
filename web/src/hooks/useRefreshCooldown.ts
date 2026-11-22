/**
 * @file useRefreshCooldown.ts
 * @description Pause between two clicks on a Refresh button (REFRESH_COOLDOWN_SEC on the server).
 * The button is disabled with a countdown while it runs. The end of the pause is kept outside the component,
 * so leaving a tab and coming back does not give a free refresh; the server enforces the same pause (HTTP 429).
 */

import { useCallback, useEffect, useState } from "react";
import { getAuthConfig } from "../services";

/** Used until the server value is known, and when it cannot be read. Same as the server default. */
const DEFAULT_COOLDOWN_SEC = 3;

const endAtByKey = new Map<string, number>();
let configuredSec: number | null = null;
let configRequest: Promise<void> | null = null;

function loadConfiguredCooldown(): Promise<void> {
  if (!configRequest) {
    configRequest = getAuthConfig()
      .then((config) => {
        const sec = Number(config.refresh_cooldown_sec);
        if (Number.isFinite(sec) && sec >= 0) configuredSec = sec;
      })
      .catch(() => {
        // Try again on the next mount; the default applies meanwhile.
        configRequest = null;
      });
  }
  return configRequest;
}

export interface RefreshCooldown {
  /** True while the button must stay disabled. */
  active: boolean;
  /** Whole seconds left (0 when not active). */
  remainingSec: number;
  /** Starts the pause. Call it when the refresh is triggered; `sec` overrides the configured length. */
  start: (sec?: number) => void;
}

/**
 * @param key - Identifies what is refreshed, e.g. `logs:${profileId}`; each key has its own pause.
 */
export function useRefreshCooldown(key: string): RefreshCooldown {
  const [, setTick] = useState(0);

  useEffect(() => {
    void loadConfiguredCooldown();
  }, []);

  const remainingMs = (endAtByKey.get(key) ?? 0) - Date.now();
  const active = remainingMs > 0;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [active, key]);

  const start = useCallback(
    (sec?: number) => {
      const length = sec ?? configuredSec ?? DEFAULT_COOLDOWN_SEC;
      if (length <= 0) return;
      endAtByKey.set(key, Date.now() + length * 1000);
      setTick((n) => n + 1);
    },
    [key]
  );

  return { active, remainingSec: active ? Math.ceil(remainingMs / 1000) : 0, start };
}
