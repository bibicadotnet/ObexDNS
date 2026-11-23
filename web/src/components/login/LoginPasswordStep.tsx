import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock, Eye, EyeOff, Loader2, KeyRound } from "lucide-react";

export interface LoginPasswordStepProps {
  password: string;
  setPassword: (val: string) => void;
  hasMfa: boolean;
  onSwitchToMfa?: () => void;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => void;
  keepLoggedIn: boolean;
  setKeepLoggedIn: (val: boolean) => void;
  optionalSessionExpirationDays: number;
}

export const LoginPasswordStep: React.FC<LoginPasswordStepProps> = ({
  password,
  setPassword,
  hasMfa,
  onSwitchToMfa,
  loading,
  onSubmit,
  keepLoggedIn,
  setKeepLoggedIn,
  optionalSessionExpirationDays,
}) => {
  const [showPassword, setShowPassword] = useState(false);
  const { t } = useTranslation();

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="password"
          className="block text-xs font-semibold uppercase tracking-wider text-gray-700 mb-1.5"
        >
          {t("auth.password", "Mật khẩu")}
        </label>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400">
            <Lock className="w-4 h-4" />
          </div>
          <input
            id="password"
            type={showPassword ? "text" : "password"}
            placeholder={t("auth.passwordPlaceholder", "Nhập mật khẩu")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
            className="w-full pl-10 pr-10 py-2.5 text-sm bg-white border border-gray-300 rounded-xl text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600 transition-all font-medium"
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-gray-400 hover:text-gray-600 cursor-pointer"
            tabIndex={-1}
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>

      <div className="flex items-center">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={keepLoggedIn}
            onChange={(e) => setKeepLoggedIn(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
          />
          <span className="text-xs text-gray-600 font-medium">
            {t("auth.keepLoggedIn", "Duy trì đăng nhập trong {{days}} ngày", {
              days: optionalSessionExpirationDays,
            })}
          </span>
        </label>
      </div>

      <div className="pt-2 space-y-2.5">
        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold shadow-xs hover:shadow-sm transition-all flex items-center justify-center gap-2 cursor-pointer"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>{t("common.loading", "Đang đăng nhập...")}</span>
            </>
          ) : (
            <span>{t("auth.loginBtn", "Đăng nhập")}</span>
          )}
        </button>

        {hasMfa && onSwitchToMfa && (
          <button
            type="button"
            onClick={onSwitchToMfa}
            className="w-full py-2 px-4 rounded-xl border border-gray-200 hover:bg-gray-50 text-gray-700 text-xs font-semibold transition-all flex items-center justify-center gap-2 cursor-pointer"
          >
            <KeyRound className="w-3.5 h-3.5 text-blue-600" />
            <span>{t("auth.otherOptions", "Đăng nhập bằng Passkey / Mã xác thực")}</span>
          </button>
        )}
      </div>
    </form>
  );
};
