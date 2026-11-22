import React from "react";
import { Section, SectionCard, Button, PopoverNext, H5, Intent } from "@blueprintjs/core";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StepNumber } from "./StepStampWatermark";

export interface DohUrlCardProps {
  dohUrl: string;
  copyToClipboard: (text: string) => void;
  isMobile: boolean;
}

export const DohUrlCard: React.FC<DohUrlCardProps> = ({
  dohUrl,
  copyToClipboard,
  isMobile,
}) => {
  const { t } = useTranslation();

  return (
    <Section
      title={<span className="inline-flex items-center"><StepNumber step={2} />{t("setup.accessPointTitle", "Access DoH URL")}</span>}
      icon="globe"
      rightElement={
        <PopoverNext
          placement="bottom-end"
          usePortal={true}
          content={
            <div className="p-4 max-w-sm">
              <H5>{t("setup.whatIsDoh")}</H5>
              <p className="text-sm mb-2">
                {t("setup.dohDesc")}
              </p>
              <ul className="list-disc list-inside text-sm opacity-80 mb-3 space-y-1">
                <li>{t("setup.dohBenefit1")}</li>
                <li>{t("setup.dohBenefit2")}</li>
              </ul>
              <div className="text-xs border-t border-gray-100 pt-2">
                <a
                  href="https://en.wikipedia.org/wiki/DNS_over_HTTPS"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-blue-500 hover:underline"
                >
                  <ExternalLink size={10} /> {t("setup.learnMore")}
                </a>
              </div>
            </div>
          }
        >
          <Button icon="help" variant="minimal" intent={Intent.NONE} />
        </PopoverNext>
      }
    >
      <SectionCard>
        <div className="w-full bg-gray-100 p-3 rounded-lg border border-gray-200 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <span className="font-mono text-blue-600 break-all text-xs sm:text-sm">{dohUrl}</span>
          <Button
            intent={Intent.PRIMARY}
            icon="duplicate"
            text={t("setup.copyUrl")}
            fill={isMobile}
            onClick={() => copyToClipboard(dohUrl)}
            className="shrink-0 whitespace-nowrap min-w-fit w-auto"
          />
        </div>
      </SectionCard>
    </Section>
  );
};

