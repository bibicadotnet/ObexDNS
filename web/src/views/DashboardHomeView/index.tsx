import { useEffect } from "react";
import { Plus, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { preloadHeavyViews, preloadMainViews } from "../../routes/ProfileRoutes";
import type { Profile, UserInfo } from "../../types/auth";
import { useImportProfile } from "./hooks";
import { PageHeader } from "../../components/PageHeader";
import { CreateProfileCard } from "./components/CreateProfileCard";
import { ProfileList } from "./components/ProfileList";
import { DeleteDefaultProfileDialog } from "./components/DeleteDefaultProfileDialog";
import type { OverlayToaster } from "@blueprintjs/core";
import React from "react";

interface DashboardHomeProps {
  profiles: Profile[];
  onSelect: (p: Profile) => void;
  onCreate: () => void;
  showCreate: boolean;
  setShowCreate: (show: boolean) => void;
  newName: string;
  setNewName: (name: string) => void;
  newIsDefault?: boolean;
  setNewIsDefault?: (isDefault: boolean) => void;
  newApplyDefaultFilters?: boolean;
  setNewApplyDefaultFilters?: (apply: boolean) => void;
  error: string;
  onDelete: (e: React.MouseEvent, id: string) => void;
  handleLogout?: () => void;
  navigate: (path: string) => void;
  onRefresh?: () => void;
  currentUser?: UserInfo | null;
  deletingProfile?: Profile | null;
  onConfirmDeleteDefault?: (newDefaultId?: string) => void;
  onCancelDeleteDefault?: () => void;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

export const DashboardHomeView = ({
  profiles,
  onSelect,
  onCreate,
  showCreate,
  setShowCreate,
  newName,
  setNewName,
  newIsDefault = false,
  setNewIsDefault,
  newApplyDefaultFilters = true,
  setNewApplyDefaultFilters,
  error,
  onDelete,
  onRefresh,
  deletingProfile,
  onConfirmDeleteDefault,
  onCancelDeleteDefault,
  toasterRef,
}: DashboardHomeProps) => {
  const { t } = useTranslation();

  const {
    fileInputRef,
    importing,
    handleImportClick,
    handleFileChange,
  } = useImportProfile(onRefresh);

  useEffect(() => {
    preloadMainViews();
    const timer = setTimeout(preloadHeavyViews, 2000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="w-full min-w-0 max-w-5xl mx-auto px-1 md:px-8 space-y-6 pb-24">
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept=".json"
        onChange={handleFileChange}
      />

      <PageHeader
        title={t("common.selectProfile", "Select Profile")}
        subtitle={t("common.selectProfileSubtitle", "Manage ad-blocking and network protection profiles for your devices")}
        actions={
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleImportClick}
              disabled={importing}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[#d0d7de] bg-white hover:bg-gray-50 text-gray-700 text-xs sm:text-sm font-semibold shadow-xs hover:border-gray-400 transition-all cursor-pointer disabled:opacity-50"
            >
              <Download className="w-4 h-4 text-gray-500" />
              <span>{t("common.import", "Import")}</span>
            </button>

            <button
              type="button"
              onClick={() => setShowCreate(true)}
              disabled={showCreate}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0969da] hover:bg-[#0854ad] active:bg-[#074794] text-white text-xs sm:text-sm font-semibold shadow-xs hover:shadow-sm transition-all cursor-pointer disabled:opacity-40"
            >
              <Plus className="w-4 h-4" />
              <span>{t("common.add", "Add")}</span>
            </button>
          </div>
        }
      />

      {/* Create Profile Card Dropdown/Area */}
      {showCreate && (
        <CreateProfileCard
          newName={newName}
          setNewName={setNewName}
          newIsDefault={newIsDefault}
          setNewIsDefault={setNewIsDefault || (() => {})}
          newApplyDefaultFilters={newApplyDefaultFilters}
          setNewApplyDefaultFilters={setNewApplyDefaultFilters || (() => {})}
          onCreate={onCreate}
          setShowCreate={setShowCreate}
          error={error}
          isFirstProfile={profiles.length === 0}
        />
      )}

      {/* Profile Cards Grid */}
      <ProfileList
        profiles={profiles}
        onSelect={onSelect}
        onDelete={onDelete}
        onRefresh={onRefresh}
        toasterRef={toasterRef}
      />

      {/* Delete Default Profile Dialog */}
      {deletingProfile && onConfirmDeleteDefault && onCancelDeleteDefault && (
        <DeleteDefaultProfileDialog
          profileToDelete={deletingProfile}
          otherProfiles={profiles.filter((p) => p.id !== deletingProfile.id)}
          initialReplacementId={profiles.find((p) => p.id !== deletingProfile.id)?.id || ""}
          onConfirm={onConfirmDeleteDefault}
          onCancel={onCancelDeleteDefault}
        />
      )}
    </div>
  );
};
