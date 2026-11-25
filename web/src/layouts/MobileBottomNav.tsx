import React from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";

interface MobileBottomNavProps {
  isProfileActive: boolean;
  navItems: Array<{ id: string; label: string; icon: React.ReactNode; path: string }>;
  location: any;
  navigate: (path: string) => void;
  activeId?: string;
}

export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({
  isProfileActive,
  navItems,
  location,
  navigate,
  activeId,
}) => {
  const { t } = useTranslation();

  if (!isProfileActive) return null;

  const isSettingsActive = location.pathname.includes("/settings");

  return (
    <div className="fixed bottom-0 left-0 right-0 h-16 bg-white border-t border-[#e2e8f0] shadow-[0_-1px_3px_rgba(0,0,0,0.05)] flex items-center justify-around px-2 z-50 pb-safe">
      {navItems.map((item) => {
        const isActive = item.id === "rules"
          ? (location.pathname.includes("/rules") || location.pathname.includes("/filter"))
          : location.pathname.includes(
              item.id === "stats" ? "/stats" : `/${item.id}`,
            );
        return (
          <button
            key={item.id}
            onClick={() => navigate(item.path)}
            className={clsx(
              "flex flex-col items-center justify-center gap-1 w-16 h-full transition-colors relative",
              isActive ? "text-blue-600" : "text-gray-400 hover:text-gray-500",
            )}
          >
            {isActive && (
              <span className="absolute top-1 w-5 h-0.5 rounded-full bg-blue-600" />
            )}
            {item.icon}
            <span className="text-[10px] font-medium">{item.label}</span>
          </button>
        );
      })}
      <button
        onClick={() => activeId && navigate(`/dash/${activeId}/settings`)}
        className={clsx(
          "flex flex-col items-center justify-center gap-1 w-16 h-full transition-colors relative",
          isSettingsActive
            ? "text-blue-600"
            : "text-gray-400 hover:text-gray-500",
        )}
      >
        {isSettingsActive && (
          <span className="absolute top-1 w-5 h-0.5 rounded-full bg-blue-600" />
        )}
        <SettingsIcon size={20} />
        <span className="text-[10px] font-medium">
          {t("nav.settings", "Settings")}
        </span>
      </button>
    </div>
  );
};
