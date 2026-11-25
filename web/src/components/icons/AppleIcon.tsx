import React from "react";

export interface AppleIconProps {
  className?: string;
  size?: number;
}

export const AppleIcon: React.FC<AppleIconProps> = ({ className = "w-4 h-4", size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    style={{ display: "inline-block", verticalAlign: "middle" }}
  >
    <path d="M16.365 21.435c-1.12.83-2.09.84-3.13.34-1.07-.48-2.07-.5-3.17 0-1.4.63-2.22.42-3.17-.46C1.945 15.685 3.335 7.495 8.925 7.295c1.4.08 2.45.85 3.25.9 1.15-.05 2.4-.85 3.75-.75 1.55.15 2.85.75 3.75 1.95-3.2 1.8-2.6 6.3 0.45 7.55-1.25 3.2-2.7 5.3-2.9 3.5zm-4.3-14.1c-.2-2.3 1.7-4.2 3.8-4.4.3 2.7-2.4 4.7-3.8 4.4z" />
  </svg>
);
