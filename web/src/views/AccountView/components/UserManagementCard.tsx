import React, { useState, useEffect } from "react";
import {
  Card,
  Elevation,
  H4,
  Button,
  Intent,
  HTMLTable,
  Dialog,
  FormGroup,
  InputGroup,
  HTMLSelect,
  Tag,
  Switch,
  type OverlayToaster
} from "@blueprintjs/core";
import { ShieldCheck, UserPlus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "../../../utils/date";
import { useContainerWidth } from "../../../hooks/useContainerWidth";
import { PASSWORD_REGEX, USERNAME_REGEX, hashPasswordClient } from "../../../utils/auth";
import type { UserInfo } from "../../../services";
import { createUser, deleteUser, updateSystemSettings } from "../../../services";
import { executeWithTimeout } from "../../../utils/async";

export interface UserManagementCardProps {
  users: UserInfo[];
  currentUserId: string;
  onRefresh: () => void;
  registrationEnabled?: boolean;
  onRefreshSettings?: () => void;
  onSavingChange?: (saving: boolean) => void;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

const TABLE_MIN_WIDTH = 768;

export const UserManagementCard: React.FC<UserManagementCardProps> = ({
  users,
  currentUserId,
  onRefresh,
  registrationEnabled = true,
  onRefreshSettings,
  onSavingChange,
  toasterRef,
}) => {
  const { t } = useTranslation();
  const [containerRef, containerWidth] = useContainerWidth();
  const showCards = containerWidth > 0 && containerWidth < TABLE_MIN_WIDTH;

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState<'admin' | 'user'>('user');
  const [createLoading, setCreateLoading] = useState(false);
  const [showNewUserPassword, setShowNewUserPassword] = useState(false);
  const [isRegistrationEnabled, setIsRegistrationEnabled] = useState(registrationEnabled);
  const [toggleLoading, setToggleLoading] = useState(false);

  useEffect(() => {
    setIsRegistrationEnabled(registrationEnabled);
  }, [registrationEnabled]);

  const handleToggleRegistration = async (checked: boolean) => {
    const previousState = isRegistrationEnabled;
    setIsRegistrationEnabled(checked);
    setToggleLoading(true);
    onSavingChange?.(true);
    try {
      await executeWithTimeout(
        updateSystemSettings({ registration_enabled: String(checked) }),
        10000
      );
      toasterRef?.current?.show({
        message: t("common.saveSuccess", "保存成功"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
      onRefreshSettings?.();
    } catch (e: any) {
      console.error(e);
      // Revert to original configuration
      setIsRegistrationEnabled(previousState);
      toasterRef?.current?.show({
        message: e.message || t("common.saveFailed", "保存失败"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setToggleLoading(false);
      onSavingChange?.(false);
    }
  };

  const handleCreateUser = async () => {
    if (!USERNAME_REGEX.test(newUsername)) { alert(t("account.formatTipUsername")); return; }
    if (!PASSWORD_REGEX.test(newUserPassword)) { alert(t("account.formatTipPassword")); return; }
    setCreateLoading(true);
    try {
      const clientHash = await hashPasswordClient(newUserPassword, newUsername);
      await createUser({ username: newUsername, password: clientHash, role: newUserRole });
      setIsDialogOpen(false);
      setNewUsername("");
      setNewUserPassword("");
      setShowNewUserPassword(false);
      onRefresh();
    } catch (e: any) {
      console.error(e);
      alert(e.message || t("common.errorNetwork"));
    }
    finally { setCreateLoading(false); }
  };

  const renderCompactDate = (timestamp?: number | null) => {
    if (!timestamp) return <span className="text-gray-400">—</span>;
    const d = new Date(timestamp * 1000);
    const fullStr = formatDateTime(d);
    const dateStr = d.toLocaleDateString();
    const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    return (
      <div className="leading-tight" title={fullStr}>
        <span className="font-medium text-gray-700 block">{dateStr}</span>
        <span className="text-[11px] text-gray-400 block font-mono">{timeStr}</span>
      </div>
    );
  };

  const handleDeleteUser = async (id: string) => {
    if (!confirm(t("account.confirmDeleteUser"))) return;
    try {
      await deleteUser(id);
      onRefresh();
    } catch (e) { console.error(e); }
  };

  return (
    <Card elevation={Elevation.ONE} className="p-5 sm:p-6 rounded-2xl bg-white border border-[#d0d7de] shadow-xs space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <ShieldCheck size={20} className="text-red-500" />
          <H4 className="section-title m-0">{t("account.userManagement")}</H4>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <Switch
            label={t("account.enableRegistration", "Cho phép đăng ký mới")}
            checked={isRegistrationEnabled}
            disabled={toggleLoading}
            onChange={(e) => handleToggleRegistration(e.currentTarget.checked)}
            className="mb-0"
          />
          <Button className="whitespace-nowrap" icon={<UserPlus size={16} />} intent={Intent.SUCCESS} text={t("account.createUser")} onClick={() => setIsDialogOpen(true)} />
        </div>
      </div>
      {showCards ? (
        <div ref={containerRef} className="w-full min-w-0 pb-2">
          <div className="flex flex-col gap-3">
            {users.map((u) => (
              <div
                key={u.id}
                className="p-4 rounded-xl border border-gray-200 bg-white shadow-xs space-y-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm text-gray-900 truncate">
                        {u.username}
                      </span>
                      <Tag minimal intent={u.role === "admin" ? Intent.DANGER : Intent.NONE}>
                        {u.role === "admin" ? t("account.roleAdmin") : t("account.roleUser")}
                      </Tag>
                      {Boolean(u.totp_enabled) && <Tag minimal intent={Intent.SUCCESS}>TOTP</Tag>}
                      {Boolean(u.passkeys_count && u.passkeys_count > 0) && <Tag minimal intent={Intent.PRIMARY}>Passkey</Tag>}
                      {!u.totp_enabled && !(u.passkeys_count && u.passkeys_count > 0) && (
                        <Tag minimal intent={Intent.NONE} style={{ color: "#8a9ba8" }}>
                          {t("account.mfaNone", "无")}
                        </Tag>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-gray-400 font-mono">
                      ID: {u.id}
                    </div>
                  </div>
                  <Button
                    minimal
                    intent={Intent.DANGER}
                    icon={<Trash2 size={15} />}
                    disabled={u.id === currentUserId}
                    onClick={() => handleDeleteUser(u.id)}
                    title={t("common.delete", "Xóa")}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-gray-100 text-xs">
                  <div>
                    <span className="text-gray-400 block text-[11px] uppercase tracking-wide mb-0.5">
                      {t("account.createdAt")}
                    </span>
                    {renderCompactDate(u.created_at)}
                  </div>
                  <div>
                    <span className="text-gray-400 block text-[11px] uppercase tracking-wide mb-0.5">
                      {t("account.lastActive")}
                    </span>
                    {renderCompactDate(u.last_active_at)}
                  </div>
                  <div>
                    <span className="text-gray-400 block text-[11px] uppercase tracking-wide mb-0.5">
                      {t("account.lastResolve")}
                    </span>
                    {renderCompactDate(u.last_resolve_at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div ref={containerRef} className="p-0 overflow-hidden rounded-xl border border-gray-200">
          <HTMLTable interactive striped className="w-full">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left font-semibold text-xs text-gray-500 uppercase tracking-wider py-3 px-3">{t("account.username")}</th>
                <th className="text-left font-semibold text-xs text-gray-500 uppercase tracking-wider py-3 px-3">{t("account.role")}</th>
                <th className="text-left font-semibold text-xs text-gray-500 uppercase tracking-wider py-3 px-3">MFA</th>
                <th className="text-left font-semibold text-xs text-gray-500 uppercase tracking-wider py-3 px-3">ID</th>
                <th className="text-left font-semibold text-xs text-gray-500 uppercase tracking-wider py-3 px-3 whitespace-nowrap">{t("account.createdAt")}</th>
                <th className="text-left font-semibold text-xs text-gray-500 uppercase tracking-wider py-3 px-3 whitespace-nowrap">{t("account.lastActive")}</th>
                <th className="text-left font-semibold text-xs text-gray-500 uppercase tracking-wider py-3 px-3 whitespace-nowrap">{t("account.lastResolve")}</th>
                <th className="text-right font-semibold text-xs text-gray-500 uppercase tracking-wider py-3 px-3 w-14">{t("account.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td className="font-bold text-sm text-gray-900 py-3 px-3">{u.username}</td>
                  <td className="py-3 px-3">
                    <Tag minimal intent={u.role === 'admin' ? Intent.DANGER : Intent.NONE}>
                      {u.role === 'admin' ? t("account.roleAdmin") : t("account.roleUser")}
                    </Tag>
                  </td>
                  <td className="py-3 px-3">
                    <div className="flex flex-wrap gap-1">
                      {Boolean(u.totp_enabled) && <Tag minimal intent={Intent.SUCCESS}>TOTP</Tag>}
                      {Boolean(u.passkeys_count && u.passkeys_count > 0) && <Tag minimal intent={Intent.PRIMARY}>Passkey</Tag>}
                      {!u.totp_enabled && !(u.passkeys_count && u.passkeys_count > 0) && (
                        <Tag minimal intent={Intent.NONE} style={{ color: "#8a9ba8" }}>{t("account.mfaNone", "无")}</Tag>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-3">
                    <code className="text-xs font-mono text-gray-600 select-all" title={u.id}>{u.id}</code>
                  </td>
                  <td className="py-3 px-3 whitespace-nowrap">
                    {renderCompactDate(u.created_at)}
                  </td>
                  <td className="py-3 px-3 whitespace-nowrap">
                    {renderCompactDate(u.last_active_at)}
                  </td>
                  <td className="py-3 px-3 whitespace-nowrap">
                    {renderCompactDate(u.last_resolve_at)}
                  </td>
                  <td className="text-right py-3 px-3">
                    <div className="inline-flex items-center gap-1">
                      <Button
                        minimal
                        intent={Intent.DANGER}
                        icon={<Trash2 size={14} />}
                        disabled={u.id === currentUserId}
                        onClick={() => handleDeleteUser(u.id)}
                        title={t("common.delete", "Xóa")}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </HTMLTable>
        </div>
      )}

      <Dialog isOpen={isDialogOpen} onClose={() => { setIsDialogOpen(false); setShowNewUserPassword(false); }} title={t("account.createNewUser")} icon="user">
        <div className="p-6 space-y-4">
          <FormGroup label={t("account.username")}><InputGroup value={newUsername} onChange={e => setNewUsername(e.target.value)} placeholder={t("auth.usernamePlaceholder")} /></FormGroup>
          <FormGroup label={t("account.initialPassword")}>
            <InputGroup
              type={showNewUserPassword ? "text" : "password"}
              value={newUserPassword}
              onChange={e => setNewUserPassword(e.target.value)}
              placeholder={t("auth.passwordPlaceholder")}
              rightElement={
                <Button
                  minimal={true}
                  icon={showNewUserPassword ? "eye-open" : "eye-off"}
                  onClick={() => setShowNewUserPassword(!showNewUserPassword)}
                  title={showNewUserPassword ? t("auth.hidePassword", "Hide password") : t("auth.showPassword", "Show password")}
                />
              }
            />
          </FormGroup>
          <FormGroup label={t("account.userRole")}>
            <HTMLSelect fill value={newUserRole} onChange={e => setNewUserRole(e.target.value as any)} options={[{ label: t("account.roleUser"), value: "user" }, { label: t("account.roleAdmin"), value: "admin" }]} />
          </FormGroup>
          <div className="flex justify-end gap-2 mt-6">
            <Button text={t("account.cancel")} onClick={() => setIsDialogOpen(false)} />
            <Button intent={Intent.PRIMARY} text={t("account.createNow")} loading={createLoading} onClick={handleCreateUser} />
          </div>
        </div>
      </Dialog>
    </Card>
  );
};
