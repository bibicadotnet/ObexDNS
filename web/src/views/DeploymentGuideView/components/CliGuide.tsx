import React from "react";
import { useTranslation } from "react-i18next";
import { CodeBlock } from "./CodeBlock";

export const CliGuide: React.FC = () => {
  const { t } = useTranslation();

  return (
    <>
      {/* Step 1: DB */}
      <div>
        <h3 className="text-sm font-bold text-gray-900 dark:text-zinc-100 mb-1 flex items-center gap-2 mt-0">
          <span className="flex items-center justify-center w-5 h-5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs font-bold">1</span>
          {t("deploymentGuide.stepDbTitle")}
        </h3>
        <p className="text-gray-600 dark:text-zinc-400 text-xs mb-2">{t("deploymentGuide.stepDbDesc")}</p>
        <CodeBlock code={t("deploymentGuide.stepDbCommand1")} copyText={t("deploymentGuide.copy")} copiedText={t("deploymentGuide.copied")} />
        
        <p className="text-gray-600 dark:text-zinc-400 text-xs mt-3 mb-2">{t("deploymentGuide.stepDbDesc2")}</p>
        <CodeBlock code={t("deploymentGuide.stepDbCommand2")} copyText={t("deploymentGuide.copy")} copiedText={t("deploymentGuide.copied")} />
      </div>

      {/* Step 2: JWT */}
      <div className="border-t border-gray-100 dark:border-zinc-800 pt-4">
        <h3 className="text-sm font-bold text-gray-900 dark:text-zinc-100 mb-1 flex items-center gap-2 mt-0">
          <span className="flex items-center justify-center w-5 h-5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs font-bold">2</span>
          {t("deploymentGuide.stepJwtTitle")}
        </h3>
        <p className="text-gray-600 dark:text-zinc-400 text-xs mb-2">{t("deploymentGuide.stepJwtDesc")}</p>
        <CodeBlock code={t("deploymentGuide.stepJwtCommand1")} copyText={t("deploymentGuide.copy")} copiedText={t("deploymentGuide.copied")} />
      </div>

      {/* Step 3: Deploy */}
      <div className="border-t border-gray-100 dark:border-zinc-800 pt-4">
        <h3 className="text-sm font-bold text-gray-900 dark:text-zinc-100 mb-1 flex items-center gap-2 mt-0">
          <span className="flex items-center justify-center w-5 h-5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs font-bold">3</span>
          {t("deploymentGuide.stepDeployTitle")}
        </h3>
        <p className="text-gray-600 dark:text-zinc-400 text-xs mb-2">{t("deploymentGuide.stepDeployDesc")}</p>
        <CodeBlock code={t("deploymentGuide.stepDeployCommand")} copyText={t("deploymentGuide.copy")} copiedText={t("deploymentGuide.copied")} />
      </div>
    </>
  );
};
