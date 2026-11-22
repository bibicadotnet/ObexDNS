import React from "react";
import { Menu, MenuDivider, MenuItem, PopoverNext, Intent } from "@blueprintjs/core";
import { Code, Lock, LogOut, User as UserIcon } from "lucide-react";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { UserInfo } from "../types/auth";
import { useBranding } from "../hooks/useBranding";
import { useLockSession } from "../components/SessionLockButton";
import { useLogoutConfirm } from "../components/LogoutConfirm";

export const UserAvatar = ({ name, size = 36 }: { name?: string; size?: number }) => (
  <span
    aria-hidden="true"
    className="inline-flex shrink-0 items-center justify-center rounded-full bg-peach-100 font-bold text-blue-800"
    style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
  >
    {(name || "?").trim().charAt(0).toUpperCase() || "?"}
  </span>
);

interface UserMenuProps {
  currentUser: UserInfo | null;
  handleLogout: () => void;
  /** "full": avatar + name. "icon": avatar only (collapsed sidebar). */
  display?: "full" | "icon";
}

/**
 * Account menu in the bottom-left corner of the sidebar, where people expect it.
 * Everything about *you* lives here: account page, lock, source link and log out.
 */
export const UserMenu: React.FC<UserMenuProps> = ({ currentUser, handleLogout, display = "full" }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { githubCornerEnabled, githubCornerUrl } = useBranding();
  const { lock, canLock } = useLockSession(currentUser);
  const { askLogout, logoutDialog } = useLogoutConfirm(handleLogout);
  const name = currentUser?.username || "";
  const role = currentUser?.role === "admin" ? t("account.roleAdmin") : t("account.roleUser");

  return (
    <>
      <PopoverNext
        placement={display === "full" ? "top-start" : "right-end"}
        content={
          <Menu className="min-w-60">
            <li className="px-3 pb-2 pt-1.5">
              <div className="truncate text-sm font-semibold text-gray-900">{name}</div>
              <div className="text-xs text-gray-500">{role}</div>
            </li>
            <MenuDivider />
            <MenuItem icon={<UserIcon size={16} />} text={t("common.account")} onClick={() => navigate("/account")} />
            {canLock && <MenuItem icon={<Lock size={16} />} text={t("auth.lockNow", "Lock Now")} onClick={lock} />}
            {githubCornerEnabled && githubCornerUrl && (
              <MenuItem
                icon={<Code size={16} />}
                text={t("nav.sourceCode", "Source code")}
                href={githubCornerUrl}
                target="_blank"
                rel="noopener noreferrer"
              />
            )}
            <MenuDivider />
            <MenuItem
              icon={<LogOut size={16} />}
              intent={Intent.DANGER}
              text={t("common.logout")}
              onClick={askLogout}
            />
          </Menu>
        }
      >
        <button
          type="button"
          aria-label={t("common.account")}
          title={name}
          className={clsx(
            "flex min-h-12 items-center gap-2.5 rounded-xl text-left transition-colors hover:bg-gray-100",
            display === "full" ? "w-full px-2 py-1.5" : "justify-center p-1.5",
          )}
        >
          <UserAvatar name={name} />
          {display === "full" && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold leading-tight text-gray-900">{name}</span>
              <span className="block truncate text-xs leading-tight text-gray-500">{role}</span>
            </span>
          )}
        </button>
      </PopoverNext>
      {logoutDialog}
    </>
  );
};
