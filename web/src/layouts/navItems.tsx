import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { Plug, ShieldCheck, BarChart3, ScrollText, Settings } from "lucide-react";

export interface NavItem {
  id: "setup" | "protection" | "stats" | "logs" | "settings";
  label: string;
  icon: ReactNode;
  path: string;
  active: boolean;
}

/** The section of the current profile page: "setup", "filter", "rules", "stats", "logs" or "settings". */
export function getSection(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  // /dash/:profileId/:section
  return parts[0] === "dash" ? parts[2] || "setup" : "";
}

/**
 * Navigation, in the order people use the product:
 *   connect a device -> choose what to block -> watch what happens.
 * Settings is rarely needed, so it sits apart from the main flow.
 *
 * Blocklists and custom rules are one place ("Protection") with two tabs inside the page,
 * so the same five destinations exist on every screen size.
 */
export function buildNavItems(
  t: TFunction,
  activeId: string | undefined,
  pathname: string,
  iconSize = 20,
): { main: NavItem[]; settings: NavItem } {
  const base = `/dash/${activeId ?? ""}`;
  const section = getSection(pathname);
  const main: NavItem[] = [
    {
      id: "setup",
      label: t("nav.setup"),
      icon: <Plug size={iconSize} strokeWidth={2} />,
      path: `${base}/setup`,
      active: section === "setup",
    },
    {
      id: "protection",
      label: t("nav.protection", "Protection"),
      icon: <ShieldCheck size={iconSize} strokeWidth={2} />,
      path: `${base}/filter`,
      active: section === "filter" || section === "rules",
    },
    {
      id: "stats",
      label: t("nav.stats"),
      icon: <BarChart3 size={iconSize} strokeWidth={2} />,
      path: `${base}/stats`,
      active: section === "stats",
    },
    {
      id: "logs",
      label: t("nav.logs"),
      icon: <ScrollText size={iconSize} strokeWidth={2} />,
      path: `${base}/logs`,
      active: section === "logs",
    },
  ];
  const settings: NavItem = {
    id: "settings",
    label: t("nav.settings"),
    icon: <Settings size={iconSize} strokeWidth={2} />,
    path: `${base}/settings`,
    active: section === "settings",
  };
  return { main, settings };
}
