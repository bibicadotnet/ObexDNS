import React, { useState, useEffect, useCallback } from "react";
import { Tag, Intent, type OverlayToaster } from "@blueprintjs/core";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../../components/PageHeader";

import type { UserInfo } from "./types";
import { getMe, updateMe } from "../../services";
import { executeWithTimeout } from "../../utils/async";
import { MfaCard } from "./components/MfaCard";
import { ActivityLogCard } from "./components/ActivityLogCard";
import { ActiveSessionsCard } from "./components/ActiveSessionsCard";
import { DangerZoneCard } from "./components/DangerZoneCard";
import { PersonalInfoCard } from "./components/PersonalInfoCard";
import { ChangePasswordCard } from "./components/ChangePasswordCard";
import { SessionLockCard } from "./components/SessionLockCard";
import { USERNAME_REGEX } from "../../utils/auth";

export interface AccountViewProps {
  onSavingChange?: (saving: boolean) => void;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

/**
 * AccountView serves as the dashboard for personal user settings: profile updates,
 * MFA (Passkey & TOTP) status, session lock, active login sessions, and security logs.
 */
export const AccountView: React.FC<AccountViewProps> = ({ onSavingChange, toasterRef }) => {
  const [me, setMe] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null);
  const { t, i18n } = useTranslation();

  const [isEditingUsername, setIsEditingUsername] = useState(false);
  const [editUsername, setEditUsername] = useState("");
  const [usernameLoading, setUsernameLoading] = useState(false);
  const [usernameFocused, setUsernameFocused] = useState(false);

  const fetchMe = useCallback(async () => {
    try {
      const data = await getMe();
      setMe(data);
      setEditUsername(data.username);
      window.dispatchEvent(new Event("user_updated"));
      if (data.timezone) {
        const { setSystemTimeZone } = await import("../../utils/date");
        setSystemTimeZone(data.timezone);
      }
      if (data.locale) {
        const { setSystemLocale } = await import("../../utils/date");
        setSystemLocale(data.locale);
        i18n.changeLanguage(data.locale);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [i18n]);

  const handleUpdateUsername = async () => {
    if (editUsername === me?.username) {
      setIsEditingUsername(false);
      return;
    }
    if (!USERNAME_REGEX.test(editUsername)) {
      toasterRef?.current?.show({
        message: t("account.formatTipUsername"),
        intent: Intent.WARNING,
        icon: "warning-sign",
      });
      return;
    }
    const previousUsername = me?.username || "";
    const targetUsername = editUsername;
    setUsernameLoading(true);
    onSavingChange?.(true);
    try {
      await executeWithTimeout(updateMe({ username: targetUsername }), 10000);
      setMe((prev) => (prev ? { ...prev, username: targetUsername } : null));
      setIsEditingUsername(false);
      toasterRef?.current?.show({
        message: t("common.saveSuccess", "Lưu thành công"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
    } catch (e: any) {
      console.error(e);
      setEditUsername(previousUsername);
      setMe((prev) => (prev ? { ...prev, username: previousUsername } : null));
      setIsEditingUsername(false);
      toasterRef?.current?.show({
        message: e.message || t("common.saveFailed", "Lưu thất bại"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setUsernameLoading(false);
      onSavingChange?.(false);
    }
  };

  const handleUpdateTimezone = async (newTimezone: string | null) => {
    const previousTimezone = me?.timezone ?? null;
    setMe((prev) => (prev ? { ...prev, timezone: newTimezone } : null));
    onSavingChange?.(true);
    try {
      await executeWithTimeout(updateMe({ timezone: newTimezone || "" }), 10000);
      const { setSystemTimeZone } = await import("../../utils/date");
      setSystemTimeZone(newTimezone || "");
      toasterRef?.current?.show({
        message: t("common.saveSuccess", "Lưu thành công"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
    } catch (e: any) {
      console.error(e);
      setMe((prev) => (prev ? { ...prev, timezone: previousTimezone } : null));
      const { setSystemTimeZone } = await import("../../utils/date");
      setSystemTimeZone(previousTimezone || "");
      toasterRef?.current?.show({
        message: e.message || t("common.saveFailed", "Lưu thất bại"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      onSavingChange?.(false);
    }
  };

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  if (loading)
    return <div className="p-8 text-center text-gray-500 font-medium">{t("common.loading", "Đang tải...")}</div>;

  return (
    <div className="w-full min-w-0 max-w-5xl mx-auto px-1 md:px-8 space-y-6">
      <PageHeader
        className="mb-0"
        title={t("account.title")}
        subtitle={t("account.subtitle")}
        actions={
          me && (
            <Tag
              large
              round
              intent={me.role === "admin" ? Intent.DANGER : Intent.PRIMARY}
              icon={<ShieldCheck size={16} />}
            >
              {me.role === "admin" ? t("account.roleAdmin") : t("account.roleUser")}
            </Tag>
          )
        }
      />

      {/* Personal Info + Password */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <PersonalInfoCard
          me={me}
          isEditingUsername={isEditingUsername}
          setIsEditingUsername={setIsEditingUsername}
          editUsername={editUsername}
          setEditUsername={setEditUsername}
          usernameLoading={usernameLoading}
          usernameFocused={usernameFocused}
          setUsernameFocused={setUsernameFocused}
          onUpdateUsername={handleUpdateUsername}
          onUpdateTimezone={handleUpdateTimezone}
        />

        <ChangePasswordCard me={me} onRefresh={fetchMe} />
      </div>

      {/* MFA: TOTP & Passkeys */}
      {me && <MfaCard user={me} onRefresh={fetchMe} />}

      {/* Session Lock */}
      {me && (
        <SessionLockCard
          user={me}
          onRefresh={fetchMe}
          onSavingChange={onSavingChange}
          toasterRef={toasterRef}
        />
      )}

      {/* Active Sessions */}
      {me && (
        <ActiveSessionsCard
          hoveredSessionId={hoveredSessionId}
          setHoveredSessionId={setHoveredSessionId}
        />
      )}

      {/* Activity Log */}
      {me && (
        <ActivityLogCard
          hoveredSessionId={hoveredSessionId}
          setHoveredSessionId={setHoveredSessionId}
        />
      )}

      {/* Danger Zone: Account Deletion / Inactivity Policy */}
      <DangerZoneCard
        isAdmin={me?.role === "admin"}
        user={me}
      />
    </div>
  );
};
