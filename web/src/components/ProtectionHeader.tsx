import React from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export interface ProtectionHeaderProps {
  profileId: string;
  active: "filter" | "rules";
  /** One line that explains the tab that is open. */
  subtitle?: React.ReactNode;
  /** Small elements next to the title (spinner). */
  titleExtra?: React.ReactNode;
  /** Buttons for the open tab (e.g. "Sync all"). Wrap under the subtitle on narrow screens. */
  actions?: React.ReactNode;
}

/**
 * Shared header for "Protection": what gets blocked.
 * Blocklists (set once) and custom rules (your exceptions) are two tabs of one page,
 * so people never have to guess where a block or an exception lives.
 */
export const ProtectionHeader: React.FC<ProtectionHeaderProps> = ({
  profileId,
  active,
  subtitle,
  titleExtra,
  actions,
}) => {
  const { t } = useTranslation();
  const tabs = [
    { id: "filter" as const, label: t("protection.blocklists", "Blocklists") },
    { id: "rules" as const, label: t("protection.rules", "Custom rules") },
  ];

  return (
    <header className="mb-6">
      <div className="flex items-center gap-3">
        <h1 className="page-title">{t("nav.protection", "Protection")}</h1>
        {titleExtra}
      </div>
      <nav className="segmented segmented-fill-mobile mt-4" aria-label={t("nav.protection", "Protection")}>
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            to={`/dash/${profileId}/${tab.id}`}
            aria-current={active === tab.id ? "page" : undefined}
            replace
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {(subtitle || actions) && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          {subtitle && <p className="page-subtitle m-0 min-w-0 flex-1 basis-72">{subtitle}</p>}
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
    </header>
  );
};
