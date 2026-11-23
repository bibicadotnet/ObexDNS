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
    className="flex items-center gap-4 p-4 border border-gray-100 shadow-sm"
  >
    <div className="p-3 bg-gray-50 rounded-lg">{icon}</div>
    <div>
      <div className="text-xs text-gray-500 font-medium uppercase tracking-wider">{title}</div>
      <div className="text-xl font-bold">
        {value}
        {hint && <span className="ml-2 text-xs font-medium text-gray-500">{hint}</span>}
      </div>
    </div>
  </Card>
);

export const MetricCard = React.memo(MetricCardImpl);
