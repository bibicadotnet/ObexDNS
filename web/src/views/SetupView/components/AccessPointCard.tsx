import React from "react";
import { Section, SectionCard, Button, HTMLSelect, Intent, Tag } from "@blueprintjs/core";
import { MonitorSmartphone, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AccessPoint } from "../../../types/auth";
import { StepNumber } from "./StepStampWatermark";

export interface AccessPointCardProps {
  accessPoints: AccessPoint[];
  selectedApId: string | null;
  onSelectAp: (id: string) => void;
  accessPointName?: string;
  onManageAccessPoints: () => void;
  isMobile: boolean;
}

export const AccessPointCard: React.FC<AccessPointCardProps> = ({
  accessPoints,
  selectedApId,
  onSelectAp,
  accessPointName,
  onManageAccessPoints,
  isMobile,
}) => {
  const { t } = useTranslation();

  return (
    <Section
      title={<span className="inline-flex items-center"><StepNumber step={1} />{t("setup.accessPointsCardTitle")}</span>}
      icon={<MonitorSmartphone size={16} />}
    >
      <SectionCard>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex flex-col gap-1.5 w-full sm:w-auto">
            <span className="text-xs opacity-50 font-medium">
              {t("setup.selectAccessPointToConfigure")}
            </span>
            <div className="flex items-center gap-3">
              {accessPoints.length > 0 ? (
                <HTMLSelect
                  value={selectedApId || ""}
                  onChange={(e) => onSelectAp(e.target.value)}
                  options={accessPoints.map((ap) => ({ label: ap.name, value: ap.id }))}
                  className="font-semibold text-gray-900 "
                />
              ) : (
                <div className="font-semibold text-gray-900 flex items-center gap-2">
                  {accessPointName || t("setup.defaultAccessPointName")}
                </div>
              )}
              {accessPoints.length > 0 && (
                <Tag minimal round intent={Intent.PRIMARY} className="text-xs">
                  {accessPoints.length}
                </Tag>
              )}
            </div>
          </div>

          <Button
            variant="outlined"
            intent={Intent.NONE}
            icon={<Settings2 size={14} />}
            text={t("setup.manageAccessPoints")}
            onClick={onManageAccessPoints}
            fill={isMobile}
            className="shrink-0"
          />
        </div>
      </SectionCard>
    </Section>
  );
};
