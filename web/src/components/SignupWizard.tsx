import React from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, AlertCircle, Lock } from "lucide-react";
import { SignupPasswordStep } from "./signup/SignupPasswordStep";
import { SignupMfaStep } from "./signup/SignupMfaStep";
import { SignupRecoveryStep } from "./signup/SignupRecoveryStep";
import { useSignupWizard } from "./signup/useSignupWizard";

interface AuthConfig {
  turnstile_site_key: string;
  turnstile_enabled_signup: boolean;
  turnstile_enabled_login: boolean;
  optional_session_expiration_days?: number;
  has_users?: boolean;
  registration_enabled?: boolean;
}

interface SignupWizardProps {
  authConfig: AuthConfig | null;
  turnstileReady: boolean;
  onSuccess: () => void;
  onToggleMode: () => void;
}

export const SignupWizard: React.FC<SignupWizardProps> = ({
  authConfig,
  turnstileReady,
  onSuccess,
  onToggleMode,
}) => {
  const { t } = useTranslation();

  const {
    signupStep,
    setSignupStep,
    username,
    setUsername,
    password,
    setPassword,
    mfaChoice,
    setMfaChoice,
    passkeyRegLoading,
    passkeyRegError,
    handleRegisterPasskey,
    handleChooseTotp,
    totpSetupToken,
    setTotpSetupToken,
    totpSetupData,
    totpRecoveryKeys,
    loading,
    error,
    setError,
    passwordFocused,
    setPasswordFocused,
    copiedRecovery,
    totpSetupLoading,
    totpSetupError,
    turnstileStatus,
    turnstileRef,
    hasVisibleWidget,
    isTurnstileEnabled,
    checkUsernameDuplicate,
    handleSignupTotpConfirm,
    handleCopySignupRecoveryKeys,
    handleSignupSubmit,
  } = useSignupWizard({ authConfig, turnstileReady, onSuccess });

  if (authConfig && authConfig.has_users !== false && authConfig.registration_enabled === false) {
    return (
      <div className="space-y-4 text-center py-6 px-2">
        <div className="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto border border-amber-200/60 shadow-xs">
          <Lock className="w-6 h-6" />
        </div>
        <div>
          <h3 className="text-base font-bold text-gray-900 m-0">
            {t("auth.registrationDisabledTitle", "Registration Disabled")}
          </h3>
          <p className="text-xs text-gray-500 mt-2 leading-relaxed max-w-xs mx-auto">
            {t("auth.registrationDisabledDesc", "New user registration is currently closed. Please contact a system administrator to obtain an account.")}
          </p>
        </div>
        <div className="pt-2">
          <button
            type="button"
            onClick={onToggleMode}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-semibold transition-all cursor-pointer shadow-xs"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>{t("auth.backToLogin", "Back to login")}</span>
          </button>
        </div>
      </div>
    );
  }

  const getStepTitle = (): string => {
    if (signupStep === "username" || signupStep === "password") {
      return authConfig?.has_users === false
        ? t("auth.registerAdminTitle", "Register Administrator Account")
        : t("auth.signup", "Create an account to start");
    }
    if (signupStep === "totp") {
      return t("auth.mfaSetupTitle", "Enhance Account Security");
    }
    return t("account.totp.recoveryKeysTitle", "Save Your Recovery Keys");
  };

  const getStepSubtitle = (): string => {
    if (signupStep === "password") return username;
    if (signupStep === "username") {
      return authConfig?.has_users === false
        ? t("auth.registerAdminDesc", "No accounts in the system. The first user will become the system administrator.")
        : t("auth.protectInternet", "Protect your first hop on the internet");
    }
    if (signupStep === "totp") {
      return t("auth.mfaSetupDesc", "Configuring Multi-Factor Authentication (MFA) safeguards your account, unlocks passwordless login, and enables self-service password recovery.");
    }
    return t("account.totp.recoveryKeysWarning", "Store your recovery key safely (e.g., in a password manager). Each key can only be used once.");
  };

  return (
    <>
      <div className="mb-6 relative">
        <div className="flex items-center gap-2">
          {signupStep === "password" && (
            <button
              type="button"
              onClick={() => {
                setSignupStep("username");
                setError("");
              }}
              className="p-1 -ml-1 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
              title={t("auth.backToUsername", "Back to username")}
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <div>
            <h2 className="text-xl font-bold tracking-tight text-gray-900 m-0">
              {getStepTitle()}
            </h2>
            <p className="text-xs text-gray-500 mt-1 font-medium leading-relaxed">
              {getStepSubtitle()}
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-5 p-3 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2.5 text-xs text-red-800">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <div className="font-medium leading-relaxed">{error}</div>
        </div>
      )}

      {/* Step 1: Account Credentials (Username + Password together) */}
      {(signupStep === "username" || signupStep === "password") && (
        <SignupPasswordStep
          username={username}
          setUsername={setUsername}
          checkUsernameDuplicate={checkUsernameDuplicate}
          onClearError={() => setError("")}
          password={password}
          setPassword={setPassword}
          passwordFocused={passwordFocused}
          setPasswordFocused={setPasswordFocused}
          loading={loading}
          onSubmit={handleSignupSubmit}
          isTurnstileEnabled={isTurnstileEnabled}
          turnstileRef={turnstileRef}
          hasVisibleWidget={hasVisibleWidget}
          turnstileStatus={turnstileStatus}
        />
      )}

      {/* Step 3: MFA Setup */}
      {signupStep === "totp" && (
        <SignupMfaStep
          mfaChoice={mfaChoice}
          setMfaChoice={setMfaChoice}
          passkeyRegLoading={passkeyRegLoading}
          passkeyRegError={passkeyRegError}
          onRegisterPasskey={handleRegisterPasskey}
          onStartTotp={handleChooseTotp}
          totpSetupLoading={totpSetupLoading}
          totpSetupError={totpSetupError}
          totpSetupData={totpSetupData}
          totpSetupToken={totpSetupToken}
          setTotpSetupToken={setTotpSetupToken}
          onTotpSubmit={handleSignupTotpConfirm}
          onSkip={onSuccess}
        />
      )}

      {/* Step 4: Recovery Keys */}
      {signupStep === "recovery" && (
        <SignupRecoveryStep
          totpRecoveryKeys={totpRecoveryKeys || []}
          copiedRecovery={copiedRecovery}
          onCopy={handleCopySignupRecoveryKeys}
          onSuccess={onSuccess}
        />
      )}
    </>
  );
};
