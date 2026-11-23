import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Plus, AlertCircle, Info } from "lucide-react";
import { PROFILE_NAME_REGEX } from "../../../utils/auth";

interface CreateProfileCardProps {
  newName: string;
  setNewName: (name: string) => void;
  onCreate: () => void;
  setShowCreate: (show: boolean) => void;
  error: string;
}

export const CreateProfileCard: React.FC<CreateProfileCardProps> = ({
  newName,
  setNewName,
  onCreate,
  setShowCreate,
  error,
}) => {
  const { t } = useTranslation();
  const [nameFocused, setNameFocused] = useState(false);

  const getErrorMessage = (err: string) => {
    if (!err) return "";
    if (err.startsWith("Profile limit exceeded")) {
      const match = err.match(/\(max (\d+)\)/);
      const maxVal = match ? match[1] : "10";
      return t("common.profileLimitExceeded", { max: maxVal, defaultValue: `Vượt quá giới hạn Profile (tối đa ${maxVal})` });
    }
    if (err === "The profile name already exists") {
      return t("common.profileNameExists", "Tên profile đã tồn tại");
    }
    if (err === "Invalid Profile Name format") {
      return t("common.profileNameFormatError", "Định dạng tên profile không hợp lệ");
    }
    return err;
  };

  const isValid = PROFILE_NAME_REGEX.test(newName);

  return (
    <div className="mb-6 p-5 rounded-2xl bg-white border border-blue-200/80 shadow-sm transition-all">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-gray-900 m-0">
          {t("common.createProfile", "Tạo Profile mới")}
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
            placeholder={t("common.newProfileName", "Ví dụ: Nhà riêng, Điện thoại, Công ty...")}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onFocus={() => setNameFocused(true)}
            onBlur={() => setNameFocused(false)}
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
          <span>{t("common.create", "Tạo Profile")}</span>
        </button>
      </div>

      {nameFocused && (
        <div className="mt-2.5 flex items-center gap-1.5 text-xs text-gray-500 font-medium">
          <Info className="w-3.5 h-3.5 text-blue-500 shrink-0" />
          <span>{t("common.profileNameFormatTip", "Tên dài từ 1 - 30 ký tự, không được trùng lặp")}</span>
        </div>
      )}

      {error && (
        <div className="mt-2.5 p-2.5 rounded-lg bg-red-50 border border-red-200 flex items-center gap-2 text-xs text-red-700 font-medium">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          <span>{getErrorMessage(error)}</span>
        </div>
      )}
    </div>
  );
};
