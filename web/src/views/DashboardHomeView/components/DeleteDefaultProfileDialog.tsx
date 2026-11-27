import React, { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X, Trash2 } from "lucide-react";
import type { Profile } from "../../../types/auth";

export interface DeleteProfileDialogProps {
  profileToDelete: Profile | null;
  otherProfiles: Profile[];
  initialReplacementId: string;
  onConfirm: (replacementId?: string) => Promise<void> | void;
  onCancel: () => void;
}

export const DeleteDefaultProfileDialog: React.FC<DeleteProfileDialogProps> = ({
  profileToDelete,
  otherProfiles,
  initialReplacementId,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState(initialReplacementId || otherProfiles[0]?.id || "");
  const [loading, setLoading] = useState(false);

  if (!profileToDelete) return null;

  const isDefault = Boolean(profileToDelete.is_default);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm(isDefault ? selectedId : undefined);
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in duration-150"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-[#d0d7de] p-6 overflow-hidden animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`p-2.5 rounded-xl border shrink-0 ${
                isDefault
                  ? "bg-amber-50 text-amber-600 border-amber-200"
                  : "bg-red-50 text-red-600 border-red-200"
              }`}
            >
              {isDefault ? (
                <AlertTriangle className="w-5 h-5" />
              ) : (
                <Trash2 className="w-5 h-5" />
              )}
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-bold text-gray-900 m-0 truncate">
                {isDefault
                  ? t("common.deleteDefaultProfileTitle", "Delete Default Profile")
                  : t("common.deleteProfileTitle", "Delete Profile")}
              </h3>
              <p className="text-xs text-gray-500 mt-0.5 truncate font-medium">
                {profileToDelete.name}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="p-1 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Description or Replacement Selection */}
        {isDefault ? (
          otherProfiles.length > 0 ? (
            <>
              <p className="text-xs sm:text-sm text-gray-600 mb-4 leading-relaxed m-0">
                {t("common.deleteDefaultProfileDesc", {
                  name: profileToDelete.name,
                  defaultValue: `Profile "${profileToDelete.name}" is set as default. Please select a replacement default profile before deleting:`,
                })}
              </p>
              <div className="my-4">
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  {t("common.selectReplacementProfile", "Select replacement default profile")}
                </label>
                <select
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                  disabled={loading}
                  className="w-full px-3.5 py-2 text-sm bg-white border border-[#d0d7de] rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-[#0969da] transition-all font-medium cursor-pointer"
                >
                  {otherProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <p className="text-xs sm:text-sm text-red-600 mb-4 leading-relaxed m-0">
              {t("common.cannotDeleteOnlyProfile", "Cannot delete the only profile in the system.")}
            </p>
          )
        ) : (
          <p className="text-xs sm:text-sm text-gray-600 mb-6 leading-relaxed m-0">
            {t("common.confirmDeleteProfileDesc", {
              name: profileToDelete.name,
              defaultValue: `Are you sure you want to delete profile "${profileToDelete.name}"? All settings, custom rules, and logs will be permanently deleted and cannot be recovered.`,
            })}
          </p>
        )}

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-2.5 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 rounded-lg border border-[#d0d7de] bg-white hover:bg-gray-50 text-gray-700 text-xs sm:text-sm font-semibold shadow-xs hover:border-gray-400 transition-all cursor-pointer disabled:opacity-50"
          >
            {t("common.cancel", "Cancel")}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading || (isDefault && otherProfiles.length === 0)}
            className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-xs sm:text-sm font-semibold shadow-xs transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            <span>{loading ? t("common.deleting", "Deleting...") : t("common.delete", "Delete")}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export { DeleteDefaultProfileDialog as DeleteProfileDialog };
