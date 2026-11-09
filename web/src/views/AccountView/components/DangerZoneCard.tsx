import React, { useState } from "react";
import {
  Card,
  Elevation,
  H4,
  Button,
  Intent,
  Callout,
  Dialog,
  Classes,
  FormGroup,
  InputGroup
} from "@blueprintjs/core";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { clearLogs, deleteMe } from "../../../services";
import type { UserInfo } from "../types";
import { hashPasswordClient } from "../../../utils/auth";

export interface DangerZoneCardProps {
  isAdmin: boolean;
  onLogsCleared?: () => void;
  user?: UserInfo | null;
}

export const DangerZoneCard: React.FC<DangerZoneCardProps> = ({ isAdmin, onLogsCleared, user }) => {
  const { t } = useTranslation();
  const [clearingLogs, setClearingLogs] = useState<boolean>(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState<boolean>(false);
  const [deletePassword, setDeletePassword] = useState<string>("");
  const [deleteLoading, setDeleteLoading] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string>("");

  const handleClearAllLogs = async () => {
    if (!confirm(t("account.confirmClearLogs"))) return;
    setClearingLogs(true);
    try {
      await clearLogs();
      alert(t("account.clearLogsSuccess"));
      onLogsCleared?.();
    } catch (e) {
      console.error(e);
    } finally {
      setClearingLogs(false);
    }
  };

  const handleDeleteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deletePassword) return;
    setDeleteLoading(true);
    setDeleteError("");
    try {
      let passwordPayload = deletePassword;
      if (user?.password_version === 2 && user.username) {
        passwordPayload = await hashPasswordClient(deletePassword, user.username);
      }
      await deleteMe({ password: passwordPayload });
      window.location.href = "/";
    } catch (e: any) {
      setDeleteError(e.message || t("common.errorNetwork"));
    } finally {
      setDeleteLoading(false);
    }
  };

  const renderInactivityContent = () => {
    if (isAdmin) {
      return (
        <Callout intent={Intent.PRIMARY} icon="info-sign" title={t("account.inactivityPolicy")}>
          <p className="text-sm">
            {t("account.inactivityAdminNotice", "Tài khoản Quản trị viên (Admin) không bao giờ bị xóa tự động.")}
            {user?.inactivity_threshold_days === 0 && user?.inactivity_user_days === 0 && (
              <span className="block mt-1 opacity-75">
                {t("account.inactivityDisabled", "Chính sách tự động xóa do không hoạt động hiện đang được TẮT trên hệ thống.")}
              </span>
            )}
          </p>
        </Callout>
      );
    }

    const profileDays = user?.inactivity_threshold_days ?? 30;
    const userDays = user?.inactivity_user_days ?? 90;

    if (profileDays === 0 && userDays === 0) {
      return (
        <Callout intent={Intent.NONE} icon="info-sign" title={t("account.inactivityPolicy")}>
          <p className="text-sm">
            {t("account.inactivityDisabled", "Chính sách tự động xóa do không hoạt động hiện đang được TẮT trên hệ thống.")}
          </p>
        </Callout>
      );
    }

    const parts: string[] = [];
    if (profileDays > 0) {
      parts.push(t("account.inactivityProfilePart", {
        days: profileDays,
        defaultValue: `Tất cả nhật ký truy vấn và cấu hình DNS của các tài khoản không có hoạt động phân giải trong ${profileDays} ngày sẽ được tự động xóa.`
      }));
    }
    if (userDays > 0) {
      parts.push(t("account.inactivityUserPart", {
        days: userDays,
        defaultValue: `Bản thân tài khoản sẽ bị xóa sau ${userDays} ngày không có hoạt động phân giải hoặc đăng nhập.`
      }));
    }

    return (
      <Callout intent={Intent.WARNING} icon="info-sign" title={t("account.inactivityPolicy")}>
        <p className="text-sm">{parts.join(" ")}</p>
      </Callout>
    );
  };

  return (
    <>
      <H4 className="text-red-500 flex items-center gap-2">
        <Trash2 size={20} /> {t("account.dangerZone")}
      </H4>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card elevation={Elevation.ONE} className="flex flex-col justify-between">
          <div>
            <H4>{t("account.clearLogs")}</H4>
            <p className="text-xs opacity-60 mb-3">{t("account.clearLogsDesc")}</p>
          </div>
          <Button
            fill
            intent={Intent.DANGER}
            text={t("account.clearLogsBtn")}
            icon="trash"
            loading={clearingLogs}
            onClick={handleClearAllLogs}
          />
        </Card>
        {!isAdmin && (
          <Card elevation={Elevation.ONE} className="flex flex-col justify-between">
            <div>
              <H4>{t("account.deleteAccount")}</H4>
              <p className="text-xs opacity-60 mb-4">{t("account.deleteAccountDesc")}</p>
            </div>
            <Button
              fill
              intent={Intent.DANGER}
              text={t("account.deleteAccountBtn")}
              icon="delete"
              onClick={() => {
                setDeletePassword("");
                setDeleteError("");
                setDeleteDialogOpen(true);
              }}
            />
          </Card>
        )}
      </div>
      {renderInactivityContent()}

      <Dialog
        isOpen={deleteDialogOpen}
        onClose={() => !deleteLoading && setDeleteDialogOpen(false)}
        title={t("account.deleteAccount")}
        className="max-w-md"
      >
        <form onSubmit={handleDeleteSubmit}>
          <div className={Classes.DIALOG_BODY}>
            <p className="text-sm opacity-80 mb-3 text-red-500 font-medium">
              {t("account.confirmDeleteAccount")}
            </p>
            <FormGroup
              label={t("account.totp.enterPassword", "Enter your password to confirm:")}
              labelFor="delete-account-password"
            >
              <InputGroup
                id="delete-account-password"
                type="password"
                placeholder={t("account.totp.passwordPlaceholder", "Account password")}
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                autoFocus
              />
            </FormGroup>
            {deleteError && (
              <Callout intent={Intent.DANGER} className="mt-2 text-xs">
                {deleteError}
              </Callout>
            )}
          </div>
          <div className={Classes.DIALOG_FOOTER}>
            <div className={Classes.DIALOG_FOOTER_ACTIONS}>
              <Button
                text={t("common.cancel", "Cancel")}
                onClick={() => setDeleteDialogOpen(false)}
                disabled={deleteLoading}
              />
              <Button
                intent={Intent.DANGER}
                text={t("account.deleteAccountBtn", "Delete Account")}
                type="submit"
                loading={deleteLoading}
                disabled={deleteLoading || !deletePassword.trim()}
              />
            </div>
          </div>
        </form>
      </Dialog>
    </>
  );
};
