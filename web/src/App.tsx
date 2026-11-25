import { useState, useEffect, useRef, Suspense } from "react";
import { Spinner, OverlayToaster } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { Helmet } from "react-helmet-async";
import { Routes, Route, useNavigate, useLocation, Navigate } from "react-router-dom";
import { GitHubCorner } from "./components/GithubCorner";
import { lazyWithPreload } from "./utils/lazyWithPreload";
import { DashboardHomeView } from "./views/DashboardHomeView";
import { MainLayout } from "./layouts/MainLayout";
import { NotFoundView } from "./views/NotFoundView";
import { ProfileRoutes } from "./routes/ProfileRoutes";
import type { Profile } from "./services";
import { useTheme } from "./hooks/useTheme";
import { usePageMeta } from "./hooks/usePageMeta";
import { useBranding } from "./hooks/useBranding";
import { useAuth } from "./hooks/useAuth";
import { useProfiles } from "./hooks/useProfiles";
import { IdleSessionLock } from "./components/IdleSessionLock";
import { loadLocale } from "./i18n/config";

import { AuthView } from "./components/AuthView";

// Only shown when the DB or JWT secret is missing, so keep it out of the main bundle.
const DeploymentGuideView = lazyWithPreload(() =>
  import("./views/DeploymentGuideView").then((m) => ({ default: m.DeploymentGuideView })),
);

const AccountView = lazyWithPreload(() =>
  import("./views/AccountView").then((m) => ({ default: m.AccountView })),
);

const SystemView = lazyWithPreload(() =>
  import("./views/SystemView").then((m) => ({ default: m.SystemView })),
);

