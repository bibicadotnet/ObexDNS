import React from "react";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";

interface ZoomControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}

export const ZoomControls: React.FC<ZoomControlsProps> = ({ onZoomIn, onZoomOut, onReset }) => {
  return (
    <div className="absolute top-3 right-3 flex flex-col gap-1.5 bg-white/80 dark:bg-slate-950/80 backdrop-blur-md p-1.5 rounded-lg border border-gray-200/50 dark:border-slate-800/50 shadow-sm z-10">
      <button
        type="button"
        onClick={onZoomIn}
        className="p-1.5 hover:bg-gray-100 dark:hover:bg-slate-800 rounded text-gray-600 dark:text-gray-300 transition-colors cursor-pointer"
        title="Zoom In"
      >
        <ZoomIn size={16} />
      </button>
      <button
        type="button"
        onClick={onZoomOut}
        className="p-1.5 hover:bg-gray-100 dark:hover:bg-slate-800 rounded text-gray-600 dark:text-gray-300 transition-colors cursor-pointer"
        title="Zoom Out"
      >
        <ZoomOut size={16} />
      </button>
      <button
        type="button"
        onClick={onReset}
        className="p-1.5 hover:bg-gray-100 dark:hover:bg-slate-800 rounded text-gray-600 dark:text-gray-300 transition-colors cursor-pointer"
        title="Reset Zoom"
      >
        <RotateCcw size={16} />
      </button>
    </div>
  );
};
