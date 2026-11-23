import React from "react";
import { useTranslation } from "react-i18next";
import { User, ArrowRight, Loader2, Info } from "lucide-react";

export interface SignupUsernameStepProps {
  username: string;
  setUsername: (val: string) => void;
  usernameFocused: boolean;
  setUsernameFocused: (focused: boolean) => void;
  checkUsernameDuplicate: (uname: string) => void;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onClearError: () => void;
}

export const SignupUsernameStep: React.FC<SignupUsernameStepProps> = ({
  username,
  setUsername,
  usernameFocused,
  setUsernameFocused,
  checkUsernameDuplicate,
  loading,
  onSubmit,
  onClearError,
}) => {
  const { t } = useTranslation();

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label
            htmlFor="username"
            className="block text-xs font-semibold uppercase tracking-wider text-gray-700"
          >
            {t("auth.username", "Tên đăng nhập")}
          </label>
          <span className="text-[11px] text-gray-400 font-medium">3-20 ký tự</span>
        </div>

        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400">
            <User className="w-4 h-4" />
          </div>
          <input
            id="username"
            type="text"
            placeholder={t("auth.usernamePlaceholder", "Nhập tên đăng nhập muốn tạo")}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              onClearError();
            }}
            onFocus={() => setUsernameFocused(true)}
            onBlur={() => {
              setUsernameFocused(false);
              if (username.trim()) {
                checkUsernameDuplicate(username.trim());
              }
            }}
            autoFocus
            required
            className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-gray-300 rounded-xl text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600 transition-all font-medium"
          />
        </div>

        {usernameFocused && (
          <div className="mt-2 p-2.5 rounded-lg bg-blue-50/70 border border-blue-100 flex items-start gap-2 text-xs text-blue-700">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{t("auth.formatTipUsername", "Tên đăng nhập chỉ gồm chữ cái thường, số và dấu gạch dưới.")}</span>
          </div>
        )}
      </div>

      <button
        type="submit"
        disabled={loading || !username.trim()}
        className="w-full mt-2 py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold shadow-xs hover:shadow-sm transition-all flex items-center justify-center gap-2 cursor-pointer"
      >
        {loading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{t("common.loading", "Đang kiểm tra...")}</span>
          </>
        ) : (
          <>
            <span>{t("auth.next", "Tiếp tục")}</span>
            <ArrowRight className="w-4 h-4" />
          </>
        )}
      </button>
    </form>
  );
};
