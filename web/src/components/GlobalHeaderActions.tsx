import React, { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { LayoutGrid, User as UserIcon, Server, LogOut, Loader2 } from "lucide-react";
import { SessionLockButton } from "./SessionLockButton";
import type { UserInfo } from "../types/auth";

interface GlobalHeaderActionsProps {
  currentUser?: UserInfo | null;
  navigate: (path: string) => void;
  location: any;
  handleLogout?: () => void;
  isSaving?: boolean | "saving" | "verifying";
}

export const GlobalHeaderActions: React.FC<GlobalHeaderActionsProps> = ({
  currentUser,
  navigate,
  location,
  handleLogout,
  isSaving,
}) => {
  const { t } = useTranslation();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  const isDashActive = location?.pathname === "/dash";
  const isAccountActive = location?.pathname === "/account";
  const isSystemActive = location?.pathname === "/system";

  return (
    <>
      <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
        {Boolean(isSaving) && (
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-[#0969da] bg-blue-50 border border-blue-200/60 rounded-full animate-pulse">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="hidden sm:inline">
              {isSaving === "verifying" ? t("settings.verifying", "Verifying...") : t("settings.saving", "Saving...")}
            </span>
          </div>
        )}

        <div className="shrink-0 flex items-center justify-center">
          <SessionLockButton currentUser={currentUser} />
        </div>

        <button
          type="button"
          onClick={() => navigate("/dash")}
          title={t("nav.profiles", "Profiles")}
          aria-label={t("nav.profiles", "Profiles")}
          className={`w-8 h-8 rounded-lg border shadow-xs transition-colors cursor-pointer flex items-center justify-center shrink-0 ${
            isDashActive
              ? "bg-blue-50 text-[#0969da] border-blue-200"
              : "border-[#d0d7de] bg-white hover:bg-gray-50 text-[#111827] hover:border-gray-400"
          }`}
        >
          <LayoutGrid className={`w-4 h-4 shrink-0 ${isDashActive ? "text-[#0969da]" : "text-gray-600"}`} />
        </button>

        <button
          type="button"
          onClick={() => navigate("/account")}
          title={t("common.account", "Account")}
          aria-label={t("common.account", "Account")}
          className={`w-8 h-8 rounded-lg border shadow-xs transition-colors cursor-pointer flex items-center justify-center shrink-0 ${
            isAccountActive
              ? "bg-blue-50 text-[#0969da] border-blue-200"
              : "border-[#d0d7de] bg-white hover:bg-gray-50 text-[#111827] hover:border-gray-400"
          }`}
        >
          <UserIcon className={`w-4 h-4 shrink-0 ${isAccountActive ? "text-[#0969da]" : "text-gray-600"}`} />
        </button>

        {currentUser?.role === "admin" && (
          <button
            type="button"
            onClick={() => navigate("/system")}
            title={t("nav.system", "System")}
            aria-label={t("nav.system", "System")}
            className={`w-8 h-8 rounded-lg border shadow-xs transition-colors cursor-pointer flex items-center justify-center shrink-0 ${
              isSystemActive
                ? "bg-blue-50 text-[#0969da] border-blue-200"
                : "border-[#d0d7de] bg-white hover:bg-gray-50 text-[#111827] hover:border-gray-400"
            }`}
          >
            <Server className={`w-4 h-4 shrink-0 ${isSystemActive ? "text-[#0969da]" : "text-gray-600"}`} />
          </button>
        )}

        {handleLogout && (
          <button
            type="button"
            onClick={() => setShowLogoutConfirm(true)}
            className="w-8 h-8 rounded-lg border border-[#d0d7de] bg-white hover:bg-red-50 text-gray-500 hover:text-red-600 hover:border-red-200 shadow-xs transition-colors cursor-pointer flex items-center justify-center shrink-0"
            title={t("common.logout", "Logout")}
            aria-label={t("common.logout", "Logout")}
          >
            <LogOut className="w-4 h-4 shrink-0" />
          </button>
        )}
      </div>

      {/* Logout Confirmation Dialog rendered via Portal to document.body to avoid backdrop-filter constraints */}
      {showLogoutConfirm && handleLogout && createPortal(
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
    </>
  );
};
