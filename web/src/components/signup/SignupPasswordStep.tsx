import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock, Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";

export interface SignupPasswordStepProps {
  password: string;
  setPassword: (val: string) => void;
  passwordFocused: boolean;
  setPasswordFocused: (focused: boolean) => void;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => void;
  isTurnstileEnabled: boolean | undefined;
  turnstileRef: React.RefObject<HTMLDivElement | null>;
  hasVisibleWidget?: boolean;
  turnstileStatus: "idle" | "verifying" | "success" | "error";
}

export const SignupPasswordStep: React.FC<SignupPasswordStepProps> = ({
  password,
  setPassword,
  passwordFocused: _passwordFocused,
  setPasswordFocused,
  loading,
  onSubmit,
  isTurnstileEnabled,
  turnstileRef,
  hasVisibleWidget,
  turnstileStatus,
}) => {
  const [showPassword, setShowPassword] = useState(false);
  const { t } = useTranslation();

  const hasLength = password.length >= 8;
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);

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
            placeholder={t("auth.passwordPlaceholder", "Nhập mật khẩu an toàn")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onFocus={() => setPasswordFocused(true)}
            onBlur={() => setPasswordFocused(false)}
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

        {/* Real-time Password Strength Check */}
        <div className="mt-2.5 grid grid-cols-3 gap-1.5 text-[11px] font-medium">
          <div className={`flex items-center gap-1 ${hasLength ? "text-emerald-600" : "text-gray-400"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${hasLength ? "bg-emerald-500" : "bg-gray-300"}`} />
            <span>Tối thiểu 8 ký tự</span>
          </div>
          <div className={`flex items-center gap-1 ${hasLetter ? "text-emerald-600" : "text-gray-400"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${hasLetter ? "bg-emerald-500" : "bg-gray-300"}`} />
            <span>Chứa chữ cái</span>
          </div>
          <div className={`flex items-center gap-1 ${hasNumber ? "text-emerald-600" : "text-gray-400"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${hasNumber ? "bg-emerald-500" : "bg-gray-300"}`} />
            <span>Chứa số</span>
          </div>
        </div>
      </div>

      {isTurnstileEnabled && (
        <div
          ref={turnstileRef}
          className={`flex justify-center transition-all duration-300 ${
            hasVisibleWidget ? "opacity-100 min-h-[65px] my-3" : "opacity-0 h-0 overflow-hidden"
          }`}
        />
      )}

      <button
        type="submit"
        disabled={loading || !hasLength || (isTurnstileEnabled && turnstileStatus !== "success")}
        className="w-full mt-2 py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold shadow-xs hover:shadow-sm transition-all flex items-center justify-center gap-2 cursor-pointer"
      >
        {loading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{t("common.loading", "Đang tạo tài khoản...")}</span>
          </>
        ) : (
          <>
            <ShieldCheck className="w-4 h-4" />
            <span>{t("auth.signupBtn", "Hoàn tất đăng ký")}</span>
          </>
        )}
      </button>
    </form>
  );
};
