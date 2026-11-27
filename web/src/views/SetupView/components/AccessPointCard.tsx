import React, { useState } from "react";
import { Section, SectionCard, Button, PopoverNext, Intent, Tag } from "@blueprintjs/core";
import { MonitorSmartphone, Settings2, ChevronDown, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AccessPoint } from "../../../types/auth";

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
  const [isOpen, setIsOpen] = useState(false);

  const selectedAp =
    accessPoints.find((ap) => ap.id === selectedApId) ||
    accessPoints.find((ap) => ap.is_default) ||
    accessPoints[0];

  return (
    <Section
      title={t("setup.accessPointsCardTitle", "Access Points")}
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
                <PopoverNext
                  isOpen={isOpen}
                  onInteraction={(state) => setIsOpen(state)}
                  placement="bottom-start"
                  arrow={false}
                  content={
                    <div className="w-64 bg-white rounded-xl shadow-xl border border-[#d0d7de] py-1.5 max-h-60 overflow-y-auto">
                      {accessPoints.map((ap) => {
                        const isCurrent = (selectedAp?.id || selectedApId) === ap.id;
                        return (
                          <button
                            key={ap.id}
                            type="button"
                            onClick={() => {
                              onSelectAp(ap.id);
                              setIsOpen(false);
                            }}
                            className={`w-full flex items-center justify-between px-3.5 py-2 text-xs font-medium transition-colors cursor-pointer text-left ${
                              isCurrent
                                ? "bg-blue-50 text-[#0969da]"
                                : "text-gray-700 hover:bg-gray-50 hover:text-gray-900"
                            }`}
                          >
                            <div className="flex items-center gap-1.5 min-w-0 pr-2">
                              <span className="truncate font-medium">{ap.name}</span>
                              {ap.is_default && (
                                <span className="text-[10px] font-medium text-blue-700 bg-blue-50 px-1.5 py-0.2 rounded-full border border-blue-200 shrink-0">
                                  {t("common.default", "Default")}
                                </span>
                              )}
                            </div>
                            {isCurrent && <Check className="w-4 h-4 text-[#0969da] shrink-0" />}
                          </button>
                        );
                      })}
                    </div>
                  }
                >
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#d0d7de] bg-white hover:bg-gray-50 text-sm font-medium text-gray-900 transition-colors shadow-xs"
                  >
                    <span className="max-w-[140px] sm:max-w-[200px] truncate">{selectedAp?.name}</span>
                    {selectedAp?.is_default && (
                      <span className="text-[10px] font-medium text-blue-700 bg-blue-50 px-1.5 py-0.2 rounded-full border border-blue-200 shrink-0">
                        {t("common.default", "Default")}
                      </span>
                    )}
                    <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                  </button>
                </PopoverNext>
              ) : (
                <div className="font-semibold text-gray-900 flex items-center gap-2">
                  {accessPointName || t("setup.defaultAccessPointName", "Device-1")}
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
            text={t("setup.manageAccessPoints", "Manage Access Points")}
            onClick={onManageAccessPoints}
            fill={isMobile}
            className="shrink-0"
          />
        </div>
      </SectionCard>
    </Section>
  );
};
