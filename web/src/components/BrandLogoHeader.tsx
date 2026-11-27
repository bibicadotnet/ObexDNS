import React from "react";
import LogoIcon from "../assets/obex_cat_eye_logo-256.webp";
import { useBranding } from "../hooks/useBranding";

interface BrandLogoHeaderProps {
  onClick?: () => void;
  showVersion?: boolean;
  showTitle?: boolean;
  className?: string;
}

export const BrandLogoHeader: React.FC<BrandLogoHeaderProps> = ({
  onClick,
  showVersion = true,
  showTitle = true,
  className = "",
}) => {
  const { appName, appLogoUrl } = useBranding();
  const gitTag = typeof __APP_GIT_TAG__ !== "undefined" ? __APP_GIT_TAG__ : "";
  const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "";

  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-3 shrink-0 ${onClick ? "cursor-pointer hover:opacity-90 transition-opacity" : ""} ${className}`}
    >
      <img
        src={appLogoUrl || LogoIcon}
        alt={appName}
        className="w-8 h-8 rounded-lg object-contain shadow-xs shrink-0"
      />
      {showTitle && (
        <div className="flex flex-col justify-center min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-[14px] tracking-tight text-[#111827] truncate leading-tight">
              {appName || "DNS Shield"}
            </span>
          </div>
          {showVersion && (
            <span className="text-[11px] text-[#6b7280] font-mono truncate mt-0.5 leading-none">
              {gitTag || appVersion || "v1.0.0"}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
