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
        message: t("settings.clearProfileLogsSuccess", "配置日志已成功清空"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
    } catch (err) {
      console.error("[LogRetentionCard] Failed to clear profile logs:", err);
      toasterRef?.current?.show({
        message: t("settings.clearProfileLogsError", "清空配置日志失败"),
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
    <Card elevation={Elevation.ONE} className="dark:bg-gray-900 dark:border-gray-800">
      <H5 className="flex items-center gap-2 mb-4 font-bold">
        <Clock size={18} className="text-purple-500" /> {t("settings.logRetentionTitle")}
      </H5>
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
          {isLoggingDisabled
            ? t("settings.retentionDisabledDesc", "已关闭日志记录。系统将不会记录任何 DNS 查询日志并立即清空历史日志。")
            : t("settings.retentionDesc")}
        </p>

        <div className="pt-3 border-t border-gray-100 dark:border-gray-800/80">
          <Switch
            label={t("settings.skipLogOnPass", "不记录放行记录")}
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
            {t(
              "settings.skipLogOnPassDesc",
              "启用后不记录正常放行的 DNS 查询，仅记录被拦截、重定向或解析失败的记录。可大幅减少存储占用与写操作。"
            )}
          </p>
        </div>

        {profileId && (
          <div className="pt-3 border-t border-gray-100 dark:border-gray-800/80 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                {t("settings.clearProfileLogsTitle", "清空此配置日志")}
              </p>
              <p className="text-xs opacity-60">
                {t("settings.clearProfileLogsDesc", "永久清空此配置的所有解析查询日志及统计分析数据。")}
              </p>
            </div>
            <Button
              minimal
              small
              intent={Intent.DANGER}
              icon={<Trash2 size={13} />}
              text={t("settings.clearProfileLogsBtn", "清空日志")}
              loading={clearing}
              disabled={clearing}
              onClick={() => setIsAlertOpen(true)}
            />
          </div>
        )}
      </div>

      <Alert
        isOpen={isAlertOpen}
        confirmButtonText={t("common.confirm", "确认清空")}
        cancelButtonText={t("common.cancel", "取消")}
        intent={Intent.DANGER}
        icon="trash"
        onConfirm={handleClearLogs}
        onCancel={() => setIsAlertOpen(false)}
        loading={clearing}
      >
        <p>
          {t(
            "settings.clearProfileLogsConfirm",
            "确定要清空此配置的所有解析日志吗？此操作不可撤销。"
          )}
        </p>
      </Alert>
    </Card>
  );
};
