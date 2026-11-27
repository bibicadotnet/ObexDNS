import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock, Eye, EyeOff, Loader2, ShieldCheck, User } from "lucide-react";

export interface SignupPasswordStepProps {
  username: string;
  setUsername: (val: string) => void;
  checkUsernameDuplicate: (uname: string) => void;
  onClearError: () => void;
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
  username,
  setUsername,
  checkUsernameDuplicate,
  onClearError,
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

  // Username validation checks
  const hasValidLength = username.length >= 5 && username.length <= 32;
  const hasValidStart = /^[a-z_]/.test(username);
  const hasValidChars = username.length > 0 && /^[a-z0-9_-]+$/.test(username);
  const isUsernameValid = hasValidLength && hasValidStart && hasValidChars;

  // Password validation checks (12-100 characters per system security policy)
  const hasLength = password.length >= 12 && password.length <= 100;
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const isPasswordValid = hasLength && hasLetter && hasNumber;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {/* Username field */}
      <div>
        <label
          htmlFor="username"
          className="block text-xs font-semibold uppercase tracking-wider text-gray-700 mb-1.5"
        >
          {t("auth.username", "Username")}
        </label>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400">
            <User className="w-4 h-4" />
          </div>
          <input
            id="username"
            name="username"
            autoComplete="username"
            type="text"
            placeholder={t("auth.usernamePlaceholder", "Your username")}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              onClearError();
            }}
            onBlur={() => {
              if (username.trim()) {
                checkUsernameDuplicate(username.trim());
              }
            }}
            autoFocus
            required
            className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-gray-300 rounded-xl text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600 transition-all font-medium"
          />
        </div>

        {/* Real-time Username Format Check */}
        <div className="mt-2.5 grid grid-cols-3 gap-1.5 text-[11px] font-medium">
          <div className={`flex items-center gap-1 ${hasValidLength ? "text-emerald-600" : "text-gray-400"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${hasValidLength ? "bg-emerald-500" : "bg-gray-300"}`} />
            <span>{t("auth.rule5To32Chars", "5-32 characters")}</span>
          </div>
          <div className={`flex items-center gap-1 ${hasValidStart ? "text-emerald-600" : "text-gray-400"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${hasValidStart ? "bg-emerald-500" : "bg-gray-300"}`} />
            <span>{t("auth.ruleStartLetter", "Starts with a-z, _")}</span>
          </div>
          <div className={`flex items-center gap-1 ${hasValidChars ? "text-emerald-600" : "text-gray-400"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${hasValidChars ? "bg-emerald-500" : "bg-gray-300"}`} />
            <span>{t("auth.ruleValidChars", "Lowercase, -, _")}</span>
          </div>
        </div>
      </div>

      {/* Password field */}
      <div>
        <label
          htmlFor="password"
          className="block text-xs font-semibold uppercase tracking-wider text-gray-700 mb-1.5"
        >
          {t("auth.password", "Password")}
        </label>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400">
            <Lock className="w-4 h-4" />
          </div>
          <input
            id="password"
            name="password"
            autoComplete="new-password"
            type={showPassword ? "text" : "password"}
            placeholder={t("auth.passwordPlaceholder", "Your password")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onFocus={() => setPasswordFocused(true)}
            onBlur={() => setPasswordFocused(false)}
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
            <span>{t("auth.rule12To100Chars", "12-100 characters")}</span>
          </div>
          <div className={`flex items-center gap-1 ${hasLetter ? "text-emerald-600" : "text-gray-400"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${hasLetter ? "bg-emerald-500" : "bg-gray-300"}`} />
            <span>{t("auth.ruleHasLetters", "Contains letters")}</span>
          </div>
          <div className={`flex items-center gap-1 ${hasNumber ? "text-emerald-600" : "text-gray-400"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${hasNumber ? "bg-emerald-500" : "bg-gray-300"}`} />
            <span>{t("auth.ruleHasNumbers", "Contains numbers")}</span>
          </div>
        </div>
      </div>

      {isTurnstileEnabled && (
        <div
          ref={turnstileRef}
          className={`flex items-start justify-center transition-all duration-300 ${
            hasVisibleWidget ? "opacity-100 min-h-[65px] my-3" : "opacity-0 h-0 overflow-hidden"
          }`}
        />
      )}

      <button
        type="submit"
        disabled={loading || !isUsernameValid || !isPasswordValid || (isTurnstileEnabled && turnstileStatus !== "success")}
        className="w-full mt-2 py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold shadow-xs hover:shadow-sm transition-all flex items-center justify-center gap-2 cursor-pointer"
      >
        {loading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{t("common.loading", "Loading...")}</span>
          </>
        ) : (
          <>
            <ShieldCheck className="w-4 h-4" />
            <span>{t("auth.signupBtn", "Sign Up")}</span>
          </>
        )}
      </button>
    </form>
  );
};
