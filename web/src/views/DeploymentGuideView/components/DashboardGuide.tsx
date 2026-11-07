import React from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";

export const DashboardGuide: React.FC = () => {
  const { t } = useTranslation();

  return (
    <>
      {/* Step 1: D1 Database */}
      <div>
        <h3 className="text-sm font-bold text-gray-900 dark:text-zinc-100 mb-1 flex items-center gap-2 mt-0">
          <span className="flex items-center justify-center w-5 h-5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs font-bold">1</span>
          {t("deploymentGuide.stepDbTitle")}
        </h3>
        <div className="text-gray-600 dark:text-zinc-400 text-xs space-y-2 leading-relaxed mb-3">
          {t("deploymentGuide.stepDbDashDesc").split("\n").map((line: string, index: number) => (
            <p key={index} className="m-0">{line}</p>
          ))}
        </div>
        <a
          href={t("deploymentGuide.stepJwtCommand2")}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 font-bold transition duration-200"
        >
          <span>{t("deploymentGuide.stepJwtDesc2")}</span>
          <ExternalLink size={12} />
        </a>
      </div>

      {/* Step 2: JWT Secrets */}
      <div className="border-t border-gray-100 dark:border-zinc-800 pt-4">
        <h3 className="text-sm font-bold text-gray-900 dark:text-zinc-100 mb-1 flex items-center gap-2 mt-0">
          <span className="flex items-center justify-center w-5 h-5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs font-bold">2</span>
          {t("deploymentGuide.stepJwtTitle")}
        </h3>
        <div className="text-gray-600 dark:text-zinc-400 text-xs space-y-2 leading-relaxed mb-3">
          {t("deploymentGuide.stepJwtDashDesc").split("\n").map((line: string, index: number) => (
            <p key={index} className="m-0">{line}</p>
          ))}
        </div>
        <a
          href={t("deploymentGuide.stepJwtCommand2")}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 font-bold transition duration-200"
        >
          <span>{t("deploymentGuide.stepJwtDesc2")}</span>
          <ExternalLink size={12} />
        </a>
      </div>

      {/* Step 3: Deploy */}
      <div className="border-t border-gray-100 dark:border-zinc-800 pt-4">
        <h3 className="text-sm font-bold text-gray-900 dark:text-zinc-100 mb-1 flex items-center gap-2 mt-0">
          <span className="flex items-center justify-center w-5 h-5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs font-bold">3</span>
          {t("deploymentGuide.stepDeployTitle")}
        </h3>
        <p className="text-gray-600 dark:text-zinc-400 text-xs mb-0 leading-relaxed">
          {t("deploymentGuide.stepDeployDashDesc")}
        </p>
      </div>
    </>
  );
};
