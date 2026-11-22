import React from "react";
import { Dialog, DialogBody } from "@blueprintjs/core";
import { ChevronRight, Code, Languages, LayoutGrid, Lock, LogOut, Settings, User as UserIcon } from "lucide-react";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { UserInfo } from "../types/auth";
import { useBranding } from "../hooks/useBranding";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { useLockSession } from "../components/SessionLockButton";
import { useLogoutConfirm } from "../components/LogoutConfirm";
import { UserAvatar } from "./UserMenu";

interface MobileMoreSheetProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserInfo | null;
  handleLogout: () => void;
  /** Where Settings lives, or undefined when no profile is open. */
  settingsPath?: string;
  settingsActive: boolean;
}

const Row: React.FC<{
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  href?: string;
  danger?: boolean;
  active?: boolean;
  chevron?: boolean;
  disabled?: boolean;
}> = ({ icon, label, onClick, href, danger, active, chevron = true, disabled }) => {
  const className = clsx(
    "flex min-h-14 w-full items-center gap-3 rounded-xl px-3 text-left text-base font-semibold transition-colors",
    danger ? "text-red-700 active:bg-red-50" : active ? "bg-blue-50 text-blue-700" : "text-gray-800! hover:no-underline active:bg-gray-100",
    disabled && "pointer-events-none opacity-40",
  );
  const content = (
    <>
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {chevron && <ChevronRight size={18} className="shrink-0 text-gray-300" />}
    </>
  );
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {content}
    </a>
  ) : (
    <button type="button" onClick={onClick} className={className} disabled={disabled}>
      {content}
    </button>
  );
};

/**
 * The "More" sheet on phones. It holds everything that is not used every minute:
 * Settings, Account, all profiles, language, lock and log out.
 * Large rows (56px) so each one is an easy tap.
 */
export const MobileMoreSheet: React.FC<MobileMoreSheetProps> = ({
  isOpen,
  onClose,
  currentUser,
  handleLogout,
  settingsPath,
  settingsActive,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { githubCornerEnabled, githubCornerUrl } = useBranding();
  const { lock, canLock } = useLockSession(currentUser);
  const { askLogout, logoutDialog } = useLogoutConfirm(handleLogout);
  const role = currentUser?.role === "admin" ? t("account.roleAdmin") : t("account.roleUser");

  const go = (path: string) => {
    onClose();
    navigate(path);
  };

  return (
    <>
      <Dialog isOpen={isOpen} onClose={onClose} title={t("nav.menu", "Menu")} canOutsideClickClose canEscapeKeyClose>
        <DialogBody className="m-0! p-3!">
          <div className="mb-2 flex items-center gap-3 rounded-xl bg-gray-50 p-3">
            <UserAvatar name={currentUser?.username} size={44} />
            <div className="min-w-0">
              <div className="truncate text-base font-bold text-gray-900">{currentUser?.username}</div>
              <div className="text-sm text-gray-500">{role}</div>
            </div>
          </div>

          <Row
            icon={<Settings size={20} />}
            label={t("nav.settings")}
            onClick={() => settingsPath && go(settingsPath)}
            active={settingsActive}
            disabled={!settingsPath}
          />
          <Row icon={<UserIcon size={20} />} label={t("common.account")} onClick={() => go("/account")} />
          <Row icon={<LayoutGrid size={20} />} label={t("common.allProfiles", "All profiles")} onClick={() => go("/dash")} />

          <div className="flex min-h-14 items-center gap-3 px-3">
            <Languages size={20} className="shrink-0 text-gray-800" />
            <span className="min-w-0 flex-1 text-base font-semibold text-gray-800">{t("common.language", "Language")}</span>
            <LanguageSwitcher />
          </div>

          {canLock && (
            <Row
              icon={<Lock size={20} />}
              label={t("auth.lockNow", "Lock Now")}
              onClick={() => {
                onClose();
                void lock();
              }}
              chevron={false}
            />
          )}
          {githubCornerEnabled && githubCornerUrl && (
            <Row icon={<Code size={20} />} label={t("nav.sourceCode", "Source code")} href={githubCornerUrl} />
          )}

          <div className="my-2 border-t border-gray-100" role="separator" />
          <Row
            icon={<LogOut size={20} />}
            label={t("common.logout")}
            danger
            chevron={false}
            onClick={() => {
              onClose();
              askLogout();
            }}
          />
        </DialogBody>
      </Dialog>
      {logoutDialog}
    </>
  );
};
