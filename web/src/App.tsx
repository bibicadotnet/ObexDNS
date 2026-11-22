import { useState, useEffect, useRef, Suspense } from "react";
import { OverlayToaster } from "@blueprintjs/core";
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
import { LoadingScreen } from "./components/LoadingScreen";
import { DeploymentGuideView } from "./views/DeploymentGuideView";
import { loadLocale } from "./i18n/config";

import { AuthView } from "./components/AuthView";

const AccountView = lazyWithPreload(() =>
  import("./views/AccountView").then((m) => ({ default: m.AccountView })),
);

function App() {
  // Wide screens start with labels; tablets and small laptops start with the icon rail.
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth >= 1280);
  const navigate = useNavigate();
  const location = useLocation();
  const toasterRef = useRef<OverlayToaster | null>(null);
  const { i18n } = useTranslation();

  // Abstracted hooks for theme (light only), page metadata/SEO, branding, and authentication & profile state
  useTheme();
  const { appFaviconUrl } = useBranding();
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
    createError,
    prefilledRule,
    setPrefilledRule,
    fetchProfiles,
    handleCreateProfile,
    handleDeleteProfile,
    handleQuickAction,
  } = useProfiles(isLoggedIn);

  const [isSaving, setIsSaving] = useState(false);
  const [localeReady, setLocaleReady] = useState(false);

  useEffect(() => {
    loadLocale(i18n.language).finally(() => {
      setLocaleReady(true);
    });
  }, [i18n.language]);

  if (!localeReady) {
    return <LoadingScreen />;
  }

  // Check for configuration errors (missing DB or JWT_SECRET)
  const isDbMissing = (window as any).DNS_WORKER_CONFIG?.isDbMissing;
  const isJwtSecretMissing = (window as any).DNS_WORKER_CONFIG?.isJwtSecretMissing;
  if (isDbMissing || isJwtSecretMissing) {
    return <DeploymentGuideView />;
  }

  if (isLoggedIn === null) {
    return (
      <>
        <GitHubCorner />
        <LoadingScreen />
      </>
    );
  }

  if (!isLoggedIn) {
    return (
      <Suspense
        fallback={<LoadingScreen />}
      >
        <Helmet>
          <title>{pageMeta.title}</title>
          <meta name="description" content={pageMeta.description} />
          <html lang={i18n.language} />
          {appFaviconUrl && <link rel="icon" href={appFaviconUrl} />}
          {appFaviconUrl && <link rel="shortcut icon" href={appFaviconUrl} />}
        </Helmet>
        <GitHubCorner />
        <OverlayToaster position="bottom" ref={toasterRef} />
        <AuthView onSuccess={checkAuth} />
      </Suspense>
    );
  }

  return (
    <Suspense
      fallback={<LoadingScreen />}
    >
      <Helmet>
        <title>{pageMeta.title}</title>
        <meta name="description" content={pageMeta.description} />
        <html lang={i18n.language} />
        {appFaviconUrl && <link rel="icon" href={appFaviconUrl} />}
        {appFaviconUrl && <link rel="shortcut icon" href={appFaviconUrl} />}
      </Helmet>
      <OverlayToaster position="bottom" ref={toasterRef} />
      <IdleSessionLock currentUser={currentUser} handleLogout={handleLogout} onUnlock={fetchProfiles}>
        <Routes>
          <Route path="/" element={<Navigate to="/dash" replace />} />
          <Route
            path="/dash"
            element={
              <DashboardHomeView
                profiles={profiles}
                onSelect={(p: Profile) => {
                  setSelectedProfile(p);
                  navigate(`/dash/${p.id}/setup`);
                }}
                onCreate={handleCreateProfile}
                showCreate={showCreateDialog}
                setShowCreate={setShowCreateDialog}
                newName={newProfileName}
                setNewName={setNewProfileName}
                error={createError}
                onDelete={handleDeleteProfile}
                handleLogout={handleLogout}
                navigate={navigate}
                onRefresh={fetchProfiles}
                currentUser={currentUser}
              />
            }
          />
          <Route
            path="/dash/:profileId/*"
            element={
              <MainLayout
                isSidebarOpen={isSidebarOpen}
                setIsSidebarOpen={setIsSidebarOpen}
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
          <Route path="*" element={<NotFoundView />} />
        </Routes>
      </IdleSessionLock>
    </Suspense>
  );
}

export default App;
