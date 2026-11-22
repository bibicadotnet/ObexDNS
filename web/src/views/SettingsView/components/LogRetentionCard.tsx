import React, { useState } from "react";
import { Card, Elevation, H5, FormGroup, HTMLSelect, Switch, Button, Alert, Intent, OverlayToaster } from "@blueprintjs/core";
import { Clock, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProfileSettings } from "../types";
import { useLogRetentionOptions } from "../hooks";
import { clearProfileLogs } from "../../../services";

export interface LogRetentionCardProps {
  settings: ProfileSettings;
  setSettings: (settings: ProfileSettings) => void;
  isAdmin: boolean;
  maxRetentionDays: number;
  profileId?: string;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

export const LogRetentionCard: React.FC<LogRetentionCardProps> = ({
  settings,
  setSettings,
  isAdmin,
  maxRetentionDays,
  profileId,
  toasterRef
}) => {
  const { t } = useTranslation();
  const LOG_RETENTION_OPTIONS = useLogRetentionOptions(isAdmin, maxRetentionDays);
  const [isAlertOpen, setIsAlertOpen] = useState<boolean>(false);
  const [clearing, setClearing] = useState<boolean>(false);

  React.useEffect(() => {
    if (maxRetentionDays > 0 && settings.log_retention_days > maxRetentionDays && LOG_RETENTION_OPTIONS.length > 0) {
      const highestOption = LOG_RETENTION_OPTIONS[LOG_RETENTION_OPTIONS.length - 1];
      if (highestOption && settings.log_retention_days !== highestOption.value) {
        setSettings({ ...settings, log_retention_days: highestOption.value });
      }
    }
  }, [maxRetentionDays, settings.log_retention_days, LOG_RETENTION_OPTIONS, setSettings]);

  const handleClearLogs = async () => {
    if (!profileId) return;
    setClearing(true);
    try {
      await clearProfileLogs(profileId);
      toasterRef?.current?.show({
        message: t("settings.clearProfileLogsSuccess"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
    } catch (err) {
      console.error("[LogRetentionCard] Failed to clear profile logs:", err);
      toasterRef?.current?.show({
        message: t("settings.clearProfileLogsError"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setClearing(false);
      setIsAlertOpen(false);
    }
  };

  const isLoggingDisabled = settings.log_retention_days === 0;

  return (
    <Card elevation={Elevation.ONE} className="h-full min-w-0 ">
      <div className="flex items-center justify-between min-h-[30px] mb-4">
        <H5 className="section-title flex items-center gap-2 m-0">
          <Clock size={18} className="text-purple-500" /> {t("settings.logRetentionTitle")}
        </H5>
      </div>
      <div className="space-y-4">
        <FormGroup label={t("settings.retentionDuration")}>
          <HTMLSelect
            fill
            value={settings.log_retention_days}
            onChange={(e) => setSettings({ ...settings, log_retention_days: parseFloat(e.target.value) })}
          >
            {LOG_RETENTION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </HTMLSelect>
        </FormGroup>
        <p className="text-xs opacity-60">
          {t("settings.retentionDesc")}
        </p>

        <div className="pt-3 border-t border-gray-100 space-y-3">
          <div>
            <Switch
              label={t("settings.skipLogOnPass")}
              checked={!isLoggingDisabled && !!settings.skip_log_on_pass}
              disabled={isLoggingDisabled}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  skip_log_on_pass: e.currentTarget.checked,
                })
              }
            />
            <p className="text-xs opacity-60 mt-1">
              {t("settings.skipLogOnPassDesc")}
            </p>
          </div>

          {profileId && (
            <div className="pt-1 flex justify-end">
              <Button
                minimal
                small
                intent={Intent.DANGER}
                icon={<Trash2 size={13} />}
                text={t("settings.clearProfileLogs")}
                loading={clearing}
                disabled={clearing}
                onClick={() => setIsAlertOpen(true)}
              />
            </div>
          )}
        </div>
      </div>

      <Alert
        isOpen={isAlertOpen}
        confirmButtonText={t("common.confirm")}
        cancelButtonText={t("common.cancel")}
        intent={Intent.DANGER}
        icon="trash"
        onConfirm={handleClearLogs}
        onCancel={() => setIsAlertOpen(false)}
        loading={clearing}
      >
        <p>
          {t("settings.clearProfileLogsConfirm")}
        </p>
      </Alert>
    </Card>
  );
};
