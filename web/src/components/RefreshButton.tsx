import React, { useRef } from "react";
import { Button } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";

export interface RefreshButtonProps {
  onClick: () => void;
  /** Seconds left in the pause after a refresh; the button is inert while above 0. */
  remainingSec: number;
  loading?: boolean;
  small?: boolean;
  /** Tooltip / aria label when idle. */
  label?: string;
}

/**
 * Icon-only refresh button whose footprint never changes. During the cooldown the icon is swapped for a
 * ring that drains over the pause with the seconds left inside, so neighbouring controls do not shift.
 */
export const RefreshButton: React.FC<RefreshButtonProps> = ({
  onClick,
  remainingSec,
  loading = false,
  small = false,
  label,
}) => {
  const { t } = useTranslation();
  const waiting = remainingSec > 0;
  const idleLabel = label ?? t("analytics.refresh", "Refresh");

  // Length of the current pause = the seconds left when it was first seen; drives the ring animation.
  const totalRef = useRef(0);
  if (!waiting) totalRef.current = 0;
  else if (totalRef.current === 0) totalRef.current = remainingSec;

  const size = small ? 16 : 18;
  const r = size / 2 - 1.5;
  const c = 2 * Math.PI * r;

  const icon = waiting ? (
    <span
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg width={size} height={size} className="absolute inset-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={2} />
        <circle
          key={totalRef.current}
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={c}
          style={{
            ["--ring-c" as string]: c,
            animation: `refresh-ring-drain ${totalRef.current}s linear forwards`,
          }}
        />
      </svg>
      <span className="text-xs font-semibold leading-none tabular-nums">{remainingSec}</span>
    </span>
  ) : (
    "refresh"
  );

  return (
    <Button
      icon={icon}
      variant="minimal"
      small={small}
      loading={loading}
      onClick={() => {
        if (!waiting) onClick();
      }}
      // Not `disabled`: Blueprint disables pointer events on those, which would also kill the tooltip.
      className={waiting ? "cursor-not-allowed opacity-70" : undefined}
      aria-disabled={waiting || undefined}
      aria-label={idleLabel}
      title={waiting ? t("common.refreshWait", { seconds: remainingSec }) : idleLabel}
    />
  );
};
