import React, { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { User as UserIcon, Server, LogOut, Loader2 } from "lucide-react";
import { SessionLockButton } from "./SessionLockButton";
import { LanguageSwitcher } from "./LanguageSwitcher";
import type { UserInfo } from "../types/auth";

interface GlobalHeaderActionsProps {
  currentUser?: UserInfo | null;
  navigate: (path: string) => void;
  location: any;
  handleLogout?: () => void;
  isSaving?: boolean;
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

  const isAccountActive = location?.pathname === "/account";
  const isSystemActive = location?.pathname === "/system";

  return (
    <>
      <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
        {isSaving && (
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-[#0969da] bg-blue-50 border border-blue-200/60 rounded-full animate-pulse">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="hidden sm:inline">{t("settings.saving", "Đang lưu...")}</span>
          </div>
        )}

        <SessionLockButton currentUser={currentUser} />
        <LanguageSwitcher />

        <button
          type="button"
          onClick={() => navigate("/account")}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold shadow-xs transition-all cursor-pointer ${
            isAccountActive
              ? "bg-blue-50 text-[#0969da] border-blue-200 font-bold"
              : "border-[#d0d7de] bg-white hover:bg-gray-50 text-[#111827] hover:border-gray-400"
          }`}
        >
          <UserIcon className={`w-3.5 h-3.5 ${isAccountActive ? "text-[#0969da]" : "text-gray-500"}`} />
          <span className="hidden sm:inline">{t("common.account", "Account")}</span>
        </button>

        {currentUser?.role === "admin" && (
          <button
            type="button"
            onClick={() => navigate("/system")}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold shadow-xs transition-all cursor-pointer ${
              isSystemActive
                ? "bg-blue-50 text-[#0969da] border-blue-200 font-bold"
                : "border-[#d0d7de] bg-white hover:bg-gray-50 text-[#111827] hover:border-gray-400"
            }`}
          >
            <Server className={`w-3.5 h-3.5 ${isSystemActive ? "text-[#0969da]" : "text-gray-500"}`} />
            <span className="hidden sm:inline">{t("nav.system", "System")}</span>
          </button>
        )}

        {handleLogout && (
          <button
            type="button"
            onClick={() => setShowLogoutConfirm(true)}
            className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-all cursor-pointer"
            title={t("common.logout", "Logout")}
          >
            <LogOut className="w-4 h-4" />
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
