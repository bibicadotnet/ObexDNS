import React from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, AlertCircle, Lock } from "lucide-react";
import { SignupUsernameStep } from "./signup/SignupUsernameStep";
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
    usernameFocused,
    setUsernameFocused,
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
    handleSignupUsernameSubmit,
    handleSignupTotpConfirm,
    handleCopySignupRecoveryKeys,
    handleSignupSubmit,
  } = useSignupWizard({ authConfig, turnstileReady, onSuccess });

  if (authConfig && authConfig.has_users !== false && authConfig.registration_enabled === false) {
    return (
      <div className="space-y-4 text-center py-4">
        <div className="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto">
          <Lock className="w-6 h-6" />
        </div>
        <div>
          <h3 className="text-base font-bold text-gray-900 m-0">
            {t("auth.registrationDisabledTitle", "Đăng ký tạm đóng")}
          </h3>
          <p className="text-xs text-gray-500 mt-1.5 leading-relaxed max-w-xs mx-auto">
            {t("auth.registrationDisabledDesc", "Hệ thống hiện không mở đăng ký tự do. Vui lòng liên hệ quản trị viên để được cấp tài khoản.")}
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleMode}
          className="inline-flex items-center gap-1.5 text-xs text-blue-600 font-semibold hover:underline cursor-pointer pt-2"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>{t("auth.backToLogin", "Quay lại đăng nhập")}</span>
        </button>
      </div>
    );
  }

  const getStepTitle = (): string => {
    if (signupStep === "username" || signupStep === "password") {
      return authConfig?.has_users === false
        ? t("auth.registerAdminTitle", "Đăng ký Quản trị viên")
        : t("auth.signup", "Tạo tài khoản mới");
    }
    if (signupStep === "totp") {
      return t("auth.mfaSetupTitle", "Bảo mật hai bước (MFA)");
    }
    return t("account.totp.recoveryKeysTitle", "Lưu khóa khôi phục");
  };

  const getStepSubtitle = (): string => {
    if (signupStep === "password") return username;
    if (signupStep === "username") {
      return authConfig?.has_users === false
        ? t("auth.registerAdminDesc", "Hệ thống chưa có tài khoản. Tài khoản đầu tiên đăng ký sẽ trở thành Quản trị viên cao nhất.")
        : t("auth.protectInternet", "Bảo vệ truy cập internet an toàn cho bạn");
    }
    if (signupStep === "totp") {
      return t("auth.mfaSetupDesc", "Bảo vệ tài khoản bằng Passkey hoặc ứng dụng Google Authenticator.");
    }
    return t("account.totp.recoveryKeysWarning", "Lưu giữ cẩn thận để khôi phục tài khoản khi mất thiết bị.");
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
              title="Quay lại nhập tên"
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

      {/* Step 1: Username */}
      {signupStep === "username" && (
        <SignupUsernameStep
          username={username}
          setUsername={setUsername}
          usernameFocused={usernameFocused}
          setUsernameFocused={setUsernameFocused}
          checkUsernameDuplicate={checkUsernameDuplicate}
          loading={loading}
          onSubmit={handleSignupUsernameSubmit}
          onClearError={() => setError("")}
        />
      )}

      {/* Step 2: Password */}
      {signupStep === "password" && (
        <SignupPasswordStep
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
