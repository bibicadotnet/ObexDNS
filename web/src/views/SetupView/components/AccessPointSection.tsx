import React from "react";
import { Section, SectionCard, Button, Intent, PopoverNext } from "@blueprintjs/core";
import { Trash2, Edit2, RefreshCw, MonitorSmartphone, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AccessPoint } from "../../../types/auth";
import { formatDateTime } from "../../../utils/date";

export interface AccessPointSectionProps {
  ap: AccessPoint;
  totalApCount: number;
  toasterRef: React.MutableRefObject<any>;
  onRenameTrigger: (apId: string, apName: string) => void;
  rotateConfirmApId: string | null;
  setRotateConfirmApId: (apId: string | null) => void;
  rotatingApId: string | null;
  handleRotate: (apId: string) => void;
  deletingApId: string | null;
  handleDelete: (apId: string) => void;
}

export const AccessPointSection: React.FC<AccessPointSectionProps> = ({
  ap,
  totalApCount,
  toasterRef,
  onRenameTrigger,
  rotateConfirmApId,
  setRotateConfirmApId,
  rotatingApId,
  handleRotate,
  deletingApId,
  handleDelete
}) => {
  const { t } = useTranslation();

  return (
    <Section title={
      <div className="flex items-center gap-2">
        <MonitorSmartphone size={16} />
        <span>{ap.name}</span>
      </div>
    } className="shadow-none! rounded-lg!">
      <SectionCard>
        <div className="space-y-3">
          <div className="flex justify-between items-start gap-4">
            <span className="text-xs opacity-50 mt-1">DoH URL</span>
            <div 
              className="flex items-center gap-2 text-sm font-mono bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400 px-2 py-1 rounded cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors break-all"
              onClick={() => {
                navigator.clipboard.writeText(`${window.location.origin}/${ap.token}`);
                toasterRef.current?.show({ message: t("setup.copied"), intent: Intent.SUCCESS });
              }}
              title={t("setup.copyUrl")}
            >
              <span className="select-all">{`${window.location.origin}/${ap.token}`}</span>
              <Copy size={14} className="shrink-0" />
            </div>
          </div>
          <div className="flex justify-between items-start gap-4">
            <span className="text-xs opacity-50 mt-1">{t("setup.accessPointToken")}</span>
            <span className="text-sm font-mono bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded select-all break-all">{ap.token}</span>
          </div>
          <div className="flex justify-between items-start gap-4">
            <span className="text-xs opacity-50 mt-1">Created</span>
            <span className="text-sm">{formatDateTime(new Date(ap.created_at * 1000))}</span>
          </div>
        </div>
        
        <div className="mt-4 flex gap-2 flex-wrap">
          <Button 
            small 
            icon={<Edit2 size={14} />} 
            text={t("setup.renameAccessPoint")} 
            onClick={() => onRenameTrigger(ap.id, ap.name)}
          />
          <PopoverNext
            isOpen={rotateConfirmApId === ap.id}
            onInteraction={(nextOpenState) => {
              if (!nextOpenState) {
                setRotateConfirmApId(null);
              }
            }}
            content={
              <div className="p-4 space-y-3 dark:bg-gray-800 dark:text-white max-w-xs">
                <p className="text-xs font-semibold leading-relaxed">
                  {t("setup.rotateTokenConfirmDesc", "Rotating the key will immediately disconnect devices using the old key. Are you sure you want to continue?")}
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    small
                    minimal
                    text={t("common.cancel", "Cancel")}
                    onClick={() => setRotateConfirmApId(null)}
                  />
                  <Button
                    small
                    intent={Intent.DANGER}
                    text={t("common.confirm", "Confirm")}
                    onClick={() => {
                      setRotateConfirmApId(null);
                      handleRotate(ap.id);
                    }}
                  />
                </div>
              </div>
            }
            placement="top"
          >
            <Button 
              small 
              icon={<RefreshCw size={14} />} 
              text={t("setup.rotateToken")} 
              loading={rotatingApId === ap.id}
              onClick={() => setRotateConfirmApId(ap.id)}
            />
          </PopoverNext>
          <Button 
            small 
            intent={Intent.DANGER}
            icon={<Trash2 size={14} />} 
            text={t("setup.deleteAccessPoint")}
            loading={deletingApId === ap.id}
            onClick={() => handleDelete(ap.id)}
            disabled={totalApCount <= 1} // Prevent deleting the last access point
            title={totalApCount <= 1 ? "Cannot delete the only access point" : undefined}
          />
        </div>
      </SectionCard>
    </Section>
  );
};
