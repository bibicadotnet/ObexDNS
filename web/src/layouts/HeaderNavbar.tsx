import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Check, LayoutGrid, ChevronRight } from "lucide-react";
import { GlobalHeaderActions } from "../components/GlobalHeaderActions";
import type { Profile, UserInfo } from "../types/auth";

interface HeaderNavbarProps {
  theme: "light" | "dark" | "system";
  setTheme: (theme: "light" | "dark" | "system") => void;
  selectedProfile: Profile | null;
  profiles?: Profile[];
  setSelectedProfile?: (p: Profile) => void;
  isProfileActive: boolean;
  location: any;
  navigate: (path: string) => void;
  isSaving?: boolean;
  currentUser?: UserInfo | null;
  handleLogout?: () => void;
}

export const HeaderNavbar: React.FC<HeaderNavbarProps> = ({
  theme: _theme,
  setTheme: _setTheme,
  selectedProfile,
  profiles = [],
  setSelectedProfile,
  isProfileActive,
  location,
  navigate,
  isSaving,
  currentUser,
  handleLogout,
}) => {
  const { t } = useTranslation();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [dropdownOpen]);

  const handleSwitchProfile = (p: Profile) => {
    if (setSelectedProfile) {
      setSelectedProfile(p);
    }
    setDropdownOpen(false);

    // Calculate current sub-tab to preserve it across profiles
    const path = location.pathname;
    const match = path.match(/\/dash\/[^/]+\/(setup|rules|filter|stats|logs|settings)/);
    if (match && match[1]) {
      navigate(`/dash/${p.id}/${match[1]}`);
    } else {
      navigate(`/dash/${p.id}/setup`);
    }
  };

  return (
    <header className="sticky top-0 z-30 bg-white/90 backdrop-blur-md border-b border-[#d0d7de] h-14 flex items-center justify-between px-4 sm:px-6 shrink-0">
      {/* Left: Quick Profile Switcher Dropdown or Breadcrumb */}
      <div className="flex items-center gap-2" ref={dropdownRef}>
        {location.pathname === "/account" ? (
          <div className="flex items-center gap-1.5 text-[14px]">
            <button
              type="button"
              onClick={() => navigate("/dash")}
              className="font-medium text-gray-500 hover:text-[#0969da] transition-colors cursor-pointer"
            >
              {t("common.selectProfile", "Danh sách Profile")}
            </button>
            <ChevronRight className="w-4 h-4 text-gray-400" />
            <span className="font-bold text-[#111827]">{t("common.account", "Tài khoản")}</span>
          </div>
        ) : location.pathname === "/system" ? (
          <div className="flex items-center gap-1.5 text-[14px]">
            <button
              type="button"
              onClick={() => navigate("/dash")}
              className="font-medium text-gray-500 hover:text-[#0969da] transition-colors cursor-pointer"
            >
              {t("common.selectProfile", "Danh sách Profile")}
            </button>
            <ChevronRight className="w-4 h-4 text-gray-400" />
            <span className="font-bold text-[#111827]">{t("nav.system", "Hệ thống")}</span>
          </div>
        ) : isProfileActive ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#d0d7de] bg-white hover:bg-gray-50 text-[14px] font-bold text-[#111827] shadow-xs hover:border-gray-400 transition-all cursor-pointer"
            >
              <span className="w-2 h-2 rounded-full bg-[#0969da] shrink-0" />
              <span className="truncate max-w-[140px] sm:max-w-none">
                {selectedProfile?.name || t("common.loading", "Đang tải...")}
              </span>
              <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${dropdownOpen ? "rotate-180" : ""}`} />
            </button>

            {/* Dropdown Menu */}
            {dropdownOpen && (
              <div className="absolute left-0 top-full mt-1.5 w-64 bg-white rounded-xl shadow-xl border border-[#d0d7de] py-1.5 z-50">
                <div className="px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-500">
                  {t("common.switchProfile", "Quick Switch Profile")}
                </div>

                <div className="max-h-60 overflow-y-auto py-1">
                  {profiles.map((p) => {
                    const isCurrent = p.id === selectedProfile?.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => handleSwitchProfile(p)}
                        className={`w-full flex items-center justify-between px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer text-left ${
                          isCurrent
                            ? "bg-blue-50 text-[#0969da]"
                            : "text-gray-700 hover:bg-gray-50 hover:text-gray-900"
                        }`}
                      >
                        <div className="flex flex-col min-w-0 pr-2">
                          <span className="truncate font-medium">{p.name}</span>
                          <span className="text-[10px] text-gray-400 font-mono truncate">
                            {(p as any).key || p.id}
                          </span>
                        </div>
                        {isCurrent && <Check className="w-4 h-4 text-[#0969da] shrink-0" />}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-1 pt-1.5 border-t border-[#d0d7de] px-2">
                  <button
                    type="button"
                    onClick={() => {
                      setDropdownOpen(false);
                      navigate("/dash");
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors cursor-pointer"
                  >
                    <LayoutGrid className="w-3.5 h-3.5 text-gray-400" />
                    <span>{t("common.viewAllProfiles", "Manage All Profiles")}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => navigate("/dash")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] font-bold text-[#111827] hover:text-[#0969da] hover:bg-gray-50 transition-all cursor-pointer"
          >
            <span>{t("common.selectProfile", "Danh sách Profile")}</span>
          </button>
        )}
      </div>

      {/* Right: Unified Status & Actions */}
      <GlobalHeaderActions
        currentUser={currentUser}
        navigate={navigate}
        location={location}
        handleLogout={handleLogout}
        isSaving={isSaving}
      />
    </header>
  );
};
