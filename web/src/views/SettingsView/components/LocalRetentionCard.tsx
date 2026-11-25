import React, { useState, useEffect, useCallback } from "react";
import {
  Card,
  Elevation,
  H5,
  FormGroup,
  HTMLSelect,
  Button,
  Intent,
  Tag,
  Alert,
  OverlayToaster
} from "@blueprintjs/core";
import { Database, HardDrive, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { localDb } from "../../../services";

export interface LocalRetentionCardProps {
  profileId: string;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

/**
 * LocalRetentionCard allows users to configure client-side SQLite log persistence,
 * view local cache storage status (OPFS vs in-memory), and purge local cached logs.
 */
export const LocalRetentionCard: React.FC<LocalRetentionCardProps> = ({ profileId, toasterRef }) => {
  const { t } = useTranslation();
  const [retentionDays, setRetentionDays] = useState<number>(() => localDb.getLocalRetentionDays());
  const [isOpfs, setIsOpfs] = useState<boolean>(false);
  const [rowCount, setRowCount] = useState<number | null>(null);
  const [isAlertOpen, setIsAlertOpen] = useState<boolean>(false);
  const [clearing, setClearing] = useState<boolean>(false);

  const loadStorageInfo = useCallback(async () => {
    try {
      await localDb.init();
      const info = await localDb.getStorageInfo();
      setIsOpfs(info?.isOpfs ?? localDb.getIsOpfs());
      const profileStat = info.profileStats.find((s) => s.profile_id === profileId);
      setRowCount(profileStat ? profileStat.count : 0);
    } catch (err) {
      console.error("[LocalRetentionCard] Failed to load storage info:", err);
      setIsOpfs(localDb.getIsOpfs());
      setRowCount(0);
    }
  }, [profileId]);

  useEffect(() => {
    loadStorageInfo();
  }, [loadStorageInfo]);

  const handleRetentionChange = (days: number) => {
    setRetentionDays(days);
    localDb.setLocalRetentionDays(days);
    loadStorageInfo();
  };

  const handleClearConfirm = async () => {
    setClearing(true);
    try {
      await localDb.clearProfile(profileId);
      setRowCount(0);
      toasterRef?.current?.show({
        message: t("settings.clearLocalDataSuccess", "Local logs cleared successfully"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
    } catch (err) {
      console.error("[LocalRetentionCard] Failed to clear local profile logs:", err);
      toasterRef?.current?.show({
        message: t("settings.clearLocalDataError", "Failed to clear local logs"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setClearing(false);
      setIsAlertOpen(false);
    }
  };

  return (
    <Card elevation={Elevation.ONE} className="">
      <H5 className="section-title flex items-center gap-2 mb-4!">
        <Database size={18} className="text-cyan-500" /> {t("settings.localRetentionTitle", "Local Storage & Retention")}
      </H5>
      <div className="space-y-4">
        <FormGroup label={t("settings.localRetentionDuration", "Local Retention Duration")}>
          <HTMLSelect
            fill
            value={retentionDays}
            onChange={(e) => handleRetentionChange(parseInt(e.target.value, 10))}
          >
            <option value={30}>{t("settings.localRetention30d", "30 Days")}</option>
            <option value={90}>{t("settings.localRetention90d", "90 Days (Recommended)")}</option>
            <option value={180}>{t("settings.localRetention180d", "180 Days")}</option>
            <option value={365}>{t("settings.localRetention365d", "365 Days (1 Year)")}</option>
            <option value={0}>{t("settings.localRetentionUnlimited", "Unlimited (Until manually cleared)")}</option>
          </HTMLSelect>
        </FormGroup>

        <p className="text-xs opacity-60">
          {t("settings.localRetentionDesc", "Logs will be persisted in the local browser SQLite database (OPFS), providing sub-second local search and saving cloud storage costs. Local logs exceeding this duration will be automatically cleaned up."
          )}
        </p>

        <div className="pt-3 border-t border-gray-100 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 opacity-70">
              <HardDrive size={14} />
              {t("settings.localEngineStorage", "Storage Engine")}:
            </span>
            <Tag
              minimal
              intent={isOpfs ? Intent.SUCCESS : Intent.WARNING}
              className="text-[11px]"
            >
              {isOpfs
                ? t("settings.localEngineOpfs", "OPFS Persistent Storage")
                : t("settings.localEngineMemory", "In-Memory Temporary (Private Mode)")}
            </Tag>
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="opacity-70">{t("settings.localCachedCount", "Local Cached Logs")}:</span>
            <span className="font-mono font-medium">
              {rowCount !== null
                ? t("settings.localCachedCountUnit", "{{count}} records", { count: rowCount })
                : "..."}
            </span>
          </div>

          <div className="pt-1 flex justify-end">
            <Button
              minimal
              small
              intent={Intent.DANGER}
              icon={<Trash2 size={13} />}
              text={t("settings.clearLocalData", "Clear Local Logs")}
              disabled={rowCount === 0 || rowCount === null || clearing}
              onClick={() => setIsAlertOpen(true)}
            />
          </div>
        </div>
      </div>

      <Alert
        isOpen={isAlertOpen}
        confirmButtonText={t("common.confirm", "Confirm")}
        cancelButtonText={t("common.cancel", "Cancel")}
        intent={Intent.DANGER}
        icon="trash"
        onConfirm={handleClearConfirm}
        onCancel={() => setIsAlertOpen(false)}
        loading={clearing}
      >
        <p>
          {t("settings.clearLocalDataConfirm", "Are you sure you want to clear all local logs stored for this profile? (Server logs remain unaffected)"
          )}
        </p>
      </Alert>
    </Card>
  );
};
