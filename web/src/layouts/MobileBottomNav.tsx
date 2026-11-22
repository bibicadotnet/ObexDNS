import React from "react";
import { Link } from "react-router-dom";
import { MoreHorizontal } from "lucide-react";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import type { NavItem } from "./navItems";

interface MobileBottomNavProps {
  items: NavItem[];
  /** True while Settings, Account or the More sheet itself is open. */
  moreActive: boolean;
  onOpenMore: () => void;
}

const tabClass = (active: boolean) =>
  clsx(
    "group flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-semibold leading-tight transition-colors",
    active ? "text-blue-700" : "text-gray-500",
  );

const pillClass = (active: boolean) =>
  clsx(
    "inline-flex h-8 w-14 items-center justify-center rounded-full transition-colors",
    active ? "bg-blue-100" : "group-active:bg-gray-100",
  );

/**
 * Bottom tab bar for phones: the four places you use all day, plus "More".
 * Thumbs reach the bottom edge easily, so the most frequent actions live here.
 */
export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({ items, moreActive, onOpenMore }) => {
  const { t } = useTranslation();

  return (
    <nav
      className="pb-safe z-30 shrink-0 border-t border-gray-200 bg-white"
      aria-label={t("nav.primary", "Main navigation")}
    >
      <ul className="m-0 flex h-16 list-none items-stretch p-0 px-1">
        {items.map((item) => (
          <li key={item.id} className="flex min-w-0 flex-1">
            <Link to={item.path} className={tabClass(item.active)} aria-current={item.active ? "page" : undefined}>
              <span className={pillClass(item.active)}>{item.icon}</span>
              <span className="max-w-full truncate px-1">{item.label}</span>
            </Link>
          </li>
        ))}
        <li className="flex min-w-0 flex-1">
          <button type="button" onClick={onOpenMore} className={tabClass(moreActive)} aria-haspopup="dialog">
            <span className={pillClass(moreActive)}>
              <MoreHorizontal size={20} strokeWidth={2} />
            </span>
            <span className="max-w-full truncate px-1">{t("nav.more", "More")}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
};
