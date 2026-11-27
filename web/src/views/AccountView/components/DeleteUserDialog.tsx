import React, { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Trash2, X, AlertTriangle } from "lucide-react";
import type { UserInfo } from "../../../services";
import { CompactDateTime } from "../../../components/CompactDateTime";

export interface DeleteUserDialogProps {
  userToDelete: UserInfo | null;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

export const DeleteUserDialog: React.FC<DeleteUserDialogProps> = ({
  userToDelete,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);

  if (!userToDelete) return null;

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm();
    } finally {
      setLoading(false);
    }
  };

  const getMfaText = () => {
    if (userToDelete.totp_enabled) return "TOTP";
    if (userToDelete.passkeys_count && userToDelete.passkeys_count > 0) return "Passkey";
    return t("account.mfaNone", "None");
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in duration-150"
      onClick={() => !loading && onCancel()}
    >
      <div
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-[#d0d7de] p-6 overflow-hidden animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2.5 rounded-xl border shrink-0 bg-red-50 text-red-600 border-red-200">
              <Trash2 className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-bold text-gray-900 m-0 truncate">
                {t("account.deleteUserTitle", "Delete User Account")}
              </h3>
              <p className="text-xs text-gray-500 mt-0.5 truncate font-medium">
                {userToDelete.username}
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

        {/* User Details */}
        <div className="my-4 p-3.5 bg-gray-50 border border-gray-200 rounded-xl space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-gray-500 font-medium">{t("account.username", "Username")}:</span>
            <span className="font-bold text-gray-900">{userToDelete.username}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500 font-medium">{t("account.role", "Role")}:</span>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
                userToDelete.role === "admin"
                  ? "bg-red-100 text-red-700 border border-red-200"
                  : "bg-gray-200 text-gray-700"
              }`}
            >
              {userToDelete.role === "admin"
                ? t("account.roleAdmin", "Administrator")
                : t("account.roleUser", "User")}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500 font-medium">ID:</span>
            <code className="font-mono bg-white px-1.5 py-0.5 rounded border border-gray-200 text-gray-700 select-all">
              {userToDelete.id}
            </code>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500 font-medium">MFA:</span>
            <span className="text-gray-700 font-medium">{getMfaText()}</span>
          </div>
          {userToDelete.created_at && (
            <div className="flex items-center justify-between">
              <span className="text-gray-500 font-medium">{t("account.createdAt", "Created At")}:</span>
              <span className="text-gray-700">
                <CompactDateTime timestamp={userToDelete.created_at} />
              </span>
            </div>
          )}
          {userToDelete.last_active_at && (
            <div className="flex items-center justify-between">
              <span className="text-gray-500 font-medium">{t("account.lastActive", "Last Active")}:</span>
              <span className="text-gray-700">
                <CompactDateTime timestamp={userToDelete.last_active_at} />
              </span>
            </div>
          )}
        </div>

        {/* Warning Callout */}
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl mb-5 flex items-start gap-2.5 text-xs text-red-700 leading-relaxed">
          <AlertTriangle className="w-4 h-4 shrink-0 text-red-600 mt-0.5" />
          <span>
            {t("account.deleteUserWarning", "Are you sure you want to delete this user account? All profiles, access points, filter rules, and query logs belonging to this user will be permanently deleted and cannot be recovered."
            )}
          </span>
        </div>

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
            disabled={loading}
            className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-xs sm:text-sm font-semibold shadow-xs transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            <span>{loading ? t("common.deleting", "Deleting...") : t("account.deleteUserBtn", "Delete Account")}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
