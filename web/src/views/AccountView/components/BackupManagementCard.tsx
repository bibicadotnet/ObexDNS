import React, { useState } from "react";
import {
  Card,
  Elevation,
  H4,
  Tag,
  Intent,
  Button,
  type OverlayToaster
} from "@blueprintjs/core";
import { Cloud, CheckCircle2, Play, Download } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { BackupStatusResponse } from "../../../services";
import {
  testBackupConnection,
  runManualBackup,
  downloadBackup
} from "../../../services";

export interface BackupManagementCardProps {
  status: BackupStatusResponse | null;
  onRefresh?: () => Promise<void>;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

export const BackupManagementCard: React.FC<BackupManagementCardProps> = ({
  status,
  onRefresh,
  toasterRef,
}) => {
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  const [running, setRunning] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // If not configured, do not render this section at all
  if (!status || !status.configured) {
    return null;
  }

  const handleTestConnection = async () => {
    setTesting(true);
    try {
      const res = await testBackupConnection();
      toasterRef?.current?.show({
        message: res.message || t("account.backupTestSuccess", "Kết nối S3 thành công!"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
    } catch (e: any) {
      console.error(e);
      toasterRef?.current?.show({
        message: e.message || t("account.backupTestFailed", "Kết nối S3 thất bại"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setTesting(false);
    }
  };

  const handleRunBackup = async () => {
    setRunning(true);
    try {
      const res = await runManualBackup();
      toasterRef?.current?.show({
        message: res.message || t("account.backupRunSuccess", "Đã sao lưu thành công lên S3!"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
      if (onRefresh) await onRefresh();
    } catch (e: any) {
      console.error(e);
      toasterRef?.current?.show({
        message: e.message || t("account.backupRunFailed", "Sao lưu thất bại"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setRunning(false);
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await downloadBackup();
      toasterRef?.current?.show({
        message: t("account.backupDownloadSuccess", "Đã tải bản sao lưu về máy."),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
    } catch (e: any) {
      console.error(e);
      toasterRef?.current?.show({
        message: e.message || t("account.backupDownloadFailed", "Tải bản sao lưu thất bại"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Card elevation={Elevation.ONE} className="p-5 sm:p-6 rounded-2xl bg-white border border-[#d0d7de] shadow-xs space-y-5">
      <div className="flex items-center justify-between pb-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <Cloud size={20} className="text-blue-500" />
          <H4 className="section-title m-0">
            {t("account.backupTitle", "Sao lưu đám mây (S3 / R2)")}
          </H4>
        </div>
        <Tag intent={Intent.SUCCESS} round minimal>
          {status.bucket || t("account.backupConfigured", "Đã cấu hình")}
        </Tag>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm bg-gray-50/70 p-3.5 rounded-xl border border-gray-100">
        <div>
          <span className="text-gray-500 font-medium block text-xs">
            {t("account.backupBucket", "Bucket")}:
          </span>
          <span className="font-semibold text-gray-800 break-all">{status.bucket || "-"}</span>
        </div>
        <div>
          <span className="text-gray-500 font-medium block text-xs">
            {t("account.backupEndpoint", "Endpoint")}:
          </span>
          <span className="font-semibold text-gray-800 break-all truncate block" title={status.endpoint || ""}>
            {status.endpoint || "-"}
          </span>
        </div>
        <div>
          <span className="text-gray-500 font-medium block text-xs">
            {t("account.backupCron", "Lịch tự động (Cron)")}:
          </span>
          <span className="font-semibold text-gray-800">{status.cron || "0 2 * * *"}</span>
        </div>
        <div>
          <span className="text-gray-500 font-medium block text-xs">
            {t("account.backupKeepDays", "Thời gian lưu trữ")}:
          </span>
          <span className="font-semibold text-gray-800">
            {status.keepDays || 30} {t("account.backupDays", "ngày")}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5 pt-1">
        <Button
          icon={<CheckCircle2 size={16} />}
          loading={testing}
          onClick={handleTestConnection}
          className="rounded-lg! font-medium! text-xs!"
        >
          {t("account.backupTestBtn", "Kiểm tra kết nối")}
        </Button>

        <Button
          icon={<Play size={16} />}
          intent={Intent.PRIMARY}
          loading={running}
          onClick={handleRunBackup}
          className="rounded-lg! font-medium! text-xs!"
        >
          {t("account.backupRunBtn", "Sao lưu ngay")}
        </Button>

        <Button
          icon={<Download size={16} />}
          loading={downloading}
          onClick={handleDownload}
          className="rounded-lg! font-medium! text-xs!"
        >
          {t("account.backupDownloadBtn", "Tải bản sao lưu")}
        </Button>
      </div>
    </Card>
  );
};
