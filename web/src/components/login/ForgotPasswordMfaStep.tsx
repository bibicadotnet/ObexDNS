import React from "react";
import { FormGroup, Button, Intent, Callout } from "@blueprintjs/core";
import { Key, ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DigitInput } from "../DigitInput";
import { RecoveryKeyInput } from "../RecoveryKeyInput";
import type { ForgotPasswordInitResponse } from "../../services";

/**
 * Props for the ForgotPasswordMfaStep component.
 */
export interface ForgotPasswordMfaStepProps {
  /** Server initialization response containing MFA configurations and recoveryToken. */
  initData: ForgotPasswordInitResponse;
  /** Username currently being recovered. */
  username: string;
  /** Currently selected MFA verification method. */
  mfaMode: "passkey" | "totp" | "recovery";
  /** Callback to change the active MFA verification method. */
  setMfaMode: (mode: "passkey" | "totp" | "recovery") => void;
  /** Whether WebAuthn passkey assertion is actively running. */
  passkeyLoading: boolean;
  /** Callback to trigger passkey verification. */
  onPasskeyVerify: () => void;
  /** Current 6-digit TOTP code input. */
  totpToken: string;
  /** Callback to update the TOTP code. */
  setTotpToken: (val: string) => void;
  /** Current 30-digit recovery key input. */
  recoveryKey: string;
  /** Callback to update the recovery key. */
  setRecoveryKey: (val: string) => void;
  /** Whether TOTP / recovery key form submission is in progress. */
  loading: boolean;
  /** Callback to return to Step 1. */
  onBackToStep1: () => void;
  /** Form submission handler for Step 2. */
  onSubmit: (e: React.FormEvent) => void;
  /** Callback to cancel and close the modal. */
  onClose: () => void;
}

/**
 * ForgotPasswordMfaStep renders Step 2 of password recovery.
 * Coordinates multi-factor authentication verification across Passkey, TOTP, and Recovery Keys.
 *
 * @param props - Component props.
 * @returns React component representing Step 2.
 */
export const ForgotPasswordMfaStep: React.FC<ForgotPasswordMfaStepProps> = ({
  initData,
  username,
  mfaMode,
  setMfaMode,
  passkeyLoading,
  onPasskeyVerify,
  totpToken,
  setTotpToken,
  recoveryKey,
  setRecoveryKey,
  loading,
  onBackToStep1,
  onSubmit,
  onClose
}) => {
  const { t } = useTranslation();

  if (!initData.can_reset) {
    return (
      <Callout intent={Intent.WARNING} icon="warning-sign" className="rounded-xl">
        <p className="text-sm font-medium">
          {t(
            "auth.noMfaContactAdmin",
            "This account has no multi-factor authentication (MFA) or recovery keys configured and cannot be self-reset. Please contact your administrator to reset your password."
          )}
        </p>
        <div className="mt-4 flex justify-end">
          <Button
            intent={Intent.NONE}
            text={t("common.close", "Close")}
            onClick={onClose}
          />
        </div>
      </Callout>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBackToStep1}
          className="text-xs text-blue-600 hover:underline flex items-center gap-1 bg-transparent border-none cursor-pointer p-0"
        >
          <ArrowLeft size={14} />
          <span>{username}</span>
        </button>
        <span className="text-xs text-gray-400">
          {t("auth.verifyIdentity", "Verify Identity")}
        </span>
      </div>

      <p className="text-sm text-gray-500">
        {t(
          "auth.chooseMfaForReset",
          "Authenticate using one of your configured MFA methods to verify your identity."
        )}
      </p>

      {/* Passkey option */}
      {initData.has_passkey && (
        <Button
          fill
          size="large"
          intent={Intent.PRIMARY}
          type="button"
          loading={passkeyLoading}
          disabled={loading}
          onClick={onPasskeyVerify}
          className="font-semibold py-4 rounded-xl shadow-sm flex items-center justify-center space-x-2"
        >
          <Key size={18} className="inline mr-1.5" />
          <span>{t("auth.verifyWithPasskey", "Verify with Passkey")}</span>
        </Button>
      )}

      {(initData.has_totp || initData.has_recovery_keys) && initData.has_passkey && (
        <div className="relative flex py-1 items-center">
          <div className="flex-grow border-t border-gray-200 dark:border-gray-700" />
          <span className="flex-shrink mx-3 text-gray-400 text-xs">
            {t("auth.orUseOtherMfa", "or use another method")}
          </span>
          <div className="flex-grow border-t border-gray-200 dark:border-gray-700" />
        </div>
      )}

      {/* TOTP / Recovery Key Form */}
      {(initData.has_totp || initData.has_recovery_keys) && (
        <form onSubmit={onSubmit} className="space-y-4">
          {mfaMode === "totp" && initData.has_totp && (
            <FormGroup label={t("auth.totpVerification", "Two-Factor Code (TOTP)")}>
              <DigitInput
                length={6}
                value={totpToken}
                onChange={setTotpToken}
                disabled={loading || passkeyLoading}
                autoFocus={!initData.has_passkey}
              />
            </FormGroup>
          )}

          {mfaMode === "recovery" && initData.has_recovery_keys && (
            <FormGroup
              label={t("account.totp.recoveryKeysTitle", "Recovery Key")}
              helperText={t(
                "auth.recoveryPrompt",
                "请输入 30 位应急恢复密钥（5 组，每组 6 位数字）"
              )}
            >
              <div className="pt-2">
                <RecoveryKeyInput
                  value={recoveryKey}
                  onChange={setRecoveryKey}
                  disabled={loading || passkeyLoading}
                  autoFocus
                />
              </div>
            </FormGroup>
          )}

          <div className="flex justify-between items-center text-xs">
            {initData.has_totp && initData.has_recovery_keys && (
              <button
                type="button"
                onClick={() =>
                  setMfaMode(mfaMode === "totp" ? "recovery" : "totp")
                }
                className="text-blue-600 hover:underline bg-transparent border-none cursor-pointer p-0"
              >
                {mfaMode === "totp"
                  ? t("auth.totpUseRecovery", "Use Recovery Key")
                  : t("auth.totpUseApp", "Use Authenticator App")}
              </button>
            )}
          </div>

          <Button
            fill
            size="large"
            intent={initData.has_passkey ? Intent.NONE : Intent.PRIMARY}
            type="submit"
            loading={loading}
            disabled={passkeyLoading}
            className="rounded-xl font-semibold"
          >
            {t("auth.verifyIdentity", "Verify Identity")}
          </Button>
        </form>
      )}
    </div>
  );
};
