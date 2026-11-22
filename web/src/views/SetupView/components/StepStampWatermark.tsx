import React from "react";
import { clsx } from "clsx";

export interface StepNumberProps {
  /** The step number (1, 2, 3). */
  step: number;
  className?: string;
}

/**
 * Small numbered badge placed in front of a step's title.
 * The Setup page really is a sequence (pick a device, copy the address, follow the guide),
 * so the numbers carry information, and they sit right where the eye reads the title.
 */
export const StepNumber: React.FC<StepNumberProps> = ({ step, className }) => (
  <span
    aria-hidden="true"
    className={clsx(
      "mr-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white",
      className,
    )}
  >
    {step}
  </span>
);
