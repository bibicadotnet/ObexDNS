import { useEffect } from "react";
import { Button, Intent } from "@blueprintjs/core";
import { Plus, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { preloadHeavyViews, preloadMainViews } from "../../routes/ProfileRoutes";
import type { Profile, UserInfo } from "../../types/auth";
import { useImportProfile } from "./hooks";
import { Navbar } from "./components/Navbar";
import { CreateProfileCard } from "./components/CreateProfileCard";
import { ProfileList } from "./components/ProfileList";

interface DashboardHomeProps {
  profiles: Profile[];
  onSelect: (p: Profile) => void;
  onCreate: () => void;
  showCreate: boolean;
  setShowCreate: (show: boolean) => void;
  newName: string;
  setNewName: (name: string) => void;
  error: string;
  onDelete: (e: React.MouseEvent, id: string) => void;
  handleLogout: () => void;
  navigate: (path: string) => void;
  onRefresh?: () => void;
  currentUser?: UserInfo | null;
}

export const DashboardHomeView = ({
  profiles,
  onSelect,
  onCreate,
  showCreate,
  setShowCreate,
  newName,
  setNewName,
  error,
  onDelete,
  handleLogout,
  onRefresh,
  currentUser,
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
    <div className="min-h-app flex flex-col bg-(--canvas)">
      <input type="file" ref={fileInputRef} className="hidden" accept=".json" onChange={handleFileChange} />

      <Navbar handleLogout={handleLogout} currentUser={currentUser} />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-12 pt-6 md:px-6 md:pt-10">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h1 className="page-title">{t("common.yourProfiles", "Your profiles")}</h1>
            <p className="page-subtitle">{t("common.selectProfile")}</p>
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Button
              icon={<Download size={16} />}
              onClick={handleImportClick}
              text={t("common.import")}
              loading={importing}
              className="flex-1 sm:flex-none"
            />
            <Button
              intent={Intent.PRIMARY}
              icon={<Plus size={18} />}
              onClick={() => setShowCreate(true)}
              text={t("common.newProfile", "New profile")}
              disabled={showCreate}
              className="flex-1 sm:flex-none"
            />
          </div>
        </div>

        {showCreate && (
          <CreateProfileCard
            newName={newName}
            setNewName={setNewName}
            onCreate={onCreate}
            setShowCreate={setShowCreate}
            error={error}
          />
        )}

        <ProfileList
          profiles={profiles}
          onSelect={onSelect}
          onDelete={onDelete}
          onCreate={() => setShowCreate(true)}
        />
      </main>
    </div>
  );
};
