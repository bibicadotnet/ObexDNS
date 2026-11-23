import React, { useState, useEffect, useCallback } from "react";
import { Tag, Intent, Callout, type OverlayToaster } from "@blueprintjs/core";
import { ShieldCheck, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader";
import type { UserInfo } from "../AccountView/types";
import {
  getUsers,
  getSystemSettings,
  getDatabaseStatus,
  type DatabaseStatusResponse,
} from "../../services";
import { UserManagementCard } from "../AccountView/components/UserManagementCard";
import { SystemSettingsCard } from "../AccountView/components/SystemSettingsCard";
import { DatabaseMigrationCard } from "../AccountView/components/DatabaseMigrationCard";

export interface SystemViewProps {
  onSavingChange?: (saving: boolean) => void;
  toasterRef?: React.RefObject<OverlayToaster | null>;
  currentUser?: UserInfo | null;
}

export const SystemView: React.FC<SystemViewProps> = ({
  onSavingChange,
  toasterRef,
  currentUser,
}) => {
  const { t } = useTranslation();
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [sysSettings, setSysSettings] = useState<Record<string, string>>({});
  const [dbStatus, setDbStatus] = useState<DatabaseStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUsers = useCallback(async () => {
    try {
      const data = (await getUsers()) as UserInfo[];
      setUsers(data);
    } catch (e) {
      console.error("Failed to load users:", e);
    }
  }, []);

  const fetchSystemSettings = useCallback(async () => {
    try {
      const settings = await getSystemSettings();
      setSysSettings(settings);
    } catch (e) {
      console.error("Failed to load system settings:", e);
    }
  }, []);

  const fetchDbStatus = useCallback(async () => {
    try {
      const status = await getDatabaseStatus();
      setDbStatus(status);
    } catch (e) {
      console.error("Failed to fetch database status:", e);
    }
  }, []);

  useEffect(() => {
    if (currentUser?.role !== "admin") return;
    const initData = async () => {
      setLoading(true);
      await Promise.all([fetchUsers(), fetchSystemSettings(), fetchDbStatus()]);
      setLoading(false);
    };
    initData();
  }, [currentUser, fetchUsers, fetchSystemSettings, fetchDbStatus]);

  // Restrict to admins only
  if (currentUser && currentUser.role !== "admin") {
    return <Navigate to="/dash" replace />;
  }

  if (loading) {
    return <div className="p-8 text-center text-gray-500 font-medium">{t("common.loading", "Đang tải...")}</div>;
  }

  return (
    <div className="w-full min-w-0 max-w-5xl mx-auto px-1 md:px-8 space-y-6">
      <PageHeader
        className="mb-0"
        title={t("system.title", "Quản trị hệ thống")}
        subtitle={t("system.subtitle", "Quản lý người dùng, cấu hình máy chủ và cơ sở dữ liệu")}
        actions={
          <Tag large round intent={Intent.DANGER} icon={<ShieldCheck size={16} />}>
            {t("account.roleAdmin", "Quản trị viên")}
          </Tag>
        }
      />

      {/* Non-blocking Security Warning for Weak JWT_SECRET */}
      {currentUser?.jwt_secret_warning && (
        <Callout
          intent={Intent.WARNING}
          icon={<AlertTriangle size={18} />}
          title={t("account.jwtSecretWarningTitle")}
        >
          <div className="text-sm leading-relaxed mt-1">
            {t("account.jwtSecretWarningDesc")}
          </div>
        </Callout>
      )}

      {/* Admin: User Management */}
      <UserManagementCard
        users={users}
        currentUserId={currentUser?.id || ""}
        onRefresh={fetchUsers}
        registrationEnabled={sysSettings.registration_enabled !== "false"}
        onRefreshSettings={fetchSystemSettings}
        onSavingChange={onSavingChange}
        toasterRef={toasterRef}
      />

      {/* Admin: System Settings */}
      <SystemSettingsCard
        initialSettings={sysSettings}
        onRefresh={fetchSystemSettings}
        onSavingChange={onSavingChange}
        toasterRef={toasterRef}
      />

      {/* Admin: Database Management */}
      <DatabaseMigrationCard
        status={dbStatus}
        onRefresh={fetchDbStatus}
        toasterRef={toasterRef}
      />
    </div>
  );
};
