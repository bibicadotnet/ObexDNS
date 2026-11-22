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
        message: t("settings.clearLocalDataSuccess"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
    } catch (err) {
      console.error("[LocalRetentionCard] Failed to clear local profile logs:", err);
      toasterRef?.current?.show({
        message: t("settings.clearLocalDataError"),
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
        <Database size={18} className="text-cyan-500" /> {t("settings.localRetentionTitle")}
      </H5>
      <div className="space-y-4">
        <FormGroup label={t("settings.localRetentionDuration")}>
          <HTMLSelect
            fill
            value={retentionDays}
            onChange={(e) => handleRetentionChange(parseInt(e.target.value, 10))}
          >
            <option value={30}>{t("settings.localRetention30d")}</option>
            <option value={90}>{t("settings.localRetention90d")}</option>
            <option value={180}>{t("settings.localRetention180d")}</option>
            <option value={365}>{t("settings.localRetention365d")}</option>
            <option value={0}>{t("settings.localRetentionUnlimited")}</option>
          </HTMLSelect>
        </FormGroup>

        <p className="text-xs opacity-60">
          {t("settings.localRetentionDesc")}
        </p>

        <div className="pt-3 border-t border-gray-100 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 opacity-70">
              <HardDrive size={14} />
              {t("settings.localEngineStorage")}:
            </span>
            <Tag
              minimal
              intent={isOpfs ? Intent.SUCCESS : Intent.WARNING}
              className="text-xs"
            >
              {isOpfs
                ? t("settings.localEngineOpfs")
                : t("settings.localEngineMemory")}
            </Tag>
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="opacity-70">{t("settings.localCachedCount")}:</span>
            <span className="font-mono font-medium">
              {rowCount !== null
                ? t("settings.localCachedCountUnit", { count: rowCount })
                : "..."}
            </span>
          </div>

          <div className="pt-1 flex justify-end">
            <Button
              minimal
              small
              intent={Intent.DANGER}
              icon={<Trash2 size={13} />}
              text={t("settings.clearLocalData")}
              disabled={rowCount === 0 || rowCount === null || clearing}
              onClick={() => setIsAlertOpen(true)}
            />
          </div>
        </div>
      </div>

      <Alert
        isOpen={isAlertOpen}
        confirmButtonText={t("common.confirm")}
        cancelButtonText={t("common.cancel")}
        intent={Intent.DANGER}
        icon="trash"
        onConfirm={handleClearConfirm}
        onCancel={() => setIsAlertOpen(false)}
        loading={clearing}
      >
        <p>
          {t("settings.clearLocalDataConfirm")}
        </p>
      </Alert>
    </Card>
  );
};
