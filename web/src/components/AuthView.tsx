import React, { useState, useEffect } from "react";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { clsx } from "clsx";
import { ScrollingIntro } from "./ScrollingIntro";
import { LoginForm } from "./LoginForm";
import { SignupWizard } from "./SignupWizard";
import { LockScreenForm } from "./LockScreenForm";
import LogoIcon from "../assets/obex_cat_eye_logo-256.webp";
import { useBranding } from "../hooks/useBranding";
import { loadTurnstileScript } from "../utils/auth";
import { getAuthConfig } from "../services";
import type { UserInfo } from "../services";

/**
 * Authentication configuration settings fetched from server.
 */
export interface AuthConfig {
  turnstile_site_key: string;
  turnstile_enabled_signup: boolean;
  turnstile_enabled_login: boolean;
  optional_session_expiration_days?: number;
  has_users?: boolean;
  registration_enabled?: boolean;
}

/**
 * Properties for the AuthView component.
 */
export interface AuthViewProps {
  /** Callback triggered on successful login or complete signup. */
  onSuccess?: () => void;
  /** Whether the view is rendered in session lock mode. */
  isLocked?: boolean;
  /** Current logged in user info for the lock screen. */
  currentUser?: UserInfo | null;
  /** Callback triggered when user unlocks their session with PIN. */
  onUnlock?: () => void;
  /** Callback triggered to log out and terminate the locked session. */
  handleLogout?: () => Promise<void>;
}

/**
 * AuthView component orchestrates the user login, signup, and lock screen shells.
 * It displays the ScrollingIntro sidebar along with the active authentication card
 * (Login, Signup, or LockScreen PIN unlock).
 *
 * @param props - Component props containing authentication and lock screen state.
 * @returns React elements representing the full login/registration/lock screen view.
 */
export const AuthView: React.FC<AuthViewProps> = ({
  onSuccess,
  isLocked = false,
  currentUser,
  onUnlock,
  handleLogout,
}): React.ReactElement => {
  const [isLogin, setIsLogin] = useState<boolean>(true);
  const [isBlurring, setIsBlurring] = useState<boolean>(false);
  const { appName, appLogoUrl } = useBranding();

  const handleToggleMode = (): void => {
    setIsBlurring(true);
    setTimeout(() => {
      setIsLogin((prev) => !prev);
      setIsBlurring(false);
    }, 300);
  };

  // Dynamic system configuration state
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);

  // Turnstile loading state
  const [turnstileReady, setTurnstileReady] = useState<boolean>(false);

  useEffect(() => {
    if (isLocked) return;
    const fetchConfig = async (): Promise<void> => {
      try {
        const configData = (await getAuthConfig()) as AuthConfig;
        setAuthConfig(configData);
        if (configData && configData.has_users === false) {
          setIsLogin(false);
        }
      } catch (e) {
        console.error("Failed to load auth config", e);
      }
    };
    fetchConfig();
  }, [isLocked]);

  const isTurnstileEnabled =
    !isLocked &&
    (isLogin
      ? authConfig?.turnstile_enabled_login
      : authConfig?.turnstile_enabled_signup);

  useEffect(() => {
    if (isTurnstileEnabled && authConfig?.turnstile_site_key) {
      loadTurnstileScript(() => {
        setTurnstileReady(true);
      });
    }
  }, [isTurnstileEnabled, authConfig]);

  return (
    <div className="min-h-app relative flex w-full flex-row bg-white">
      {/* Intro panel: large screens only, so phones go straight to the form. */}
      <div className="hidden h-app w-1/2 overflow-hidden border-r border-gray-200 bg-gray-50 lg:block">
        <ScrollingIntro />
      </div>

      <main className="relative flex min-h-app flex-1 flex-col items-center justify-center bg-(--canvas) px-4 py-16 sm:py-12">
        <div className="pt-safe absolute right-4 top-4 z-10">
          <LanguageSwitcher />
        </div>

        <div
          className={clsx(
            "w-full max-w-md transition-[opacity,transform] duration-200 ease-in-out",
            isBlurring ? "scale-[0.98] opacity-0" : "scale-100 opacity-100",
          )}
        >
          <div className="mb-6 flex items-center justify-center gap-3 lg:hidden">
            <img src={appLogoUrl || LogoIcon} alt="" className="h-10 w-10 object-contain" />
            <span className="text-xl font-bold text-gray-900">{appName}</span>
          </div>

          <div className="surface p-6 shadow-sm sm:p-8">
            {isLocked ? (
              <LockScreenForm currentUser={currentUser} onUnlock={onUnlock} handleLogout={handleLogout} />
            ) : isLogin ? (
              <LoginForm
                authConfig={authConfig}
                turnstileReady={turnstileReady}
                onSuccess={onSuccess || (() => {})}
                onToggleMode={handleToggleMode}
              />
            ) : (
              <SignupWizard
                authConfig={authConfig}
                turnstileReady={turnstileReady}
                onSuccess={onSuccess || (() => {})}
                onToggleMode={handleToggleMode}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
};
