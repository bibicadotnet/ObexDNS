import React from "react";
import { Menu, MenuDivider, MenuItem, PopoverNext } from "@blueprintjs/core";
import { Check, ChevronsUpDown, LayoutGrid } from "lucide-react";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import type { Profile } from "../types/auth";

/** Square badge with the first letter of a profile's name. */
export const ProfileAvatar = ({ name, size = 32 }: { name?: string; size?: number }) => (
  <span
    aria-hidden="true"
    className="inline-flex shrink-0 items-center justify-center rounded-lg bg-blue-600 font-bold text-white"
    style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}
  >
    {(name || "?").trim().charAt(0).toUpperCase() || "?"}
  </span>
);

interface ProfileSwitcherProps {
  profiles: Profile[];
  selectedProfile: Profile | null;
  /** Called with the profile the person picked. */
  onSelect: (profile: Profile) => void;
  /** Called when the person wants the full list of profiles. */
  onShowAll: () => void;
  /** "full": name + chevron (sidebar, top bar). "icon": avatar only (collapsed sidebar). */
  display?: "full" | "icon";
  className?: string;
  placement?: "bottom-start" | "right-start";
}

/**
 * Switch between profiles from anywhere.
 * The current profile is always visible in the same corner (top-left of the app),
 * and changing it keeps you on the page you were on.
 */
export const ProfileSwitcher: React.FC<ProfileSwitcherProps> = ({
  profiles,
  selectedProfile,
  onSelect,
  onShowAll,
  display = "full",
  className,
  placement = "bottom-start",
}) => {
  const { t } = useTranslation();
  const label = selectedProfile?.name || t("common.noProfileSelected", "No profile selected");

  return (
    <PopoverNext
      placement={placement}
      content={
        <Menu className="min-w-60 max-w-[min(20rem,calc(100vw-24px))]">
          {profiles.map((p) => (
            <MenuItem
              key={p.id}
              icon={<ProfileAvatar name={p.name} size={24} />}
              text={<span className="font-semibold">{p.name}</span>}
              labelElement={p.id === selectedProfile?.id ? <Check size={16} className="text-blue-600" /> : undefined}
              onClick={() => onSelect(p)}
            />
          ))}
          {profiles.length > 0 && <MenuDivider />}
          <MenuItem
            icon={<LayoutGrid size={16} />}
            text={t("common.allProfiles", "All profiles")}
            onClick={onShowAll}
          />
        </Menu>
      }
    >
      <button
        type="button"
        title={label}
        aria-label={t("common.switchProfile", "Switch profile")}
        className={clsx(
          "group flex min-h-11 items-center gap-2.5 rounded-xl border border-gray-200 bg-white text-left transition-colors hover:border-gray-300 hover:bg-gray-50",
          display === "full" ? "w-full px-2.5 py-1.5" : "justify-center p-1.5",
          className,
        )}
      >
        <ProfileAvatar name={selectedProfile?.name} size={display === "full" ? 30 : 32} />
        {display === "full" && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold leading-tight text-gray-900">{label}</span>
              <span className="block truncate text-xs leading-tight text-gray-500">
                {t("common.switchProfile", "Switch profile")}
              </span>
            </span>
            <ChevronsUpDown size={16} className="shrink-0 text-gray-400 group-hover:text-gray-600" />
          </>
        )}
      </button>
    </PopoverNext>
  );
};