function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();
  const toasterRef = useRef<OverlayToaster | null>(null);
  const { i18n } = useTranslation();

  // Abstracted hooks for theme, page metadata/SEO, branding, and authentication & profile state
  const { theme, setTheme } = useTheme();
  useBranding(); // keeps the tab icon (<link rel="icon">) in sync with the branding config
  const pageMeta = usePageMeta();
  const {
    isLoggedIn,
    currentUser,
    checkAuth,
    handleLogout,
  } = useAuth(toasterRef);

  const {
    profiles,
    selectedProfile,
    setSelectedProfile,
    showCreateDialog,
    setShowCreateDialog,
    newProfileName,
    setNewProfileName,
    newProfileIsDefault,
    setNewProfileIsDefault,
    newProfileApplyDefaultFilters,
    setNewProfileApplyDefaultFilters,
    createError,
    deletingProfile,
    confirmDeleteDefaultProfile,
    cancelDeleteProfile,
    prefilledRule,
    setPrefilledRule,
    fetchProfiles,
    handleCreateProfile,
    handleDeleteProfile,
    handleQuickAction,
  } = useProfiles(isLoggedIn);

  const [isSaving, setIsSaving] = useState<boolean | "saving" | "verifying">(false);
  const [localeReady, setLocaleReady] = useState(false);

  useEffect(() => {
    loadLocale(i18n.language).finally(() => {
      setLocaleReady(true);
    });
  }, [i18n.language]);

  if (!localeReady) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Spinner size={50} />
      </div>
    );
  }

  // Check for configuration errors (missing DB or JWT_SECRET)
  const isDbMissing = (window as any).DNS_WORKER_CONFIG?.isDbMissing;
  const isJwtSecretMissing = (window as any).DNS_WORKER_CONFIG?.isJwtSecretMissing;
  if (isDbMissing || isJwtSecretMissing) {
    return (
      <Suspense
        fallback={
          <div className="h-screen flex items-center justify-center">
            <Spinner size={50} />
          </div>
        }
      >
        <DeploymentGuideView />
      </Suspense>
    );
  }

  if (isLoggedIn === null) {
    return (
      <div className="h-screen flex items-center justify-center">
        <GitHubCorner />
        <Spinner size={50} />
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <Suspense
        fallback={
          <div className="h-screen flex items-center justify-center">
            <Spinner size={50} />
          </div>
        }
      >
        <Helmet>
          <title>{pageMeta.title}</title>
          <meta name="description" content={pageMeta.description} />
          <html lang={i18n.language} />
        </Helmet>
        <GitHubCorner />
        <OverlayToaster position="bottom" ref={toasterRef} />
        <AuthView onSuccess={checkAuth} />
      </Suspense>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="h-screen flex items-center justify-center">
          <Spinner size={50} />
        </div>
      }
    >
      <Helmet>
        <title>{pageMeta.title}</title>
        <meta name="description" content={pageMeta.description} />
        <html lang={i18n.language} />
      </Helmet>
      <GitHubCorner />
      <OverlayToaster position="bottom" ref={toasterRef} />
      <IdleSessionLock currentUser={currentUser} handleLogout={handleLogout} onUnlock={fetchProfiles}>
        <Routes>
          <Route path="/" element={<Navigate to="/dash" replace />} />
          <Route
            path="/dash"
            element={
              <MainLayout
                isSidebarOpen={isSidebarOpen}
                setIsSidebarOpen={setIsSidebarOpen}
                theme={theme}
                setTheme={setTheme}
                selectedProfile={selectedProfile}
                profiles={profiles}
                setSelectedProfile={setSelectedProfile}
                location={location}
                navigate={navigate}
                handleLogout={handleLogout}
                currentUser={currentUser}
                isSaving={isSaving}
              >
                <DashboardHomeView
                  profiles={profiles}
                  onSelect={(p: Profile) => {
                    setSelectedProfile(p);
                    localStorage.setItem("obex_active_profile_id", p.id);
                    navigate(`/dash/${p.id}/setup`);
                  }}
                  onCreate={handleCreateProfile}
                  showCreate={showCreateDialog}
                  setShowCreate={setShowCreateDialog}
                  newName={newProfileName}
                  setNewName={setNewProfileName}
                  newIsDefault={newProfileIsDefault}
                  setNewIsDefault={setNewProfileIsDefault}
                  newApplyDefaultFilters={newProfileApplyDefaultFilters}
                  setNewApplyDefaultFilters={setNewProfileApplyDefaultFilters}
                  error={createError}
                  onDelete={handleDeleteProfile}
                  handleLogout={handleLogout}
                  navigate={navigate}
                  onRefresh={fetchProfiles}
                  currentUser={currentUser}
                  deletingProfile={deletingProfile}
                  onConfirmDeleteDefault={confirmDeleteDefaultProfile}
                  onCancelDeleteDefault={cancelDeleteProfile}
                  toasterRef={toasterRef}
                />
              </MainLayout>
            }
          />
          <Route
            path="/dash/:profileId/*"
            element={
              <MainLayout
                isSidebarOpen={isSidebarOpen}
                setIsSidebarOpen={setIsSidebarOpen}
                theme={theme}
                setTheme={setTheme}
                selectedProfile={selectedProfile}
                profiles={profiles}
                setSelectedProfile={setSelectedProfile}
                location={location}
                navigate={navigate}
                handleLogout={handleLogout}
                currentUser={currentUser}
                isSaving={isSaving}
              >
                <ProfileRoutes
                  selectedProfile={selectedProfile}
                  prefilledRule={prefilledRule}
                  setPrefilledRule={setPrefilledRule}
                  handleQuickAction={handleQuickAction}
                  toasterRef={toasterRef}
                  currentUser={currentUser}
                  onSavingChange={setIsSaving}
                />
              </MainLayout>
            }
          />
          <Route
            path="/account"
            element={
              <MainLayout
                isSidebarOpen={isSidebarOpen}
                setIsSidebarOpen={setIsSidebarOpen}
                theme={theme}
                setTheme={setTheme}
                selectedProfile={selectedProfile}
                profiles={profiles}
                setSelectedProfile={setSelectedProfile}
                location={location}
                navigate={navigate}
                handleLogout={handleLogout}
                currentUser={currentUser}
                isSaving={isSaving}
              >
                <AccountView onSavingChange={setIsSaving} toasterRef={toasterRef} />
              </MainLayout>
            }
          />
          <Route
            path="/system"
            element={
              <MainLayout
                isSidebarOpen={isSidebarOpen}
                setIsSidebarOpen={setIsSidebarOpen}
                theme={theme}
                setTheme={setTheme}
                selectedProfile={selectedProfile}
                profiles={profiles}
                setSelectedProfile={setSelectedProfile}
                location={location}
                navigate={navigate}
                handleLogout={handleLogout}
                currentUser={currentUser}
                isSaving={isSaving}
              >
                <SystemView onSavingChange={setIsSaving} toasterRef={toasterRef} currentUser={currentUser} />
              </MainLayout>
            }
          />
          <Route path="*" element={<NotFoundView />} />
        </Routes>
      </IdleSessionLock>
    </Suspense>
  );
}

export default App;
