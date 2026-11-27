import React from "react";
import { Divider, Switch, Tag, Button, Intent } from "@blueprintjs/core";
import { KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProfileE2eeStatus } from "../../../../../services";

export interface E2eeStatusSectionProps {
  status: ProfileE2eeStatus | null;
  isLogsE2eeEnabled: boolean;
  isUnlocked: boolean;
  isPqc: boolean;
  hasPasskey: boolean;
  processing: boolean;
  loading: boolean;
  onToggleLogs: (checked: boolean) => Promise<void>;
  onUpgradeToPqc: () => Promise<void>;
  onLockDevice: () => void;
  onUnlockPasskey: () => Promise<void>;
  onOpenRecoveryUnlockDialog: () => void;
  onEnrollPasskey?: () => Promise<void>;
  onOpenResetAlert?: () => void;
}

export const E2eeStatusSection: React.FC<E2eeStatusSectionProps> = ({
  status,
  isLogsE2eeEnabled,
  isUnlocked,
  isPqc,
  hasPasskey,
  processing,
  loading,
  onToggleLogs,
  onUpgradeToPqc,
  onLockDevice,
  onUnlockPasskey,
  onOpenRecoveryUnlockDialog,
  onEnrollPasskey,
  onOpenResetAlert
}) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <Divider className="my-2" />

      {/* Direct Master Switch Card */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg border border-gray-200 bg-gray-50/70">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-gray-900">
              {t("account.e2ee.enableSwitch")}
            </span>
            <Tag
              intent={isLogsE2eeEnabled ? Intent.SUCCESS : Intent.NONE}
              minimal
              round
            >
              {isLogsE2eeEnabled
                ? t("account.e2ee.enabled")
                : t("account.e2ee.disabled")}
            </Tag>
          </div>
          <p className="text-xs text-gray-500 m-0">
            {t("account.e2ee.enableSwitchDesc")}
          </p>
        </div>
        <div className="shrink-0 flex items-center">
          <Switch
            checked={isLogsE2eeEnabled}
            disabled={processing || loading}
            onChange={(e) => onToggleLogs(e.currentTarget.checked)}
            large
            className="mb-0"
          />
        </div>
      </div>

      {/* Hardware Key & Device Status (shown when keypair exists) */}
      <div className="pt-2 border-t border-gray-100 space-y-2 text-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5">
          <span className="opacity-70 flex items-center gap-1.5 shrink-0">
            <KeyRound size={13} />
            {t("account.e2ee.keyType")}:
          </span>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono">
              {isPqc ? "P256-MLKEM768 + AES-256-GCM" : "ECDH P-256 + AES-256-GCM"}
            </span>
            {isPqc ? (
              <Tag minimal intent={Intent.PRIMARY} className="text-[10px]">
                {t("account.e2ee.pqcTag", "PQC / NIST FIPS 203")}
              </Tag>
            ) : (
              <Button
                small
                intent={Intent.PRIMARY}
                minimal
                icon={<RefreshCw size={12} />}
                text={t("account.e2ee.upgradePqcBtn", "Upgrade to Post-Quantum (PQC)")}
                loading={processing}
                onClick={onUpgradeToPqc}
              />
            )}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5">
          <span className="opacity-70 flex items-center gap-1.5 shrink-0">
            <ShieldCheck size={13} />
            {t("account.e2ee.deviceState")}:
          </span>
          {isUnlocked ? (
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <Tag minimal intent={Intent.SUCCESS} className="text-[10px]">
                {t("account.e2ee.unlocked")}
              </Tag>
              {hasPasskey && (status?.wrappedPasskeys?.length || 0) === 0 && onEnrollPasskey && (
                <Button
                  small
                  intent={Intent.PRIMARY}
                  icon={<KeyRound size={12} />}
                  text={t("account.e2ee.enrollPasskeyBtn", "Enroll Current Passkey")}
                  loading={processing}
                  onClick={onEnrollPasskey}
                />
              )}
              <Button
                small
                minimal
                intent={Intent.NONE}
                icon="lock"
                text={t("account.e2ee.lockDevice", "Lock this device")}
                onClick={onLockDevice}
              />
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {hasPasskey && (status?.wrappedPasskeys?.length || 0) > 0 && (
                <Button
                  small
                  minimal
                  intent={Intent.PRIMARY}
                  icon={<RefreshCw size={12} />}
                  text={t("account.e2ee.unlockButton")}
                  loading={processing}
                  onClick={onUnlockPasskey}
                />
              )}
              <Button
                small
                minimal
                intent={Intent.NONE}
                icon={<KeyRound size={12} />}
                text={t("account.e2ee.unlockRecoveryButton")}
                onClick={onOpenRecoveryUnlockDialog}
              />
              {onOpenResetAlert && (
                <Button
                  small
                  minimal
                  intent={Intent.DANGER}
                  icon="reset"
                  text={t("account.e2ee.resetKeypairBtn", "Reset Keypair")}
                  onClick={onOpenResetAlert}
                />
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between">
          <span className="opacity-70">
            {t("account.e2ee.protectedPasskeys")}:
          </span>
          <span className="font-mono">
            {status?.wrappedPasskeys?.length || 0}{" "}
            {t("account.e2ee.devicesUnit")}
          </span>
        </div>
      </div>
    </div>
  );
};
