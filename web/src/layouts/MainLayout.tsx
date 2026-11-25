import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Edit3,
  BarChart3,
  Clock,
  Download,
  ListFilter,
} from "lucide-react";
import { useParams } from "react-router-dom";
import { useIsMobile } from "../hooks/useIsMobile";
import type { Profile, UserInfo } from "../types/auth";
import { DesktopSidebar } from "./DesktopSidebar";
import { HeaderNavbar } from "./HeaderNavbar";
import { MobileBottomNav } from "./MobileBottomNav";

interface MainLayoutProps {
  children: React.ReactNode;
  isSidebarOpen: boolean;
  setIsSidebarOpen: (open: boolean) => void;
  theme: "light" | "dark" | "system";
  setTheme: (theme: "light" | "dark" | "system") => void;
  selectedProfile: Profile | null;
  profiles: Profile[];
  setSelectedProfile: (p: Profile) => void;
  location: any;
  navigate: (path: string) => void;
  handleLogout: () => void;
  currentUser: UserInfo | null;
  isSaving?: boolean | "saving" | "verifying";
}

export const MainLayout = ({
  children,
  isSidebarOpen,
  setIsSidebarOpen,
  theme,
  setTheme,
  selectedProfile,
  profiles,
  setSelectedProfile,
  location,
  navigate,
  handleLogout,
  currentUser,
  isSaving,
}: MainLayoutProps) => {
  const { profileId: urlProfileId } = useParams();
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const defaultProfile = profiles.find((p: Profile) => p.is_default) || profiles[0];
  const activeId = urlProfileId || selectedProfile?.id || defaultProfile?.id;
  const isProfileActive = !!activeId;

  useEffect(() => {
    if (
      urlProfileId &&
      profiles.length > 0 &&
      selectedProfile?.id !== urlProfileId
    ) {
      const found = profiles.find((p: Profile) => p.id === urlProfileId);
      if (found) {
        setSelectedProfile(found);
        localStorage.setItem("obex_active_profile_id", found.id);
      }
    } else if (!urlProfileId && defaultProfile) {
      if (!selectedProfile || !profiles.some(p => p.id === selectedProfile.id)) {
        const storedId = localStorage.getItem("obex_active_profile_id");
        const found = storedId ? profiles.find(p => p.id === storedId) : null;
        const target = found || defaultProfile;
        setSelectedProfile(target);
        localStorage.setItem("obex_active_profile_id", target.id);
      }
    }
  }, [urlProfileId, profiles, selectedProfile, setSelectedProfile, defaultProfile]);

  const navItems = [
    {
      id: "setup",
      label: t("nav.setup"),
      icon: <Download size={20} />,
      path: `/dash/${activeId}/setup`,
    },
    {
      id: "rules",
      label: isMobile && location.pathname.includes("/filter") ? t("nav.filter") : t("nav.rules"),
      icon: isMobile && location.pathname.includes("/filter") ? <ListFilter size={20} /> : <Edit3 size={20} />,
      path: isMobile && location.pathname.includes("/filter")
        ? `/dash/${activeId}/filter`
        : `/dash/${activeId}/rules`,
    },
    {
      id: "stats",
      label: t("nav.stats"),
      icon: <BarChart3 size={20} />,
      path: `/dash/${activeId}/stats`,
    },
    {
      id: "logs",
      label: t("nav.logs"),
      icon: <Clock size={20} />,
      path: `/dash/${activeId}/logs`,
    },
  ];

  return (
    <div className="flex h-screen w-full bg-[#f8fafc] overflow-hidden flex-col md:flex-row">
      {!isMobile && (
        <DesktopSidebar
          isSidebarOpen={isSidebarOpen}
          setIsSidebarOpen={setIsSidebarOpen}
          isProfileActive={isProfileActive}
          activeId={activeId}
          location={location}
          navigate={navigate}
          handleLogout={handleLogout}
          currentUser={currentUser}
          navItems={navItems}
        />
      )}

      <main className="flex-1 min-w-0 h-full relative bg-[#f8fafc] flex flex-col overflow-hidden">
        <HeaderNavbar
          theme={theme}
          setTheme={setTheme}
          selectedProfile={selectedProfile}
          profiles={profiles}
          setSelectedProfile={setSelectedProfile}
          isProfileActive={isProfileActive}
          location={location}
          navigate={navigate}
          isSaving={isSaving}
          currentUser={currentUser}
          handleLogout={handleLogout}
        />

        <div className="flex-1 min-h-0 flex flex-col relative z-0 isolate" style={{ isolation: "isolate" }}>
          <div className="flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]">
            <div className="p-3 md:p-6 pb-24 md:pb-8 min-w-0">{children}</div>
          </div>
        </div>

        {isMobile && (
          <MobileBottomNav
            isProfileActive={isProfileActive}
            navItems={navItems}
            location={location}
            navigate={navigate}
            activeId={activeId}
          />
        )}
      </main>
    </div>
  );
};
