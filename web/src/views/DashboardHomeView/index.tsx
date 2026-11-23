import { useEffect } from "react";
import { Plus, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useIsMobile } from "../../hooks/useIsMobile";
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
  navigate,
  onRefresh,
  currentUser,
}: DashboardHomeProps) => {
  const isMobile = useIsMobile();
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
    <div className="min-h-screen bg-[#f8fafc] text-gray-900 flex flex-col font-sans antialiased">
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept=".json"
        onChange={handleFileChange}
      />

      {/* Top Navbar */}
      <Navbar
        isMobile={isMobile}
        navigate={navigate}
        handleLogout={handleLogout}
        currentUser={currentUser}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        {/* Page Header with Action Buttons */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900 m-0">
              {t("common.selectProfile", "Danh sách Profile DNS")}
            </h1>
            <p className="text-xs sm:text-sm text-gray-500 mt-1 font-medium">
              {t("common.selectProfileSubtitle", "Quản lý các cấu hình chặn quảng cáo và bảo vệ mạng cho từng thiết bị")}
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleImportClick}
              disabled={importing}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[#d0d7de] bg-white hover:bg-gray-50 text-gray-700 text-xs sm:text-sm font-semibold shadow-xs hover:border-gray-400 transition-all cursor-pointer disabled:opacity-50"
            >
              <Download className="w-4 h-4 text-gray-500" />
              <span>{t("common.import", "Nhập cấu hình")}</span>
            </button>

            <button
              type="button"
              onClick={() => setShowCreate(true)}
              disabled={showCreate}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0969da] hover:bg-[#0854ad] active:bg-[#074794] text-white text-xs sm:text-sm font-semibold shadow-xs hover:shadow-sm transition-all cursor-pointer disabled:opacity-40"
            >
              <Plus className="w-4 h-4" />
              <span>{t("common.add", "Thêm Profile")}</span>
            </button>
          </div>
        </div>

        {/* Create Profile Card Dropdown/Area */}
        {showCreate && (
          <CreateProfileCard
            newName={newName}
            setNewName={setNewName}
            onCreate={onCreate}
            setShowCreate={setShowCreate}
            error={error}
          />
        )}

        {/* Profile Cards Grid */}
        <ProfileList
          profiles={profiles}
          onSelect={onSelect}
          onDelete={onDelete}
          onRefresh={onRefresh}
        />
      </main>
    </div>
  );
};
