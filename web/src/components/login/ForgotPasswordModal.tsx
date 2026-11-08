import React from "react";
import { Dialog, Intent, Callout } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import {
  useForgotPasswordForm,
  type AuthConfig
} from "./useForgotPasswordForm";
import { ForgotPasswordUsernameStep } from "./ForgotPasswordUsernameStep";
import { ForgotPasswordMfaStep } from "./ForgotPasswordMfaStep";
import { ForgotPasswordNewPasswordStep } from "./ForgotPasswordNewPasswordStep";
import { ForgotPasswordSuccessStep } from "./ForgotPasswordSuccessStep";

export type { AuthConfig };

/**
 * Props for the ForgotPasswordModal component.
 */
export interface ForgotPasswordModalProps {
  /** Whether the modal dialog is currently open. */
  isOpen: boolean;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Optional initial username to prefill in Step 1. */
  initialUsername?: string;
  /** Auth configuration containing Turnstile parameters. */
  authConfig: AuthConfig | null;
  /** Whether Turnstile is initialized and ready in window. */
  turnstileReady: boolean;
  /** Callback invoked upon successful password reset. */
  onSuccess: (username: string) => void;
}

/**
 * ForgotPasswordModal orchestrates the multi-step self-service password recovery flow:
 * - Step 1: Input username and solve bot verification (Turnstile)
 * - Step 2: Authenticate via MFA (Passkey, TOTP, or Recovery Key)
 * - Step 3: Set and confirm new password
 * - Step 4: Display reset success screen and redirect to login
 *
 * Adheres to the Single Responsibility Principle (SRP) by delegating state management
 * to useForgotPasswordForm and presentation to discrete step components.
 *
 * @param props - Modal properties.
 * @returns React modal dialog element.
 */
export const ForgotPasswordModal: React.FC<ForgotPasswordModalProps> = ({
  isOpen,
  onClose,
  initialUsername = "",
  authConfig,
  turnstileReady,
  onSuccess
}) => {
  const { t } = useTranslation();

  const {
    step,
    username,
    setUsername,
    loading,
    error,
    isTurnstileEnabled,
    turnstileRef,
    turnstileToken,
    turnstileStatus,
    initData,
    mfaMode,
    setMfaMode,
    totpToken,
    setTotpToken,
    recoveryKey,
    setRecoveryKey,
    passkeyLoading,
    newPassword,
    setNewPassword,
    confirmPassword,
    setConfirmPassword,
    showPassword,
    setShowPassword,
    handleStep1Submit,
    handlePasskeyVerify,
    handleMfaSubmit,
    handleStep3Submit,
    handleBackToStep1
  } = useForgotPasswordForm({
    isOpen,
    initialUsername,
    authConfig,
    turnstileReady,
    onSuccess
  });

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t("auth.forgotPasswordTitle", "Reset Password")}
      className="max-w-md w-full rounded-2xl"
    >
      <div className="p-6 space-y-4">
        {error && (
          <Callout intent={Intent.DANGER} className="rounded-xl">
            {error}
          </Callout>
        )}

        {/* ─── Step 1: Input Username ─── */}
        {step === 1 && (
          <ForgotPasswordUsernameStep
            username={username}
            setUsername={setUsername}
            isTurnstileEnabled={isTurnstileEnabled}
            turnstileRef={turnstileRef}
            turnstileStatus={turnstileStatus}
            turnstileToken={turnstileToken}
            loading={loading}
            onSubmit={handleStep1Submit}
            onCancel={onClose}
          />
        )}

        {/* ─── Step 2: MFA Verification ─── */}
        {step === 2 && initData && (
          <ForgotPasswordMfaStep
            initData={initData}
            username={username}
            mfaMode={mfaMode}
            setMfaMode={setMfaMode}
            passkeyLoading={passkeyLoading}
            onPasskeyVerify={handlePasskeyVerify}
            totpToken={totpToken}
            setTotpToken={setTotpToken}
            recoveryKey={recoveryKey}
            setRecoveryKey={setRecoveryKey}
            loading={loading}
            onBackToStep1={handleBackToStep1}
            onSubmit={handleMfaSubmit}
            onClose={onClose}
          />
        )}

        {/* ─── Step 3: Set New Password ─── */}
        {step === 3 && (
          <ForgotPasswordNewPasswordStep
            newPassword={newPassword}
            setNewPassword={setNewPassword}
            confirmPassword={confirmPassword}
            setConfirmPassword={setConfirmPassword}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            loading={loading}
            onSubmit={handleStep3Submit}
            onCancel={onClose}
          />
        )}

        {/* ─── Step 4: Success ─── */}
        {step === 4 && (
          <ForgotPasswordSuccessStep
            username={username}
            onClose={onClose}
            onSuccess={onSuccess}
          />
        )}
      </div>
    </Dialog>
  );
};
