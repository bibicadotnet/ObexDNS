import React, { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  ListFilter,
  Settings,
  LayoutGrid,
  User as UserIcon,
  Server,
  LogOut,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { UserInfo } from "../types/auth";
import { BrandLogoHeader } from "../components/BrandLogoHeader";

interface DesktopSidebarProps {
  isSidebarOpen: boolean;
  setIsSidebarOpen: (open: boolean) => void;
  isProfileActive: boolean;
  activeId: string | undefined;
  location: any;
  navigate: (path: string) => void;
  handleLogout: () => void;
  currentUser: UserInfo | null;
  navItems: Array<{ id: string; label: string; icon: React.ReactNode; path: string }>;
}

export const DesktopSidebar: React.FC<DesktopSidebarProps> = ({
  isSidebarOpen,
  setIsSidebarOpen,
  isProfileActive,
  activeId,
  location,
  navigate,
  handleLogout,
  currentUser,
  navItems,
}) => {
  const { t } = useTranslation();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  const allItems = [
    ...navItems,
    {
      id: "filter",
      label: t("nav.filter", "Filters"),
      icon: <ListFilter className="w-5 h-5 shrink-0" />,
      path: `/dash/${activeId}/filter`,
    },
    {
      id: "settings",
      label: t("nav.settings", "Settings"),
      icon: <Settings className="w-5 h-5 shrink-0" />,
      path: `/dash/${activeId}/settings`,
    },
  ];

  return (
    <aside
      className={`hidden md:flex flex-col border-r border-[#d0d7de] bg-white transition-all duration-200 select-none overflow-hidden ${
        isSidebarOpen ? "w-64" : "w-16"
      }`}
    >
      {/* Brand Header */}
      <div
        onClick={() => navigate("/dash")}
        className={`h-14 flex items-center border-b border-[#d0d7de] shrink-0 cursor-pointer hover:bg-gray-50/80 transition-colors overflow-hidden ${
          isSidebarOpen ? "px-4" : "justify-center px-0"
        }`}
        title={t("common.selectProfile", "Select Profile")}
      >
        <BrandLogoHeader showTitle={isSidebarOpen} showVersion={isSidebarOpen} />
      </div>

      {/* Navigation List */}
      <div className="flex-1 py-3 px-2.5 space-y-1 overflow-y-auto">
        {allItems.map((item) => {
          const isActive = location.pathname.endsWith(
            item.id === "stats" ? "/stats" : `/${item.id}`,
          );

          return (
            <button
              key={item.id}
              type="button"
              disabled={!isProfileActive}
              onClick={() => navigate(item.path)}
              title={!isSidebarOpen ? item.label : undefined}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-[14px] transition-all cursor-pointer ${
                !isProfileActive
                  ? "opacity-40 cursor-not-allowed text-gray-400"
                  : isActive
                  ? "bg-blue-50 text-[#0969da] font-semibold shadow-xs"
                  : "text-gray-700 hover:bg-gray-100/80 hover:text-gray-900 font-medium"
              }`}
            >
              <span className={isActive ? "text-[#0969da]" : "text-gray-500"}>
                {item.icon}
              </span>
              {isSidebarOpen && <span className="truncate">{item.label}</span>}
            </button>
          );
        })}

        <div className="my-2.5 border-t border-[#d0d7de]" />

        {/* Manage Profiles Menu Item */}
        <button
          type="button"
          onClick={() => navigate("/dash")}
          title={!isSidebarOpen ? t("nav.profiles", "Profiles") : undefined}
          className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-[14px] transition-all cursor-pointer ${
            location.pathname === "/dash"
              ? "bg-blue-50 text-[#0969da] font-semibold shadow-xs"
              : "text-gray-700 hover:bg-gray-100/80 hover:text-gray-900 font-medium"
          }`}
        >
          <LayoutGrid className={`w-5 h-5 shrink-0 ${location.pathname === "/dash" ? "text-[#0969da]" : "text-gray-500"}`} />
          {isSidebarOpen && <span className="truncate">{t("nav.profiles", "Profiles")}</span>}
        </button>

        {/* Account Menu Item */}
        <button
          type="button"
          onClick={() => navigate("/account")}
          title={!isSidebarOpen ? t("common.account", "Account") : undefined}
          className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-[14px] transition-all cursor-pointer ${
            location.pathname === "/account"
              ? "bg-blue-50 text-[#0969da] font-semibold shadow-xs"
              : "text-gray-700 hover:bg-gray-100/80 hover:text-gray-900 font-medium"
          }`}
        >
          <UserIcon className={`w-5 h-5 shrink-0 ${location.pathname === "/account" ? "text-[#0969da]" : "text-gray-500"}`} />
          {isSidebarOpen && <span className="truncate">{t("common.account", "Account")}</span>}
        </button>

        {/* System (Admin) Menu Item */}
        {currentUser?.role === "admin" && (
          <button
            type="button"
            onClick={() => navigate("/system")}
            title={!isSidebarOpen ? t("nav.system", "System") : undefined}
            className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-[14px] transition-all cursor-pointer ${
              location.pathname === "/system"
                ? "bg-blue-50 text-[#0969da] font-semibold shadow-xs"
                : "text-gray-700 hover:bg-gray-100/80 hover:text-gray-900 font-medium"
            }`}
          >
            <Server className={`w-5 h-5 shrink-0 ${location.pathname === "/system" ? "text-[#0969da]" : "text-gray-500"}`} />
            {isSidebarOpen && <span className="truncate">{t("nav.system", "System")}</span>}
          </button>
        )}

        {/* Logout Button */}
        <button
          type="button"
          onClick={() => setShowLogoutConfirm(true)}
          title={!isSidebarOpen ? t("common.logout", "Logout") : undefined}
          className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-[14px] font-medium text-red-600 hover:bg-red-50 hover:text-red-700 transition-all cursor-pointer"
        >
          <LogOut className="w-5 h-5 shrink-0" />
          {isSidebarOpen && <span className="truncate">{t("common.logout", "Logout")}</span>}
        </button>
      </div>

      {/* Footer Toggle */}
      <div className={`p-3 border-t border-[#d0d7de] flex items-center ${isSidebarOpen ? "justify-between" : "justify-center"}`}>
        <button
          type="button"
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-all cursor-pointer"
          title={isSidebarOpen ? t("nav.collapseSidebar", "Collapse sidebar") : t("nav.expandSidebar", "Expand sidebar")}
        >
          {isSidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>

        {isSidebarOpen && currentUser && (
          <span className="text-[11px] font-semibold text-gray-600 bg-gray-100 px-2.5 py-1 rounded-md uppercase tracking-wider truncate max-w-[120px]">
            {currentUser.username}
          </span>
        )}
      </div>

      {/* Logout Confirmation Dialog */}
      {showLogoutConfirm && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-sm w-full p-5 shadow-2xl border border-[#d0d7de] space-y-4">
            <h3 className="text-sm font-bold text-[#111827] m-0">
              {t("common.confirmLogout", "Confirm Logout?")}
            </h3>
            <p className="text-xs text-gray-600 leading-relaxed m-0">
              {t("common.confirmLogoutDesc", "Are you sure you want to end your current session?")}
            </p>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowLogoutConfirm(false)}
                className="flex-1 py-2 px-3 rounded-lg border border-[#d0d7de] text-[#111827] text-xs font-semibold hover:bg-gray-50 transition-all cursor-pointer"
              >
                {t("common.cancel", "Cancel")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowLogoutConfirm(false);
                  handleLogout();
                }}
                className="flex-1 py-2 px-3 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold transition-all cursor-pointer shadow-xs"
              >
                {t("common.logout", "Logout")}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </aside>
  );
};
