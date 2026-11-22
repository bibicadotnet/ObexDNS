import React from "react";
import LogoIcon from "../../../assets/obex_cat_eye_logo-256.webp";
import { LanguageSwitcher } from "../../../components/LanguageSwitcher";
import { UserMenu } from "../../../layouts/UserMenu";
import { useBranding } from "../../../hooks/useBranding";
import type { UserInfo } from "../../../types/auth";

interface NavbarProps {
  handleLogout: () => void;
  currentUser?: UserInfo | null;
}

/**
 * Top bar of the profile list: brand on the left, language and account on the right.
 * Account, lock and log out are all inside the avatar menu, so the bar stays short.
 */
export const Navbar: React.FC<NavbarProps> = ({ handleLogout, currentUser }) => {
  const { appName, appLogoUrl } = useBranding();
  const host = typeof window !== "undefined" ? window.location.host || window.location.hostname : "";

  return (
    <header className="pt-safe sticky top-0 z-30 shrink-0 border-b border-gray-200 bg-white">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-3 px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <img src={appLogoUrl || LogoIcon} alt="" className="h-9 w-9 shrink-0 object-contain" />
          <div className="min-w-0">
            <div className="truncate text-base font-bold leading-tight text-gray-900">{appName}</div>
            {host && (
              <div className="hidden truncate text-xs leading-tight text-gray-500 select-all sm:block" title={host}>
                {host}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <LanguageSwitcher compact />
          <div className="w-12">
            <UserMenu currentUser={currentUser ?? null} handleLogout={handleLogout} display="icon" />
          </div>
        </div>
      </div>
    </header>
  );
};
