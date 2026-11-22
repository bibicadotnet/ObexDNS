import React from "react";
import { Link } from "react-router-dom";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import LogoIcon from "../assets/obex_cat_eye_logo-256.webp";
import type { Profile, UserInfo } from "../types/auth";
import { useUpstreamUpdate } from "../hooks/useUpstreamUpdate";
import { useBranding } from "../hooks/useBranding";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { ProfileSwitcher } from "./ProfileSwitcher";
import { UserMenu } from "./UserMenu";
import type { NavItem } from "./navItems";

interface DesktopSidebarProps {
  /** True if the sidebar shows labels; false = icon rail. */
  isSidebarOpen: boolean;
  setIsSidebarOpen: (open: boolean) => void;
  /** True if there is a selected/active profile. */
  isProfileActive: boolean;
  profiles: Profile[];
  selectedProfile: Profile | null;
  onSwitchProfile: (profile: Profile) => void;
  onShowAllProfiles: () => void;
  handleLogout: () => void;
  currentUser: UserInfo | null;
  mainItems: NavItem[];
  settingsItem: NavItem;
}

const NavLink: React.FC<{ item: NavItem; collapsed: boolean; disabled: boolean }> = ({ item, collapsed, disabled }) => {
  const className = clsx(
    "relative flex min-h-11 w-full items-center gap-3 rounded-xl text-[0.9375rem] font-semibold transition-colors",
    collapsed ? "justify-center px-0" : "px-3",
    item.active ? "bg-blue-50 text-blue-700" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
    disabled && "pointer-events-none opacity-40",
  );
  const inner = (
    <>
      {item.active && (
        <span aria-hidden="true" className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-peach-300" />
      )}
      <span className="shrink-0">{item.icon}</span>
      {!collapsed && <span className="truncate">{item.label}</span>}
    </>
  );
  if (disabled) {
    return (
      <span className={className} aria-disabled="true" title={collapsed ? item.label : undefined}>
        {inner}
      </span>
    );
  }
  return (
    <Link
      to={item.path}
      className={className}
      aria-current={item.active ? "page" : undefined}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
    >
      {inner}
    </Link>
  );
};

/**
 * Left navigation for tablets and desktops.
 *
 * Top to bottom, most-used first:
 *   brand -> which profile am I in -> the five places -> (spacer) -> me, language, collapse.
 * The same order is used by the phone layout, so nothing has to be re-learned.
 */
export const DesktopSidebar: React.FC<DesktopSidebarProps> = ({
  isSidebarOpen,
  setIsSidebarOpen,
  isProfileActive,
  profiles,
  selectedProfile,
  onSwitchProfile,
  onShowAllProfiles,
  handleLogout,
  currentUser,
  mainItems,
  settingsItem,
}) => {
  const { t } = useTranslation();
  const { hasUpdate, latestTag, gitTag, gitCommit } = useUpstreamUpdate();
  const { appName, appLogoUrl } = useBranding();
  const host = typeof window !== "undefined" ? window.location.host || window.location.hostname : "";
  const collapsed = !isSidebarOpen;

  return (
    <aside
      className={clsx(
        "flex shrink-0 flex-col border-r border-gray-200 bg-white transition-[width] duration-200",
        collapsed ? "w-(--sidebar-w-rail)" : "w-(--sidebar-w)",
      )}
      aria-label={t("nav.primary", "Main navigation")}
    >
      {/* Brand */}
      <div className={clsx("flex h-16 shrink-0 items-center", collapsed ? "justify-center" : "gap-3 px-4")}>
        <img src={appLogoUrl || LogoIcon} alt={collapsed ? appName : ""} className="h-9 w-9 shrink-0 object-contain" />
        {!collapsed && (
          <div className="min-w-0">
            <div className="truncate text-base font-bold leading-tight text-gray-900">{appName}</div>
            <div className="truncate text-xs leading-tight text-gray-500 select-all" title={host}>
              {host}
            </div>
          </div>
        )}
      </div>

      {/* Which profile am I working in */}
      <div className={clsx("shrink-0 pb-3", collapsed ? "px-3" : "px-3")}>
        <ProfileSwitcher
          profiles={profiles}
          selectedProfile={selectedProfile}
          onSelect={onSwitchProfile}
          onShowAll={onShowAllProfiles}
          display={collapsed ? "icon" : "full"}
          placement={collapsed ? "right-start" : "bottom-start"}
        />
      </div>

      {/* The places */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-2">
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {mainItems.map((item) => (
            <li key={item.id}>
              <NavLink item={item} collapsed={collapsed} disabled={!isProfileActive} />
            </li>
          ))}
        </ul>
        <div className="my-3 border-t border-gray-100" role="separator" />
        <NavLink item={settingsItem} collapsed={collapsed} disabled={!isProfileActive} />
      </nav>

      {/* Me, language, collapse */}
      <div className="shrink-0 border-t border-gray-100 p-3">
        <div className={clsx("flex gap-2", collapsed ? "flex-col items-center" : "items-center")}>
          <div className={clsx(!collapsed && "min-w-0 flex-1")}>
            <UserMenu currentUser={currentUser} handleLogout={handleLogout} display={collapsed ? "icon" : "full"} />
          </div>
          <LanguageSwitcher compact className={clsx(collapsed && "flex-col")} />
        </div>
        <div className={clsx("mt-2 flex items-center", collapsed ? "justify-center" : "justify-between")}>
          {!collapsed && (
            <span className="min-w-0 truncate pl-2 text-xs text-gray-500" title={`${gitTag}${gitCommit ? `-${gitCommit}` : ""}`}>
              {hasUpdate ? (
                <a
                  href="https://github.com/Obein/DNS-Worker/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-amber-700 hover:underline"
                  title={latestTag ? `${t("nav.updateAvailable", "Update available")}: ${latestTag}` : t("nav.updateAvailable", "Update available")}
                >
                  {t("nav.updateAvailable", "Update available")}
                </a>
              ) : (
                gitTag
              )}
            </span>
          )}
          <button
            type="button"
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            aria-label={collapsed ? t("nav.expand", "Expand sidebar") : t("nav.collapse", "Collapse sidebar")}
            title={collapsed ? t("nav.expand", "Expand sidebar") : t("nav.collapse", "Collapse sidebar")}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
      </div>
    </aside>
  );
};
