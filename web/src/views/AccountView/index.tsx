import React, { useState, useEffect, useCallback } from "react";
import { Tag, Intent, type OverlayToaster, Dialog, DialogBody, DialogFooter, Button, FormGroup, InputGroup, Callout } from "@blueprintjs/core";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../../components/PageHeader";

import type { UserInfo } from "./types";
import { getMe, updateMe } from "../../services";
import { executeWithTimeout } from "../../utils/async";
import { updateLocale } from "../../utils/locale";
import { MfaCard } from "./components/MfaCard";
import { ActivityLogCard } from "./components/ActivityLogCard";
import { ActiveSessionsCard } from "./components/ActiveSessionsCard";
import { DangerZoneCard } from "./components/DangerZoneCard";
import { PersonalInfoCard } from "./components/PersonalInfoCard";
import { ChangePasswordCard } from "./components/ChangePasswordCard";
import { SessionLockCard } from "./components/SessionLockCard";
import { USERNAME_REGEX, hashPasswordClient } from "../../utils/auth";

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

  // Password prompt for v2 username change
  const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);
  const [pendingUsername, setPendingUsername] = useState("");
  const [passwordPromptValue, setPasswordPromptValue] = useState("");
  const [passwordPromptLoading, setPasswordPromptLoading] = useState(false);
  const [passwordPromptError, setPasswordPromptError] = useState<string | null>(null);
  const [showPasswordPromptText, setShowPasswordPromptText] = useState(false);

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
    } catch (e: any) {
      console.error(e);
      toasterRef?.current?.show({
        message: e?.message || "Failed to load account info",
        intent: "danger",
        icon: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [i18n, toasterRef]);

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

    // For v2 passwords: username is the PBKDF2 salt – must re-hash with new username
    if ((me?.password_version ?? 1) === 2) {
      setPendingUsername(editUsername);
      setPasswordPromptValue("");
      setPasswordPromptError(null);
      setShowPasswordPromptText(false);
      setShowPasswordPrompt(true);
      return;
    }

    await doUpdateUsername(editUsername, undefined, undefined).catch((e: any) => {
      toasterRef?.current?.show({
        message: e.message || t("common.saveFailed", "Save failed"),
        intent: Intent.DANGER,
        icon: "error",
      });
    });
  };

  const doUpdateUsername = async (
    targetUsername: string,
    newPasswordHash: string | undefined,
    currentPasswordHash: string | undefined
  ) => {
    const previousUsername = me?.username || "";
    setUsernameLoading(true);
    onSavingChange?.(true);
    try {
      await executeWithTimeout(
        updateMe({
          username: targetUsername,
          ...(newPasswordHash ? { new_password_hash: newPasswordHash } : {}),
          ...(currentPasswordHash ? { current_password_hash: currentPasswordHash } : {}),
        }),
        10000
      );
      setMe((prev) => (prev ? { ...prev, username: targetUsername } : null));
      setIsEditingUsername(false);
      toasterRef?.current?.show({
        message: t("common.saveSuccess", "Saved successfully"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
    } catch (e: any) {
      console.error(e);
      setEditUsername(previousUsername);
      setMe((prev) => (prev ? { ...prev, username: previousUsername } : null));
      setIsEditingUsername(false);
      // Re-throw so callers (e.g. the password prompt dialog) can handle the error themselves.
      throw e;
    } finally {
      setUsernameLoading(false);
      onSavingChange?.(false);
    }
  };

  const handlePasswordPromptConfirm = async () => {
    if (!passwordPromptValue) return;
    setPasswordPromptLoading(true);
    setPasswordPromptError(null);
    try {
      const currentUsername = me?.username || "";
      const currentHash = await hashPasswordClient(passwordPromptValue, currentUsername.toLowerCase());
      const newHash = await hashPasswordClient(passwordPromptValue, pendingUsername.toLowerCase());
      await doUpdateUsername(pendingUsername, newHash, currentHash);
      // Only close the dialog after the server confirms success.
      setShowPasswordPrompt(false);
      setPasswordPromptValue("");
    } catch (e: any) {
      // Keep the dialog open and show the error inline so the user can retry.
      setPasswordPromptError(e.message || t("common.saveFailed", "Save failed"));
    } finally {
      setPasswordPromptLoading(false);
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
        message: t("common.saveSuccess", "Saved successfully"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
    } catch (e: any) {
      console.error(e);
      setMe((prev) => (prev ? { ...prev, timezone: previousTimezone } : null));
      const { setSystemTimeZone } = await import("../../utils/date");
      setSystemTimeZone(previousTimezone || "");
      toasterRef?.current?.show({
        message: e.message || t("common.saveFailed", "Save failed"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      onSavingChange?.(false);
    }
  };

  const handleUpdateLocale = async (newLocale: string) => {
    setMe((prev) => (prev ? { ...prev, locale: newLocale } : null));
    onSavingChange?.(true);
    try {
      await updateLocale(newLocale);
      toasterRef?.current?.show({
        message: t("common.saveSuccess", "Saved successfully"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
    } catch (e: any) {
      console.error(e);
      toasterRef?.current?.show({
        message: e.message || t("common.saveFailed", "Save failed"),
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
    return <div className="p-8 text-center text-gray-500 font-medium">{t("common.loading", "Loading...")}</div>;

  return (
    <div className="w-full min-w-0 max-w-5xl mx-auto px-1 md:px-8 space-y-6 pb-24">
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
          onUpdateLocale={handleUpdateLocale}
        />

        <ChangePasswordCard me={me} onRefresh={fetchMe} />
      </div>

      {/* MFA: TOTP & Passkeys */}
      {me && <MfaCard user={me} onRefresh={fetchMe} toasterRef={toasterRef} />}

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
          toasterRef={toasterRef}
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
        toasterRef={toasterRef}
      />

      {/* Password re-hash prompt for v2 username change */}
      <Dialog
        isOpen={showPasswordPrompt}
        onClose={() => { if (!passwordPromptLoading) { setShowPasswordPrompt(false); setEditUsername(me?.username || ""); } }}
        title={t("account.confirmPasswordForUsernameChange", "Confirm current password")}
        canEscapeKeyClose={!passwordPromptLoading}
        canOutsideClickClose={!passwordPromptLoading}
      >
        <DialogBody>
          <p className="text-sm text-gray-600 mb-3">
            {t("account.usernameChangePasswordHint", "Because your password is derived from your username, changing it requires confirming your current password.")}
          </p>
          {passwordPromptError && (
            <Callout intent={Intent.DANGER} className="mb-3">
              {passwordPromptError}
            </Callout>
          )}
          <FormGroup label={t("account.currentPassword", "Current password")}>
            <InputGroup
              type={showPasswordPromptText ? "text" : "password"}
              value={passwordPromptValue}
              onChange={(e) => setPasswordPromptValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !passwordPromptLoading) handlePasswordPromptConfirm(); }}
              autoFocus
              rightElement={
                <Button
                  minimal
                  icon={showPasswordPromptText ? "eye-off" : "eye-open"}
                  onClick={() => setShowPasswordPromptText((v) => !v)}
                  tabIndex={-1}
                />
              }
            />
          </FormGroup>
        </DialogBody>
        <DialogFooter
          actions={
            <>
              <Button
                disabled={passwordPromptLoading}
                onClick={() => { setShowPasswordPrompt(false); setEditUsername(me?.username || ""); }}
              >
                {t("common.cancel", "Cancel")}
              </Button>
              <Button
                intent={Intent.PRIMARY}
                loading={passwordPromptLoading}
                disabled={!passwordPromptValue || passwordPromptLoading}
                onClick={handlePasswordPromptConfirm}
              >
                {t("common.confirm", "Confirm")}
              </Button>
            </>
          }
        />
      </Dialog>
    </div>
  );
};
