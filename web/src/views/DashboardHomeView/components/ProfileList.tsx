import React, { useState } from "react";
import { ChevronRight, Trash2, ShieldCheck, Edit2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatApiErrorMessage } from "../../../utils/auth";
import type { Profile } from "../../../types/auth";
import { renameProfile } from "../../../services";
import { executeWithTimeout } from "../../../utils/async";
import { RenameProfileDialog } from "./RenameProfileDialog";
import { Intent, type OverlayToaster } from "@blueprintjs/core";

interface ProfileListProps {
  profiles: Profile[];
  onSelect: (p: Profile) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  onRefresh?: () => Promise<void> | void;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

export const ProfileList: React.FC<ProfileListProps> = ({
  profiles,
  onSelect,
  onDelete,
  onRefresh,
  toasterRef,
}) => {
  const { t } = useTranslation();
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [editName, setEditName] = useState("");
  const [editIsDefault, setEditIsDefault] = useState(false);
  const [renameLoading, setRenameLoading] = useState(false);

  const handleOpenRename = (e: React.MouseEvent, p: Profile) => {
    e.stopPropagation();
    setEditingProfile(p);
    setEditName(p.name);
    setEditIsDefault(Boolean(p.is_default));
  };

  const handleCloseRename = () => {
    if (renameLoading) return;
    setEditingProfile(null);
  };

  const handleSaveRename = async () => {
    if (!editingProfile) return;
    const trimmed = editName.trim();
    if (!trimmed) return;

    const isDefaultChanged = Boolean(editingProfile.is_default) !== editIsDefault;
    if (editingProfile.name === trimmed && !isDefaultChanged) {
      setEditingProfile(null);
      return;
    }

    setRenameLoading(true);
    try {
      await executeWithTimeout(renameProfile(editingProfile.id, trimmed, editIsDefault), 10000);
      setEditingProfile(null);
      if (onRefresh) {
        await onRefresh();
      }
    } catch (err: any) {
      console.error(err);
      toasterRef?.current?.show({
        message: formatApiErrorMessage(err, t),
        intent: Intent.DANGER,
        icon: "error",
      });
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
          {t("common.welcome", "Welcome")}
        </h3>
        <p className="text-sm text-gray-600 mt-2 max-w-sm mx-auto leading-relaxed">
          {t("common.createProfileToStart", "Create a profile to get started.")}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        {profiles.map((p: Profile) => {
          const profileKey = (p as any).key || p.id;

          return (
            <div
              key={p.id}
              onClick={() => onSelect(p)}
              className="flex items-center justify-between p-4 rounded-xl border border-[#d0d7de] bg-white hover:border-gray-400 hover:bg-gray-50/50 shadow-xs transition-colors cursor-pointer group"
            >
              <div className="min-w-0 pr-3 flex-1">
                <div className="flex items-center gap-2 min-w-0 max-w-full">
                  <span className="text-sm font-semibold text-gray-900 truncate">
                    {p.name}
                  </span>
                  {p.is_default && (
                    <span className="text-[11px] font-medium text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-200 shrink-0">
                      {t("common.default", "Default")}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="text-[11px] font-mono text-gray-500 bg-gray-50 px-2 py-0.5 rounded border border-[#d0d7de]">
                    {profileKey}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  onClick={(e) => handleOpenRename(e, p)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-[#0969da] hover:bg-blue-50 transition-colors cursor-pointer"
                  title={t("common.rename", "Rename")}
                  aria-label={t("common.rename", "Rename")}
                >
                  <Edit2 className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={(e) => onDelete(e, p.id)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                  title={t("common.delete", "Delete")}
                  aria-label={t("common.delete", "Delete")}
                >
                  <Trash2 className="w-4 h-4" />
                </button>

                <ChevronRight className="w-4 h-4 text-gray-400 group-hover:text-gray-600 transition-colors" />
              </div>
            </div>
          );
        })}
      </div>

      <RenameProfileDialog
        isOpen={Boolean(editingProfile)}
        onClose={handleCloseRename}
        profile={editingProfile}
        name={editName}
        setName={setEditName}
        isDefault={editIsDefault}
        setIsDefault={setEditIsDefault}
        onSave={handleSaveRename}
        loading={renameLoading}
        canToggleDefault={!(editingProfile?.is_default && profiles.length === 1)}
      />
    </>
  );
};
