import React, { useState } from "react";
import { Section, SectionCard } from "@blueprintjs/core";
import { Copy, Check, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface DohUrlCardProps {
  dohUrl: string;
  copyToClipboard: (text: string) => void;
  isMobile: boolean;
}

export const DohUrlCard: React.FC<DohUrlCardProps> = ({
  dohUrl,
  copyToClipboard,
}) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    copyToClipboard(dohUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Section
      title={t("setup.accessPointTitle", "Access DoH URL")}
      icon={<Globe size={16} />}
    >
      <SectionCard>
        <div className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-gray-50 border border-gray-200">
          <code className="text-xs sm:text-sm font-mono text-blue-600 break-all select-all flex-1">
            {dohUrl}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className={`p-2 rounded-lg text-xs font-semibold flex items-center justify-center transition-all cursor-pointer shrink-0 ${
              copied
                ? "bg-emerald-50 text-emerald-600 border border-emerald-200"
                : "bg-white border border-gray-200 text-gray-700 hover:bg-gray-100 shadow-2xs"
            }`}
            title={copied ? t("common.copied", "Copied") : t("setup.copyUrl", "Copy URL")}
          >
            {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>
      </SectionCard>
    </Section>
  );
};
