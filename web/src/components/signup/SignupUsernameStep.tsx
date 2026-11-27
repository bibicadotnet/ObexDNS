import React from "react";
import { useTranslation } from "react-i18next";
import { User, ArrowRight, Loader2 } from "lucide-react";

export interface SignupUsernameStepProps {
  username: string;
  setUsername: (val: string) => void;
  usernameFocused?: boolean;
  setUsernameFocused?: (focused: boolean) => void;
  checkUsernameDuplicate: (uname: string) => void;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onClearError: () => void;
}

export const SignupUsernameStep: React.FC<SignupUsernameStepProps> = ({
  username,
  setUsername,
  checkUsernameDuplicate,
  loading,
  onSubmit,
  onClearError,
}) => {
  const { t } = useTranslation();

  const hasValidLength = username.length >= 5 && username.length <= 32;
  const hasValidStart = /^[a-z_]/.test(username);
  const hasValidChars = username.length > 0 && /^[a-z0-9_-]+$/.test(username);
  const isValid = hasValidLength && hasValidStart && hasValidChars;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
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
            <span>{t("auth.ruleValidChars", "Lowercase, 0-9, -, _")}</span>
          </div>
        </div>
      </div>

      <button
        type="submit"
        disabled={loading || !isValid}
        className="w-full mt-2 py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold shadow-xs hover:shadow-sm transition-all flex items-center justify-center gap-2 cursor-pointer"
      >
        {loading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{t("common.loading", "Loading...")}</span>
          </>
        ) : (
          <>
            <span>{t("auth.next", "Next")}</span>
            <ArrowRight className="w-4 h-4" />
          </>
        )}
      </button>
    </form>
  );
};
