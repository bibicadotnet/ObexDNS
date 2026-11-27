import React from "react";
import clsx from "clsx";
import { formatDateTime } from "../utils/date";

export interface CompactDateTimeProps {
  timestamp?: number | string | Date | null;
  className?: string;
  align?: "left" | "right" | "center";
  fallback?: React.ReactNode;
}

export const CompactDateTime: React.FC<CompactDateTimeProps> = ({
  timestamp,
  className,
  align = "left",
  fallback = <span className="text-gray-400">—</span>,
}) => {
  if (!timestamp) return <>{fallback}</>;

  let d: Date;
  if (timestamp instanceof Date) {
    d = timestamp;
  } else if (typeof timestamp === "number") {
    // Unix timestamp in seconds vs milliseconds
    d = new Date(timestamp < 10000000000 ? timestamp * 1000 : timestamp);
  } else {
    d = new Date(timestamp);
  }

  if (isNaN(d.getTime())) {
    return <>{fallback}</>;
  }

  const fullStr = formatDateTime(d);
  const dateStr = d.toLocaleDateString();
  const timeStr = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const alignClass =
    align === "right"
      ? "text-right"
      : align === "center"
      ? "text-center"
      : "text-left";

  return (
    <div className={clsx("leading-tight", alignClass, className)} title={fullStr}>
      <span className="font-medium text-gray-700 block">{dateStr}</span>
      <span className="text-[11px] text-gray-400 block font-mono">{timeStr}</span>
    </div>
  );
};
