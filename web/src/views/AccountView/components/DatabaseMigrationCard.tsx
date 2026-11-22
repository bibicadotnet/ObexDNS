import React, { useState } from "react";
import {
  Card,
  Elevation,
  H4,
  Tag,
  Intent,
  Button,
  Callout,
  type OverlayToaster
} from "@blueprintjs/core";
import { Database, CheckCircle2, AlertCircle, Play, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { DatabaseStatusResponse } from "../../../services";
import { runDatabaseMigrations } from "../../../services";

export interface DatabaseMigrationCardProps {
  status: DatabaseStatusResponse | null;
  onRefresh: () => Promise<void>;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

export const DatabaseMigrationCard: React.FC<DatabaseMigrationCardProps> = ({
  status,
  onRefresh,
  toasterRef,
}) => {
  const { t } = useTranslation();
  const [migrating, setMigrating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const migrations = status?.migrations;
  const isCompleted = migrations?.completed ?? false;

  const formatDatabaseEngine = (service?: string) => {
    if (service === "Turso") return "Turso (libSQL)";
    if (service === "D1") return "Cloudflare D1";
    if (service === "File") return "SQLite (Local File)";
    return service || "SQLite";
  };

  const handleRunMigrations = async () => {
    setMigrating(true);
    try {
      const res = await runDatabaseMigrations();
      toasterRef?.current?.show({
        message: t("account.migrationSuccess", { count: res.appliedCount }),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
      await onRefresh();
    } catch (e: any) {
      console.error(e);
      toasterRef?.current?.show({
        message: e.message || t("account.migrationFailed"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setMigrating(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database size={20} className="text-gray-500" />
          <H4 className="section-title">{t("account.databaseSettings")}</H4>
        </div>
        {migrations ? (
          <Tag
            large
            round
            intent={isCompleted ? Intent.SUCCESS : Intent.WARNING}
            icon={isCompleted ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          >
            {isCompleted
              ? t("account.migrationCompleted")
              : t("account.migrationPending")}
          </Tag>
        ) : (
          <Tag large round intent={Intent.NONE}>
            {t("common.loading")}
          </Tag>
        )}
      </div>

      <Card elevation={Elevation.ONE}>
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <span className="text-xs font-semibold text-gray-500 ">
                {t("account.databaseEngine")}
              </span>
              <div className="text-sm font-medium mt-1">
                {formatDatabaseEngine(status?.databaseService)}
              </div>
            </div>

            <div>
              <span className="text-xs font-semibold text-gray-500 ">
                {t("account.lastAppliedMigration")}
              </span>
              <div className="text-sm font-medium font-mono text-gray-700 mt-1 truncate">
                {migrations?.lastApplied || t("account.noMigrationsApplied")}
              </div>
            </div>
          </div>

          <div>
            <span className="text-xs font-semibold text-gray-500 ">
              {t("account.migrationStatus")}
            </span>
            <p className="text-sm text-gray-600 mt-1">
              {migrations
                ? isCompleted
                  ? t("account.migrationCompletedDesc", {
                      total: migrations?.totalAvailable || 0,
                    })
                  : t("account.migrationPendingDesc", {
                      applied: migrations?.appliedCount || 0,
                      total: migrations?.totalAvailable || 0,
                      pending: migrations?.pendingCount || 0,
                    })
                : t("common.loading")}
            </p>
          </div>

          {!isCompleted && migrations && migrations.pendingFiles.length > 0 && (
            <Callout intent={Intent.WARNING} icon={<AlertCircle size={16} />}>
              <div className="text-xs font-semibold mb-1">
                {t("account.pendingMigrationsList")}
              </div>
              <ul className="list-disc list-inside text-xs font-mono space-y-0.5 text-gray-700 max-h-32 overflow-y-auto">
                {migrations.pendingFiles.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </Callout>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-gray-100 ">
            <Button
              minimal
              icon={<RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />}
              text={t("account.checkMigration")}
              onClick={handleRefresh}
              disabled={migrating || refreshing}
            />

            <Button
              intent={Intent.PRIMARY}
              icon={<Play size={14} />}
              text={
                migrating
                  ? t("account.runningMigration")
                  : t("account.runMigration")
              }
              loading={migrating}
              disabled={isCompleted || migrating}
              onClick={handleRunMigrations}
            />
          </div>
        </div>
      </Card>
    </>
  );
};
