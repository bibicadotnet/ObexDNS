import { useState } from "react";
import { Loader2, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import { updateLocale } from "../utils/locale";
import { LOCALE } from "../config/locales";

export const LanguageSwitcher = (_props?: {
  minimal?: boolean;
  size?: "small" | "regular";
}) => {
  const { i18n } = useTranslation();
  const [loading, setLoading] = useState(false);

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
      aria-label={`Switch language (${otherLang.label})`}
      className="p-1.5 rounded-lg border border-[#d0d7de] bg-white hover:bg-gray-50 text-gray-600 hover:text-gray-900 shadow-xs hover:border-gray-400 transition-all cursor-pointer disabled:opacity-50 flex items-center justify-center shrink-0"
    >
      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin text-[#0969da]" />
      ) : (
        <Globe className="w-4 h-4" />
      )}
    </button>
  );
};
