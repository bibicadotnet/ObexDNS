import { useState } from "react";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import { updateLocale } from "../utils/locale";
import { LOCALE, normalizeLocale } from "../config/locales";

/**
 * LanguageSwitcher: a two-way switch between English and Vietnamese.
 * With only two languages a segmented control is faster than a menu:
 * both choices are visible and one tap switches.
 *
 * @param compact - Smaller control for tight spots (sidebar footer, headers).
 */
export const LanguageSwitcher = ({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) => {
  const { i18n, t } = useTranslation();
  const [loadingLocale, setLoadingLocale] = useState<string | null>(null);
  const current = normalizeLocale(i18n.language);

  const choose = async (locale: string) => {
    if (locale === current || loadingLocale !== null) return;
    setLoadingLocale(locale);
    try {
      await updateLocale(locale);
    } finally {
      setLoadingLocale(null);
    }
  };

  return (
    <div
      className={clsx(
        "segmented",
        compact && "segmented-compact",
        loadingLocale && "opacity-70",
        className,
      )}
      role="group"
      aria-label={t("common.language", "Language")}
    >
      {LOCALE.map((lang) => (
        <button
          key={lang.value}
          type="button"
          lang={lang.value}
          title={lang.label}
          aria-pressed={current === lang.value}
          disabled={loadingLocale !== null}
          onClick={() => choose(lang.value)}
        >
          {lang.short}
        </button>
      ))}
    </div>
  );
};
