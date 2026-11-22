import { Spinner } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";

/**
 * Small "Saving..." indicator. It sits in the same spot on every screen size
 * so people always know where to look: top-right on desktop, in the top bar on phones.
 */
export const SavingPill = ({ className }: { className?: string }) => {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      className={clsx(
        "inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700",
        className,
      )}
    >
      <Spinner size={12} />
      <span>{t("settings.saving")}</span>
    </div>
  );
};
