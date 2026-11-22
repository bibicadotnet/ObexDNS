import React from "react";
import { useTranslation } from "react-i18next";

export interface AccountSection {
  id: string;
  label: string;
}

/**
 * Jump links for the long Account page. The page is grouped by what people come here to do
 * (profile, sign-in security, privacy, devices, admin, delete), and this strip stays in view
 * while scrolling. It scrolls sideways on phones.
 */
export const AccountSectionNav: React.FC<{ sections: AccountSection[] }> = ({ sections }) => {
  const { t } = useTranslation();
  const go = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <nav
      aria-label={t("account.title")}
      className="sticky top-2 z-20 rounded-xl border border-gray-200 bg-white/95 px-2 shadow-sm backdrop-blur"
    >
      <ul className="m-0 flex list-none gap-1 overflow-x-auto p-0 py-2">
        {sections.map((s) => (
          <li key={s.id} className="shrink-0">
            <button
              type="button"
              onClick={() => go(s.id)}
              className="inline-flex min-h-10 items-center rounded-full px-4 text-sm font-semibold text-gray-600 transition-colors hover:bg-blue-50 hover:text-blue-700"
            >
              {s.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
};
