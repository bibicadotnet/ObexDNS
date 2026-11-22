import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { useIsMobile } from "../hooks/useIsMobile";
import type { Profile, UserInfo } from "../types/auth";
import { SavingPill } from "../components/SavingPill";
import { DesktopSidebar } from "./DesktopSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { MobileMoreSheet } from "./MobileMoreSheet";
import { MobileTopBar } from "./MobileTopBar";
import { buildNavItems, getSection } from "./navItems";

/**
 * Properties for the MainLayout component.
 */
interface MainLayoutProps {
  /** The child route views to render. */
  children: React.ReactNode;
  /** True if the desktop sidebar shows labels (false = icon rail). */
  isSidebarOpen: boolean;
  /** Callback to expand/collapse the desktop sidebar. */
  setIsSidebarOpen: (open: boolean) => void;
  /** Selected Profile object. */
  selectedProfile: Profile | null;
  /** Available profiles list. */
  profiles: Profile[];
  /** Callback to set selected Profile. */
  setSelectedProfile: (p: Profile) => void;
  /** Router location object. */
  location: any;
  /** Router navigation function. */
  navigate: (path: string) => void;
  /** Callback to handle logouts. */
  handleLogout: () => void;
  /** Current logged in user info. */
  currentUser: UserInfo | null;
  /** True if a background saving operation is active. */
  isSaving?: boolean;
}

/**
 * MainLayout frames every signed-in page.
 *
 *  Tablet / desktop:  [ sidebar | page ]      sidebar = brand, profile, 5 places, me + language
 *  Phone:             [ top bar ]             profile + status
 *                     [ page ]
 *                     [ bottom tabs ]         Setup, Protection, Analytics, Logs, More
 *
 * One scroll area per page, so the sidebar and tab bar never move.
 */
export const MainLayout = ({
  children,
  isSidebarOpen,
  setIsSidebarOpen,
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
  const [moreOpen, setMoreOpen] = useState(false);

  const activeId = urlProfileId || selectedProfile?.id;
  const isProfileActive = !!activeId;
  const isAccountPage = location.pathname === "/account";
  const section = getSection(location.pathname);
  const isLogs = section === "logs";

  useEffect(() => {
    if (urlProfileId && profiles.length > 0 && selectedProfile?.id !== urlProfileId) {
      const found = profiles.find((p: Profile) => p.id === urlProfileId);
      if (found) setSelectedProfile(found);
    }
  }, [urlProfileId, profiles, selectedProfile, setSelectedProfile]);

  // Closing the sheet on navigation keeps it from sitting over the next page.
  useEffect(() => {
    setMoreOpen(false);
  }, [location.pathname]);

  const { main, settings } = buildNavItems(t, activeId, location.pathname);

  /** Switching profile keeps you on the same page (Logs stays Logs). */
  const switchProfile = (p: Profile) => {
    setSelectedProfile(p);
    const keep = section && !isAccountPage ? section : "setup";
    navigate(`/dash/${p.id}/${keep}`);
  };

  const backFromAccount = () => navigate(activeId ? `/dash/${activeId}/setup` : "/dash");

  return (
    <div className="h-app flex w-full overflow-hidden bg-(--canvas)">
      {!isMobile && (
        <DesktopSidebar
          isSidebarOpen={isSidebarOpen}
          setIsSidebarOpen={setIsSidebarOpen}
          isProfileActive={isProfileActive}
          profiles={profiles}
          selectedProfile={selectedProfile}
          onSwitchProfile={switchProfile}
          onShowAllProfiles={() => navigate("/dash")}
          handleLogout={handleLogout}
          currentUser={currentUser}
          mainItems={main}
          settingsItem={settings}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {isMobile && (
          <MobileTopBar
            profiles={profiles}
            selectedProfile={selectedProfile}
            onSwitchProfile={switchProfile}
            onShowAllProfiles={() => navigate("/dash")}
            isAccountPage={isAccountPage}
            onBack={backFromAccount}
            isSaving={isSaving}
            currentUser={currentUser}
          />
        )}

        <main id="app-scroll" className="relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          {!isMobile && isSaving && <SavingPill className="fixed right-5 top-4 z-30 shadow-sm" />}
          {isLogs ? (
            // Logs manage their own scrolling (filters stay put, the list scrolls).
            <div className="flex h-full min-w-0 flex-col overflow-hidden">{children}</div>
          ) : (
            <div className="page-pad min-w-0">{children}</div>
          )}
        </main>

        {isMobile && (
          <MobileBottomNav
            items={main.map((item) => ({ ...item, path: isProfileActive ? item.path : "/dash" }))}
            moreActive={moreOpen || settings.active || isAccountPage}
            onOpenMore={() => setMoreOpen(true)}
          />
        )}
      </div>

      {isMobile && (
        <MobileMoreSheet
          isOpen={moreOpen}
          onClose={() => setMoreOpen(false)}
          currentUser={currentUser}
          handleLogout={handleLogout}
          settingsPath={isProfileActive ? settings.path : undefined}
          settingsActive={settings.active}
        />
      )}
    </div>
  );
};
