import React, { useState } from "react";
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
    <div className="p-4 sm:p-5 rounded-2xl bg-white border border-gray-200/80 shadow-xs mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-blue-600" />
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-700 m-0">
            {t("setup.accessPointTitle", "Địa chỉ DoH URL")}
          </h3>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-gray-50 border border-gray-200">
        <code className="text-xs sm:text-sm font-mono text-blue-600 truncate select-all">
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
          title={copied ? t("common.copied", "Đã sao chép") : t("setup.copyUrl", "Sao chép DoH URL")}
        >
          {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
};
