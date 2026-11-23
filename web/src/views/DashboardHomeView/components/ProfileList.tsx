import React, { useState } from "react";
import { ChevronRight, Trash2, ShieldCheck, Edit2, Check, X, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Profile } from "../../../types/auth";
import { renameProfile } from "../../../services";
import { executeWithTimeout } from "../../../utils/async";
import { PROFILE_NAME_REGEX } from "../../../utils/auth";

interface ProfileListProps {
  profiles: Profile[];
  onSelect: (p: Profile) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  onRefresh?: () => void;
}

export const ProfileList: React.FC<ProfileListProps> = ({
  profiles,
  onSelect,
  onDelete,
  onRefresh,
}) => {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [renameLoading, setRenameLoading] = useState(false);

  const handleStartEdit = (e: React.MouseEvent, p: Profile) => {
    e.stopPropagation();
    setEditingId(p.id);
    setEditName(p.name);
  };

  const handleCancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(null);
  };

  const handleSaveRename = async (
    e: React.MouseEvent | React.KeyboardEvent,
    id: string
  ) => {
    e.stopPropagation();
    const trimmed = editName.trim();
    if (!trimmed || !PROFILE_NAME_REGEX.test(trimmed)) {
      return;
    }
    const currentProfile = profiles.find((p) => p.id === id);
    if (currentProfile && currentProfile.name === trimmed) {
      setEditingId(null);
      return;
    }

    setRenameLoading(true);
    try {
      await executeWithTimeout(renameProfile(id, trimmed), 10000);
      setEditingId(null);
      onRefresh?.();
    } catch (err: any) {
      console.error(err);
      alert(err.message || t("common.saveFailed", "Lưu thất bại"));
    } finally {
      setRenameLoading(false);
    }
  };

  if (profiles.length === 0) {
    return (
      <div className="text-center py-16 px-4 bg-white rounded-2xl border border-[#d0d7de] shadow-xs">
        <div className="w-16 h-16 rounded-2xl bg-blue-50 text-[#0969da] flex items-center justify-center mx-auto mb-4">
          <ShieldCheck className="w-8 h-8" />
        </div>
        <h3 className="text-lg font-bold text-[#111827] m-0">
          {t("common.welcome", "Chào mừng bạn đến với DNS Shield")}
        </h3>
        <p className="text-sm text-gray-600 mt-2 max-w-sm mx-auto leading-relaxed">
          {t("common.createProfileToStart", "Hãy tạo Profile DNS đầu tiên để bắt đầu thiết lập bộ lọc và bảo vệ thiết bị của bạn.")}
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
      {profiles.map((p: Profile) => {
        const profileKey = (p as any).key || p.id;
        const isEditing = editingId === p.id;

        return (
          <div
            key={p.id}
            onClick={() => {
              if (!isEditing) onSelect(p);
            }}
            className="flex items-center justify-between p-4 rounded-xl border border-[#d0d7de] bg-white hover:border-gray-400 hover:bg-gray-50/50 shadow-xs transition-colors cursor-pointer group"
          >
            {isEditing ? (
              <div
                className="flex items-center gap-1.5 flex-1 min-w-0 pr-3"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  autoFocus
                  disabled={renameLoading}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveRename(e, p.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  className="px-2.5 py-1 text-sm font-semibold rounded-lg border border-[#0969da] bg-white text-[#111827] outline-none focus:ring-2 focus:ring-blue-100 w-full max-w-[220px] shadow-2xs"
                />
                <button
                  type="button"
                  disabled={renameLoading || !PROFILE_NAME_REGEX.test(editName)}
                  onClick={(e) => handleSaveRename(e, p.id)}
                  className="p-1.5 rounded-lg bg-emerald-50 text-emerald-600 hover:bg-emerald-100 border border-emerald-200 transition-colors cursor-pointer shrink-0 disabled:opacity-40"
                  title={t("common.save", "Save")}
                >
                  {renameLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Check className="w-3.5 h-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  disabled={renameLoading}
                  onClick={handleCancelEdit}
                  className="p-1.5 rounded-lg bg-gray-50 text-gray-500 hover:bg-gray-100 border border-gray-200 transition-colors cursor-pointer shrink-0"
                  title={t("common.cancel", "Cancel")}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="min-w-0 pr-3 flex-1">
                <div
                  className="inline-flex items-center gap-2 group/edit cursor-pointer min-w-0 max-w-full"
                  onClick={(e) => handleStartEdit(e, p)}
                  title={t("common.rename", "Đổi tên")}
                >
                  <h3 className="text-base font-bold text-[#111827] truncate m-0">
                    {p.name}
                  </h3>
                  <span className="p-1 rounded-md text-gray-400 opacity-0 group-hover:opacity-100 group-hover/edit:text-[#0969da] group-hover/edit:bg-blue-50 transition-all shrink-0">
                    <Edit2 className="w-3.5 h-3.5" />
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="text-[11px] font-mono text-gray-500 bg-gray-50 px-2 py-0.5 rounded border border-[#d0d7de]">
                    {profileKey}
                  </span>
                </div>
              </div>
            )}

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(e, p.id);
                }}
                className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                title={t("common.delete", "Xóa")}
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <ChevronRight className="w-4 h-4 text-gray-400" />
            </div>
          </div>
        );
      })}
    </div>
  );
};
