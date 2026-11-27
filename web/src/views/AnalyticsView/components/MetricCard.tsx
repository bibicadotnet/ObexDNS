import React from "react";
import { Card, Elevation } from "@blueprintjs/core";

export interface MetricCardProps {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  /** Small secondary text next to the value (e.g. a percentage). */
  hint?: string;
}

const MetricCardImpl: React.FC<MetricCardProps> = ({ title, value, icon, hint }) => (
  <Card
    elevation={Elevation.ZERO}
    className="flex items-center gap-3.5 p-4 border border-gray-100 shadow-xs rounded-xl min-w-0"
  >
    <div className="p-2.5 sm:p-3 bg-gray-50 rounded-lg shrink-0">{icon}</div>
    <div className="min-w-0 flex-1">
      <div className="text-xs text-gray-500 font-medium uppercase tracking-wider truncate" title={title}>
        {title}
      </div>
      <div className="text-xl font-bold text-gray-900 flex items-baseline gap-1.5 flex-wrap">
        <span>{value}</span>
        {hint && <span className="text-xs font-semibold text-gray-400">({hint})</span>}
      </div>
    </div>
  </Card>
);

export const MetricCard = React.memo(MetricCardImpl);
