import React from "react";
import { useTranslation } from "react-i18next";
import { User, ArrowRight, Loader2 } from "lucide-react";

export interface LoginUsernameStepProps {
  username: string;
  setUsername: (val: string) => void;
  isTurnstileEnabled: boolean | undefined;
  turnstileRef: React.RefObject<HTMLDivElement | null>;
  hasVisibleWidget?: boolean;
  loading: boolean;
  turnstileStatus: "idle" | "verifying" | "success" | "error";
  onSubmit: (e: React.FormEvent) => void;
}

export const LoginUsernameStep: React.FC<LoginUsernameStepProps> = ({
  username,
  setUsername,
  isTurnstileEnabled,
  turnstileRef,
  hasVisibleWidget,
  loading,
  turnstileStatus,
  onSubmit,
}) => {
  const { t } = useTranslation();

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
            onChange={(e) => setUsername(e.target.value)}
            required
            className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-gray-300 rounded-xl text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600 transition-all font-medium"
          />
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
        disabled={loading || (isTurnstileEnabled && turnstileStatus !== "success")}
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
