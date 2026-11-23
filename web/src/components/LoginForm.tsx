import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Copy, Check, ShieldAlert, AlertCircle, Info } from "lucide-react";
import { LoginUsernameStep } from "./login/LoginUsernameStep";
import { LoginPasswordStep } from "./login/LoginPasswordStep";
import { LoginMfaStep } from "./login/LoginMfaStep";
import { useLoginForm } from "./login/useLoginForm";

interface AuthConfig {
  turnstile_site_key: string;
  turnstile_enabled_signup: boolean;
  turnstile_enabled_login: boolean;
  optional_session_expiration_days?: number;
  has_users?: boolean;
  registration_enabled?: boolean;
}

interface LoginFormProps {
  authConfig: AuthConfig | null;
  turnstileReady: boolean;
  onSuccess: () => void;
  onToggleMode: () => void;
}

export const LoginForm: React.FC<LoginFormProps> = ({
  authConfig,
  turnstileReady,
  onSuccess,
  onToggleMode,
}) => {
  const { t } = useTranslation();

  const {
    loginStep,
    username,
    setUsername,
    password,
    setPassword,
    totpToken,
    setTotpToken,
    recoveryKey,
    setRecoveryKey,
    requiresTotp,
    hasPasskey,
    mfaMethod,
    setMfaMethod,
    passkeyLoading,
    loading,
    error,
    setError,
    turnstileStatus,
    turnstileRef,
    hasVisibleWidget,
    isTurnstileEnabled,
    keepLoggedIn,
    setKeepLoggedIn,
    handleStep1Submit,
    handleStep2Submit,
    handleStep3Submit,
    handleSwitchToMfa,
    handlePasskeyLogin,
    handleBack,
    rotatedRecoveryKey,
    handleAcknowledgeRotatedKey,
  } = useLoginForm({ authConfig, turnstileReady, onSuccess });

  const [copiedRotatedKey, setCopiedRotatedKey] = useState(false);

  const handleCopyRotatedKey = (k: string) => {
    navigator.clipboard.writeText(k);
    setCopiedRotatedKey(true);
    setTimeout(() => setCopiedRotatedKey(false), 2000);
  };

  const getStepTitle = (): string => {
    switch (loginStep) {
      case 1:
        return t("auth.login", "Đăng nhập");
      case 2:
        return t("auth.password", "Nhập mật khẩu");
      case 3:
        return t("auth.mfaVerification", "Xác thực hai bước (MFA)");
      default:
        return t("auth.login", "Đăng nhập");
    }
  };

  return (
    <>
      <div className="mb-6 relative">
        <div className="flex items-center gap-2">
          {loginStep !== 1 && (
            <button
              type="button"
              onClick={handleBack}
              className="p-1 -ml-1 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
              title={t("common.back", "Quay lại")}
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <div>
            <h2 className="text-xl font-bold tracking-tight text-gray-900 m-0">
              {getStepTitle()}
            </h2>
            <p className="text-xs text-gray-500 mt-1 font-medium">
              {loginStep === 1
                ? t("auth.protectInternet", "Bảo vệ truy cập internet an toàn cho bạn")
                : username}
            </p>
          </div>
        </div>
      </div>

      {authConfig?.has_users === false && (
        <div className="mb-5 p-3.5 rounded-xl bg-blue-50/80 border border-blue-200/70 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-blue-900">
          <div className="flex items-center gap-2 font-medium">
            <Info className="w-4 h-4 text-blue-600 shrink-0" />
            <span>{t("auth.noUsersRegistered", "Hệ thống chưa có tài khoản. Đăng ký làm quản trị viên.")}</span>
          </div>
          <button
            type="button"
            onClick={onToggleMode}
            className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-all shrink-0 cursor-pointer shadow-xs"
          >
            {t("auth.goToRegisterAdmin", "Đăng ký quản trị")}
          </button>
        </div>
      )}

      {error && (
        <div className="mb-5 p-3 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2.5 text-xs text-red-800">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <div className="font-medium leading-relaxed">{error}</div>
        </div>
      )}

      {/* Step 1: Username & Turnstile */}
      {loginStep === 1 && (
        <LoginUsernameStep
          username={username}
          setUsername={setUsername}
          isTurnstileEnabled={isTurnstileEnabled}
          turnstileRef={turnstileRef}
          hasVisibleWidget={hasVisibleWidget}
          loading={loading}
          turnstileStatus={turnstileStatus}
          onSubmit={handleStep1Submit}
        />
      )}

      {/* Step 2: Password (if required) */}
      {loginStep === 2 && (
        <LoginPasswordStep
          password={password}
          setPassword={setPassword}
          hasMfa={hasPasskey || requiresTotp}
          onSwitchToMfa={handleSwitchToMfa}
          loading={loading}
          onSubmit={handleStep2Submit}
          keepLoggedIn={keepLoggedIn}
          setKeepLoggedIn={setKeepLoggedIn}
          optionalSessionExpirationDays={
            authConfig?.optional_session_expiration_days ?? 7
          }
        />
      )}

      {/* Step 3: MFA (Passkey prioritized, or TOTP / Recovery Key) */}
      {loginStep === 3 && (
        <LoginMfaStep
          hasPasskey={hasPasskey}
          requiresTotp={requiresTotp}
          mfaMethod={mfaMethod}
          setMfaMethod={setMfaMethod}
          passkeyLoading={passkeyLoading}
          onPasskeyLogin={handlePasskeyLogin}
          totpToken={totpToken}
          setTotpToken={setTotpToken}
          recoveryKey={recoveryKey}
          setRecoveryKey={setRecoveryKey}
          loading={loading}
          onClearError={() => setError("")}
          onSubmit={handleStep3Submit}
          keepLoggedIn={keepLoggedIn}
          setKeepLoggedIn={setKeepLoggedIn}
          optionalSessionExpirationDays={
            authConfig?.optional_session_expiration_days ?? 7
          }
        />
      )}

      {/* Rotated Recovery Key Modal */}
      {rotatedRecoveryKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-gray-200 space-y-4">
            <div className="flex items-center gap-2.5 text-amber-600 font-semibold text-base">
              <ShieldAlert className="w-5 h-5 shrink-0" />
              <span>{t("account.recoveryKey.autoRotatedTitle", "Khóa khôi phục đã được tự động làm mới")}</span>
            </div>

            <p className="text-xs text-gray-600 leading-relaxed">
              {t(
                "account.recoveryKey.autoRotatedNotice",
                "Theo quy tắc sử dụng một lần, khóa cũ đã hết hiệu lực. Hãy sao lưu khóa khôi phục 30 ký tự mới này an toàn ngay lập tức!"
              )}
            </p>

            <div className="p-3 bg-gray-100 rounded-xl border border-gray-200 font-mono text-center text-base font-bold tracking-wider select-all text-gray-900">
              {rotatedRecoveryKey}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleCopyRotatedKey(rotatedRecoveryKey)}
                className="flex-1 py-2 px-3 rounded-xl border border-gray-200 hover:bg-gray-50 text-gray-700 text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer"
              >
                {copiedRotatedKey ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                <span>{copiedRotatedKey ? t("common.copied", "Đã sao chép") : t("common.copyKey", "Sao chép khóa")}</span>
              </button>

              <button
                type="button"
                onClick={handleAcknowledgeRotatedKey}
                className="flex-1 py-2 px-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-all cursor-pointer"
              >
                {t("account.recoveryKey.savedAndContinue", "Đã lưu & Tiếp tục")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
