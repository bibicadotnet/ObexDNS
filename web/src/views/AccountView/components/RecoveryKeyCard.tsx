import React, { useState } from "react";
import {
  Card,
  Elevation,
  H4,
  Tag,
  Intent,
  Button,
  Callout,
  Alert,
  Tooltip,
  Position
} from "@blueprintjs/core";
import { Key, Lock, RefreshCw, Eye, EyeOff, Copy, Check, ShieldAlert, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UserInfo } from "../types";
import { VerifyIdentityDialog } from "./VerifyIdentityDialog";
import {
  rotateRecoveryKey,
  type VerifyIdentityPayload
} from "../../../services/account";
import { e2ee } from "../../../services/e2ee";

export interface RecoveryKeyCardProps {
  user: UserInfo;
  onRefresh: () => void;
}

export const RecoveryKeyCard: React.FC<RecoveryKeyCardProps> = ({ user, onRefresh }) => {
  const { t } = useTranslation();

  const [verifyDialogOpen, setVerifyDialogOpen] = useState(false);
  const [confirmRotateOpen, setConfirmRotateOpen] = useState(false);

  const [newKey, setNewKey] = useState<string | null>(null);
  const [isMasked, setIsMasked] = useState(false);
  const [copied, setCopied] = useState(false);

  const [cardMessage, setCardMessage] = useState<{ text: string; intent: Intent } | null>(null);

  const hasRecoveryKeys = !!(user.has_recovery_keys || user.recovery_keys_encrypted);

  const handleStartRotate = () => {
    setCardMessage(null);
    setConfirmRotateOpen(true);
  };

  const handleConfirmRotate = () => {
    setConfirmRotateOpen(false);
    setVerifyDialogOpen(true);
  };

  const handleVerifySubmit = async (payload: VerifyIdentityPayload) => {
    const res = await rotateRecoveryKey(payload);
    setNewKey(res.recovery_key);
    setIsMasked(false);

    let rewrapSuccess = false;
    // Re-wrap SK_user with newly rotated recovery key to maintain decryptability
    if (e2ee.isUnlocked()) {
      try {
        await e2ee.wrapCurrentKeyForRecovery(res.recovery_key);
        rewrapSuccess = true;
      } catch (wrapErr) {
        console.warn("[RecoveryKey] Failed to wrap E2EE key with new recovery key:", wrapErr);
      }
    } else {
      if (payload.recoveryKey) {
        try {
          await e2ee.unlockWithRecoveryKey(payload.recoveryKey);
          await e2ee.wrapCurrentKeyForRecovery(res.recovery_key);
          rewrapSuccess = true;
        } catch (err) {
          console.warn("[RecoveryKey] Failed to unlock and re-wrap with new recovery key:", err);
        }
      } else if (payload.passkeyAssertion) {
        try {
          await e2ee.unlockUser();
          await e2ee.wrapCurrentKeyForRecovery(res.recovery_key);
          rewrapSuccess = true;
        } catch (err) {
          console.warn("[RecoveryKey] Failed to unlock via Passkey and re-wrap:", err);
        }
      }
    }

    try {
      const e2eeStatus = await e2ee.getUserStatus();
      if (e2eeStatus.hasKeys && !rewrapSuccess) {
        setCardMessage({
          text: t("account.recoveryKey.rotateSuccessE2eeWarning"),
          intent: Intent.WARNING
        });
        onRefresh();
        return;
      }
    } catch {
      // ignore
    }

    setCardMessage({
      text: t("account.recoveryKey.rotateSuccess"),
      intent: Intent.SUCCESS
    });
    onRefresh();
  };

  const handleCopy = (keyText: string) => {
    navigator.clipboard.writeText(keyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Key size={18} className="text-amber-500" />
          <H4 className="section-title">
            {t("account.recoveryKey.title")}
          </H4>
          <Tag intent={hasRecoveryKeys ? Intent.SUCCESS : Intent.NONE} minimal round>
            {hasRecoveryKeys
              ? t("account.recoveryKey.configured")
              : t("account.recoveryKey.notConfigured")}
          </Tag>
          <Tooltip
            content={t("account.recoveryKey.oneWayTooltip")}
            position={Position.TOP}
          >
            <Tag
              intent={Intent.PRIMARY}
              minimal
              round
              icon={<ShieldCheck size={12} style={{ display: "inline-flex", alignItems: "center", marginRight: "4px" }} />}
            >
              {t("account.recoveryKey.oneWayHash")}
            </Tag>
          </Tooltip>
        </div>

        <div className="flex items-center gap-2">
          <Button
            small
            intent={Intent.WARNING}
            icon={<RefreshCw size={14} />}
            text={t("account.recoveryKey.rotateBtn")}
            onClick={handleStartRotate}
          />
        </div>
      </div>

      <p className="text-sm text-gray-600 ">
        {t("account.recoveryKey.descOneWay")}
      </p>

      {cardMessage && (
        <Callout intent={cardMessage.intent} className="my-2">
          {cardMessage.text}
        </Callout>
      )}

      {/* Displayed Newly Rotated Key Card */}
      {newKey && (
        <Card elevation={Elevation.ZERO} className="bg-amber-50/50 border border-amber-300 p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <span className="text-xs font-semibold text-amber-800 flex items-center gap-1.5">
              <ShieldAlert size={14} />
              {t("account.recoveryKey.newKeyGenerated")}
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              <Button
                minimal
                small
                icon={isMasked ? <Eye size={14} /> : <EyeOff size={14} />}
                onClick={() => setIsMasked(!isMasked)}
                title={isMasked ? t("auth.showPassword") : t("auth.hidePassword")}
              />
              <Button
                minimal
                small
                icon={copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                onClick={() => handleCopy(newKey)}
                title={t("common.copy")}
                text={copied ? t("common.copied") : t("common.copy")}
              />
              <Button
                minimal
                small
                icon="cross"
                onClick={() => setNewKey(null)}
                title={t("common.close")}
              />
            </div>
          </div>

          <div className="p-3 bg-white rounded border border-amber-200 font-mono text-center text-lg sm:text-xl font-bold select-all text-gray-900 ">
            {isMasked
              ? "••••••-••••••-••••••-••••••-••••••"
              : newKey}
          </div>

          <p className="text-xs text-amber-700 flex items-center gap-1">
            <Lock size={14} className="shrink-0" />
            {t("account.recoveryKey.oneWayWarning")}
          </p>
        </Card>
      )}

      {/* Rotation Confirmation Alert */}
      <Alert
        isOpen={confirmRotateOpen}
        onConfirm={handleConfirmRotate}
        onCancel={() => setConfirmRotateOpen(false)}
        cancelButtonText={t("common.cancel")}
        confirmButtonText={t("account.recoveryKey.confirmRotateBtn")}
        intent={Intent.DANGER}
        icon="warning-sign"
      >
        <p>
          {t("account.recoveryKey.rotateConfirm")}
        </p>
      </Alert>

      {/* Identity Verification Dialog (Passkey or original Recovery Key only) */}
      <VerifyIdentityDialog
        isOpen={verifyDialogOpen}
        onClose={() => setVerifyDialogOpen(false)}
        user={user}
        allowedMethods={["passkey", "recovery_key"]}
        title={t("account.recoveryKey.rotateVerifyTitle")}
        onVerify={handleVerifySubmit}
      />
    </div>
  );
};
