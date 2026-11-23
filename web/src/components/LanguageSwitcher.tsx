import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { updateLocale } from "../utils/locale";
import { LOCALE } from "../config/locales";

export const LanguageSwitcher = (_props?: {
  minimal?: boolean;
  size?: "small" | "regular";
}) => {
  const { i18n } = useTranslation();
  const [loading, setLoading] = useState(false);

  const currentLang = LOCALE.find((l) => l.value === i18n.language) || LOCALE[0];
  const otherLang = LOCALE.find((l) => l.value !== i18n.language) || LOCALE[1];

  const handleToggle = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await updateLocale(otherLang.value);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={loading}
      title={`Switch language (${otherLang.label})`}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 text-xs font-semibold shadow-xs hover:border-gray-300 transition-all cursor-pointer disabled:opacity-50"
    >
      {loading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" />
      ) : (
        <span className="text-sm leading-none">{currentLang.flag}</span>
      )}
      <span className="tracking-wide">
        {currentLang.label === "English" ? "EN" : "VI"}
      </span>
    </button>
  );
};
