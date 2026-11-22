import { Spinner } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import LogoIcon from "../assets/obex_cat_eye_logo-256.webp";
import { useBranding } from "../hooks/useBranding";

/** Full-page loading state: brand mark with a small spinner underneath. */
export const LoadingScreen = () => {
  const { t } = useTranslation();
  const { appName, appLogoUrl } = useBranding();
  return (
    <div className="h-app flex flex-col items-center justify-center gap-4 bg-(--canvas)" role="status" aria-live="polite">
      <img src={appLogoUrl || LogoIcon} alt={appName} className="h-14 w-14 object-contain" />
      <Spinner size={24} />
      <span className="sr-only">{t("common.loading")}</span>
    </div>
  );
};
