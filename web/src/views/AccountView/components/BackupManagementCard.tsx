import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Card,
  Elevation,
  H4,
  Tag,
  Intent,
  Button,
  Spinner,
  type OverlayToaster
} from "@blueprintjs/core";
import { Cloud, CheckCircle2, Play, Download, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { BackupStatusResponse, BackupJobStatus, BackupItem } from "../../../services";
import {
  testBackupConnection,
  startBackup,
  getBackupStatus,
  listBackups,
  downloadBackup
} from "../../../services";

export interface BackupManagementCardProps {
  status: BackupStatusResponse | null;
  onRefresh?: () => Promise<void>;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

const POLL_INTERVAL_MS = 2000;
const LIST_LIMIT = 8;

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTime(ms?: number): string {
  return ms ? new Date(ms).toLocaleString() : "-";
}

export const BackupManagementCard: React.FC<BackupManagementCardProps> = ({
  status,
  onRefresh,
  toasterRef,
}) => {
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [downloadingName, setDownloadingName] = useState<string | null>(null);
  const [job, setJob] = useState<BackupJobStatus | null>(status?.job ?? null);
  const [backups, setBackups] = useState<BackupItem[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const configured = Boolean(status?.configured);
  const running = Boolean(job?.running);

  const toast = useCallback(
    (message: string, intent: Intent, icon: "tick" | "error" | "info-sign") =>
      toasterRef?.current?.show({ message, intent, icon }),
    [toasterRef]
  );

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      setBackups(await listBackups());
    } catch (e: any) {
      setListError(e.message || t("account.backupListFailed", "Không tải được danh sách bản sao lưu"));
    } finally {
      setListLoading(false);
    }
  }, [t]);

  // Pick up a job that is already running (e.g. the page was reloaded, or the cron job started)
  useEffect(() => {
    if (status?.job) setJob(status.job);
  }, [status]);

  // Load the backup list once the card is usable
  useEffect(() => {
    if (configured) void loadList();
  }, [configured, loadList]);

  // Poll the job while it runs
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const id = window.setInterval(async () => {
      try {
        const s = await getBackupStatus();
        if (!cancelled) setJob(s.job ?? null);
      } catch {
        /* transient error: keep polling */
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [running]);

  // Announce the result once when a running job finishes
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running && job) {
      if (job.state === "success") {
        toast(t("account.backupRunSuccess", "Đã sao lưu thành công lên S3!"), Intent.SUCCESS, "tick");
        void loadList();
      } else {
        toast(
          `${t("account.backupRunFailed", "Sao lưu thất bại")}${job.error ? `: ${job.error}` : ""}`,
          Intent.DANGER,
          "error"
        );
      }
      if (onRefresh) void onRefresh();
    }
    wasRunning.current = running;
  }, [running, job, toast, t, loadList, onRefresh]);

  if (!status || !status.configured) {
    return null;
  }

  const handleTestConnection = async () => {
    setTesting(true);
    try {
      const res = await testBackupConnection();
      toast(res.message || t("account.backupTestSuccess", "Kết nối S3 thành công!"), Intent.SUCCESS, "tick");
    } catch (e: any) {
      console.error(e);
      toast(e.message || t("account.backupTestFailed", "Kết nối S3 thất bại"), Intent.DANGER, "error");
    } finally {
      setTesting(false);
    }
  };

  const handleRunBackup = async () => {
    setStarting(true);
    try {
      const { alreadyRunning } = await startBackup();
      if (alreadyRunning) {
        toast(t("account.backupAlreadyRunning", "Một bản sao lưu đang chạy."), Intent.WARNING, "info-sign");
      }
      // Reflect the running state right away; polling takes over from here
      const s = await getBackupStatus();
      setJob(
        s.job?.running
          ? s.job
          : {
              state: "running",
              running: true,
              phase: "starting",
              trigger: "manual",
              startedAt: Date.now(),
              lastSuccess: s.job?.lastSuccess ?? null
            }
      );
    } catch (e: any) {
      console.error(e);
      toast(e.message || t("account.backupRunFailed", "Sao lưu thất bại"), Intent.DANGER, "error");
    } finally {
      setStarting(false);
    }
  };

  const handleDownload = async (name: string) => {
    setDownloadingName(name);
    try {
      await downloadBackup(name);
      toast(t("account.backupDownloadStarted", "Đang tải trực tiếp từ kho lưu trữ…"), Intent.SUCCESS, "tick");
    } catch (e: any) {
      console.error(e);
      toast(e.message || t("account.backupDownloadFailed", "Tải bản sao lưu thất bại"), Intent.DANGER, "error");
    } finally {
      setDownloadingName(null);
    }
  };

  const phaseLabel = (phase?: string) => {
    switch (phase) {
      case "snapshot": return t("account.backupPhaseSnapshot", "Đang chụp snapshot cơ sở dữ liệu…");
      case "archive": return t("account.backupPhaseArchive", "Đang nén dữ liệu…");
      case "verify": return t("account.backupPhaseVerify", "Đang kiểm tra bản sao lưu…");
      case "upload": return t("account.backupPhaseUpload", "Đang tải lên kho lưu trữ…");
      default: return t("account.backupPhaseStarting", "Đang khởi động…");
    }
  };

  const lastSuccess = job?.lastSuccess;
  const visibleBackups = (backups ?? []).slice(0, LIST_LIMIT);

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

      {/* Job status */}
      <div className="text-sm rounded-xl border border-gray-100 p-3.5 space-y-1" aria-live="polite">
        {running ? (
          <div className="flex items-center gap-2 text-blue-700 font-medium">
            <Spinner size={16} />
            <span>{phaseLabel(job?.phase)}</span>
          </div>
        ) : job?.state === "failed" ? (
          <div className="text-red-600 break-words">
            <span className="font-medium">{t("account.backupLastFailed", "Lần sao lưu gần nhất thất bại")}</span>
            {job.error ? `: ${job.error}` : ""}
          </div>
        ) : null}
        <div className="text-gray-600 text-xs">
          {t("account.backupLastSuccess", "Lần thành công gần nhất")}:{" "}
          <span className="font-semibold text-gray-800">
            {lastSuccess
              ? `${formatTime(lastSuccess.finishedAt)} · ${formatBytes(lastSuccess.sizeBytes)}`
              : t("account.backupNever", "chưa có")}
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
          loading={starting || running}
          disabled={starting || running}
          onClick={handleRunBackup}
          className="rounded-lg! font-medium! text-xs!"
        >
          {t("account.backupRunBtn", "Sao lưu ngay")}
        </Button>
      </div>

      {/* Stored backups: downloaded straight from S3 / R2 */}
      <div className="space-y-2 pt-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-600">
            {t("account.backupListTitle", "Các bản sao lưu trên kho lưu trữ")}
          </span>
          <Button
            minimal
            small
            icon={<RefreshCw size={14} />}
            loading={listLoading}
            onClick={() => void loadList()}
            aria-label={t("account.backupListRefresh", "Làm mới danh sách")}
          />
        </div>

        {listError ? (
          <div className="text-xs text-red-600 break-words">{listError}</div>
        ) : backups && visibleBackups.length === 0 ? (
          <div className="text-xs text-gray-500">{t("account.backupListEmpty", "Chưa có bản sao lưu nào.")}</div>
        ) : (
          <ul className="divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden">
            {visibleBackups.map((b) => (
              <li key={b.name} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                <div className="min-w-0">
                  <div className="font-semibold text-gray-800 truncate" title={b.name}>
                    {b.name.startsWith("latest.")
                      ? t("account.backupLatest", "Bản mới nhất")
                      : b.name}
                  </div>
                  <div className="text-gray-500">
                    {formatTime(b.lastModified)} · {formatBytes(b.size)}
                  </div>
                </div>
                <Button
                  small
                  icon={<Download size={14} />}
                  loading={downloadingName === b.name}
                  onClick={() => void handleDownload(b.name)}
                  className="rounded-lg! font-medium! text-xs!"
                >
                  {t("account.backupDownloadBtn", "Tải về")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
};
