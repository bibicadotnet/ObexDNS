import React from "react";
import { useTranslation } from "react-i18next";
import { X, Plus, AlertCircle } from "lucide-react";
import { PROFILE_NAME_REGEX } from "../../../utils/auth";

interface CreateProfileCardProps {
  newName: string;
  setNewName: (name: string) => void;
  newIsDefault: boolean;
  setNewIsDefault: (isDefault: boolean) => void;
  newApplyDefaultFilters: boolean;
  setNewApplyDefaultFilters: (apply: boolean) => void;
  onCreate: () => void;
  setShowCreate: (show: boolean) => void;
  error: string;
  isFirstProfile?: boolean;
}

export const CreateProfileCard: React.FC<CreateProfileCardProps> = ({
  newName,
  setNewName,
  newIsDefault,
  setNewIsDefault,
  newApplyDefaultFilters,
  setNewApplyDefaultFilters,
  onCreate,
  setShowCreate,
  error,
  isFirstProfile = false,
}) => {
  const { t } = useTranslation();

  const getErrorMessage = (err: string) => {
    if (!err) return "";
    if (err.startsWith("Profile limit exceeded")) {
      const match = err.match(/\(max (\d+)\)/);
      const maxVal = match ? match[1] : "10";
      return t("common.profileLimitExceeded", { max: maxVal, defaultValue: `Profile limit reached (maximum ${maxVal})` });
    }
    if (err === "The profile name already exists") {
      return t("common.profileNameExists", "The profile name already exists");
    }
    if (err === "Invalid Profile Name format") {
      return t("common.profileNameFormatError", "Invalid Profile Name format");
    }
    return err;
  };

  const trimmed = newName.trim();
  const hasValidLength = trimmed.length >= 1 && trimmed.length <= 30;
  const hasValidChars = trimmed.length > 0 && PROFILE_NAME_REGEX.test(trimmed);
  const isValid = hasValidLength && hasValidChars;

  return (
    <div className="mb-6 p-5 rounded-2xl bg-white border border-blue-200/80 shadow-sm transition-all">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-gray-900 m-0">
          {t("common.createProfile", "Create New Profile")}
        </h3>
        <button
          type="button"
          onClick={() => setShowCreate(false)}
          className="p-1 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex flex-col sm:flex-row items-center gap-2.5">
        <div className="w-full flex-1">
          <input
            type="text"
            placeholder={t("common.newProfileName", "New Profile Name...")}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && isValid) {
                e.preventDefault();
                onCreate();
              }
            }}
            autoFocus
            className="w-full px-3.5 py-2 text-sm bg-gray-50 border border-[#d0d7de] rounded-lg text-gray-900 placeholder:text-gray-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-[#0969da] transition-all font-medium"
          />
        </div>

        <button
          type="button"
          onClick={onCreate}
          disabled={!isValid}
          className="w-full sm:w-auto px-5 py-2 rounded-lg bg-[#0969da] hover:bg-[#0854ad] active:bg-[#074794] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs sm:text-sm font-semibold shadow-xs transition-all flex items-center justify-center gap-1.5 shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t("common.create", "Create")}</span>
        </button>
      </div>

      {/* Real-time Profile Name Format Check */}
      <div className="mt-2.5 flex items-center gap-1.5 text-[11px] font-medium">
        <div className={`flex items-center gap-1 ${hasValidLength ? "text-emerald-600" : "text-gray-400"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${hasValidLength ? "bg-emerald-500" : "bg-gray-300"}`} />
          <span>{t("common.rule1To30Chars", "1 - 30 characters")}</span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isFirstProfile || newIsDefault}
            disabled={isFirstProfile}
            onChange={(e) => setNewIsDefault(e.target.checked)}
            className="rounded text-blue-600 focus:ring-blue-500 w-3.5 h-3.5 cursor-pointer disabled:opacity-50"
          />
          <span>{t("common.setAsDefault", "Set as default")}</span>
        </label>

        <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={newApplyDefaultFilters}
            onChange={(e) => setNewApplyDefaultFilters(e.target.checked)}
            className="rounded text-blue-600 focus:ring-blue-500 w-3.5 h-3.5 cursor-pointer"
          />
          <span>{t("common.applyDefaultFilters", "Apply default filters")}</span>
        </label>

        {isFirstProfile && (
          <span className="text-[11px] text-gray-400 italic ml-auto">
            ({t("common.firstProfileDefaultNote", "First profile will always be default")})
          </span>
        )}
      </div>

      {error && (
        <div className="mt-2.5 p-2.5 rounded-lg bg-red-50 border border-red-200 flex items-center gap-2 text-xs text-red-700 font-medium">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          <span>{getErrorMessage(error)}</span>
        </div>
      )}
    </div>
  );
};
