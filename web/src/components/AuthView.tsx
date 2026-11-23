import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Shield, SlidersHorizontal, Smartphone, Copy, Check } from "lucide-react";
import { AppleIcon } from "./icons/AppleIcon";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { LoginForm } from "./LoginForm";
import { SignupWizard } from "./SignupWizard";
import { LockScreenForm } from "./LockScreenForm";
import { loadTurnstileScript } from "../utils/auth";
import { getAuthConfig } from "../services";
import type { UserInfo } from "../services";
import { useBranding } from "../hooks/useBranding";
import LogoIcon from "../assets/obex_cat_eye_logo-256.webp";

export interface AuthConfig {
  turnstile_site_key: string;
  turnstile_enabled_signup: boolean;
  turnstile_enabled_login: boolean;
  optional_session_expiration_days?: number;
  has_users?: boolean;
  registration_enabled?: boolean;
}

export interface AuthViewProps {
  onSuccess?: () => void;
  isLocked?: boolean;
  currentUser?: UserInfo | null;
  onUnlock?: () => void;
  handleLogout?: () => Promise<void>;
}

export const AuthView: React.FC<AuthViewProps> = ({
  onSuccess,
  isLocked = false,
  currentUser,
  onUnlock,
  handleLogout,
}) => {
  const [isLogin, setIsLogin] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<"doh" | "dot" | "apple" | "windows">("doh");
  const { t } = useTranslation();
  const { appName, appLogoUrl } = useBranding();

  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [turnstileReady, setTurnstileReady] = useState<boolean>(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "https://dns.example.com";
  const currentHostname = typeof window !== "undefined" ? window.location.hostname : "dns.example.com";
  const defaultWindowsCmd = `irm "${origin}/setup.ps1" | iex`;
  const defaultAppleUrl = `${origin}/apple`;
  const defaultDohUrl = `${origin}/dns-query`;
  const defaultDotHost = currentHostname;

  const handleCopy = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

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
    <div className="min-h-screen bg-[#f8fafc] text-[#111827] flex flex-col font-sans antialiased">
      {/* Top Navbar */}
      <header className="sticky top-0 z-30 bg-white/90 backdrop-blur-md border-b border-[#d0d7de] px-4 sm:px-8 lg:px-12 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img
            src={appLogoUrl || LogoIcon}
            alt={appName || "DNS Shield"}
            className="w-8 h-8 rounded-lg object-contain shadow-xs"
          />
          <span className="font-bold text-base tracking-tight text-[#111827] leading-none">
            {appName || "DNS Shield"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <LanguageSwitcher />
        </div>
      </header>

      {/* Main Container - Aligned to top, clean modern NextDNS spacing */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 sm:p-8 lg:p-12 flex flex-col justify-start pt-6 sm:pt-8 pb-16">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start">
          
          {/* Left Column: Public Instant Connection & Core Features */}
          {!isLocked && (
            <div className="flex flex-col space-y-6 lg:col-span-7">
              <div>
                <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold tracking-tight text-[#111827] leading-tight">
                  <span>{t("auth.heroTitle1", "DNS Riêng tư & Bảo mật.")}</span>{" "}
                  <span className="text-[#0969da] block sm:inline mt-1 sm:mt-0">{t("auth.heroTitle2", "Tùy biến cho mọi thiết bị.")}</span>
                </h1>
                <p className="mt-3 text-base sm:text-lg text-[#4b5563] leading-relaxed max-w-xl">
                  {t("auth.heroSubtitle", "Hỗ trợ DNS-over-HTTPS (DoH) và DNS-over-TLS (DoT). Kết nối nhanh với cấu hình mặc định hoặc đăng nhập để tự quản lý bộ lọc, tên miền và thiết bị theo ý bạn.")}
                </p>
              </div>

              {/* Instant Use DNS Card (Windows, Apple, DoH, DoT - Default Account) */}
              <div className="p-5 sm:p-6 rounded-2xl bg-white border border-[#d0d7de] shadow-xs space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-xs font-bold uppercase tracking-wider text-[#111827]">
                      {t("auth.instantUseTitle", "Sử dụng ngay lập tức")}
                    </span>
                  </div>

                  {/* Multi-platform Tab Switcher (DoH / DoT / Apple / Windows) */}
                  <div className="inline-flex p-1 bg-gray-100 rounded-lg text-xs font-semibold border border-gray-200 overflow-x-auto max-w-full">
                    {(["doh", "dot", "apple", "windows"] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setActiveTab(tab)}
                        className={`px-3 py-1 rounded-md transition-all cursor-pointer whitespace-nowrap ${
                          activeTab === tab
                            ? "bg-white text-[#0969da] shadow-xs font-bold"
                            : "text-[#6b7280] hover:text-[#111827]"
                        }`}
                      >
                        {tab === "doh"
                          ? "DoH"
                          : tab === "dot"
                          ? "DoT"
                          : tab === "apple"
                          ? t("auth.tabApple", "Apple")
                          : t("auth.tabWindows", "Windows")}
                      </button>
                    ))}
                  </div>
                </div>

                <p className="text-xs sm:text-sm text-[#4b5563] leading-relaxed m-0">
                  {activeTab === "doh" && t("auth.dohInstantDesc", "Dán vào trình duyệt (Chrome, Edge, Firefox) hoặc ứng dụng hỗ trợ DNS-over-HTTPS.")}
                  {activeTab === "dot" && t("auth.dotInstantDesc", "Sử dụng cho Android Private DNS hoặc Router mạng hỗ trợ DNS-over-TLS (cổng 853).")}
                  {activeTab === "apple" && t("auth.appleInstantDesc", "Mở trong Safari (iOS / macOS) hoặc nhập trên Apple TV để tự động cài đặt cấu hình DoH mặc định.")}
                  {activeTab === "windows" && t("auth.windowsInstantDesc", "Chạy trong PowerShell (Admin) để tự động cài đặt DoH và Zapret DPI bypass theo tài khoản mặc định.")}
                </p>

                {/* Active Endpoint with 1-click Copy & Direct Download */}
                <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-gray-50 border border-[#d0d7de]">
                  <div className="flex flex-col min-w-0 pr-2">
                    <span className="text-[11px] text-[#6b7280] font-semibold uppercase tracking-wider">
                      {activeTab === "doh" && "DNS-over-HTTPS URL"}
                      {activeTab === "dot" && "DNS-over-TLS Hostname"}
                      {activeTab === "apple" && "Safari / Apple TV URL (macOS / iOS / tvOS)"}
                      {activeTab === "windows" && "PowerShell (Windows 10 / 11)"}
                    </span>
                    <code className="text-xs sm:text-sm font-mono text-[#0969da] font-semibold truncate select-all mt-0.5">
                      {activeTab === "doh" && defaultDohUrl}
                      {activeTab === "dot" && defaultDotHost}
                      {activeTab === "apple" && defaultAppleUrl}
                      {activeTab === "windows" && defaultWindowsCmd}
                    </code>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {activeTab === "apple" && (
                      <a
                        href="/apple"
                        download="dns_shield-default.mobileconfig"
                        className="apple-download-btn p-2 rounded-lg cursor-pointer shrink-0 flex items-center justify-center"
                        title={t("auth.downloadMobileConfig", "Tải hồ sơ .mobileconfig")}
                      >
                        <AppleIcon size={16} />
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        const textToCopy =
                          activeTab === "doh"
                            ? defaultDohUrl
                            : activeTab === "dot"
                            ? defaultDotHost
                            : activeTab === "apple"
                            ? defaultAppleUrl
                            : defaultWindowsCmd;
                        handleCopy(activeTab, textToCopy);
                      }}
                      className="p-2 rounded-lg text-[#6b7280] hover:text-[#0969da] hover:bg-white border border-transparent hover:border-[#d0d7de] transition-all cursor-pointer shrink-0"
                      title={t("common.copy", "Sao chép")}
                    >
                      {copiedKey === activeTab ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>

              {/* 3 Real Feature Cards - Full Width, No Truncation, High Contrast */}
              <div className="space-y-3 pt-1">
                <div className="p-3.5 rounded-xl bg-white border border-[#d0d7de] shadow-xs flex items-center gap-3.5">
                  <div className="p-2 rounded-lg bg-emerald-50 text-emerald-600 shrink-0">
                    <Shield className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-[#111827] m-0">
                      {t("auth.featAdblock", "Chặn quảng cáo & mã độc")}
                    </h4>
                    <p className="text-xs sm:text-sm text-[#4b5563] mt-0.5 m-0 leading-normal">
                      {t("auth.featAdblockDesc", "Tích hợp sẵn các danh sách bộ lọc mạnh mẽ giúp bảo vệ thiết bị.")}
                    </p>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-white border border-[#d0d7de] shadow-xs flex items-center gap-3.5">
                  <div className="p-2 rounded-lg bg-blue-50 text-[#0969da] shrink-0">
                    <SlidersHorizontal className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-[#111827] m-0">
                      {t("auth.featCustom", "Tùy biến quy tắc linh hoạt")}
                    </h4>
                    <p className="text-xs sm:text-sm text-[#4b5563] mt-0.5 m-0 leading-normal">
                      {t("auth.featCustomDesc", "Tự do cấu hình chặn, mở ngoại lệ (whitelist) hoặc chuyển hướng tên miền.")}
                    </p>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-white border border-[#d0d7de] shadow-xs flex items-center gap-3.5">
                  <div className="p-2 rounded-lg bg-indigo-50 text-indigo-600 shrink-0">
                    <Smartphone className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-[#111827] m-0">
                      {t("auth.featDevices", "Hỗ trợ DoH & DoT")}
                    </h4>
                    <p className="text-xs sm:text-sm text-[#4b5563] mt-0.5 m-0 leading-normal">
                      {t("auth.featDevicesDesc", "Tương thích hoàn toàn với iOS, Android, Windows, macOS và Router.")}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Right Column: Custom Setup & Account Card */}
          <div className={`w-full ${isLocked ? "max-w-md mx-auto" : "lg:col-span-5 max-w-md mx-auto lg:max-w-none"}`}>
            <div className="bg-white rounded-2xl border border-[#d0d7de] shadow-sm p-6 sm:p-8">
              {isLocked ? (
                <LockScreenForm
                  currentUser={currentUser}
                  onUnlock={onUnlock}
                  handleLogout={handleLogout}
                />
              ) : (
                <>
                  {/* Card Header Context */}
                  <div className="mb-4 text-center">
                    <span className="text-xs text-[#6b7280] font-semibold uppercase tracking-wider">
                      {t("auth.customAccountTitle", "Tự cấu hình & Quản lý riêng")}
                    </span>
                  </div>

                  {/* Segmented Tab Switcher (Đăng nhập / Đăng ký) */}
                  <div className="grid grid-cols-2 p-1 bg-gray-100 rounded-xl mb-6 border border-gray-200">
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setIsLogin(true);
                      }}
                      onClick={() => setIsLogin(true)}
                      className={`py-2 text-sm font-semibold rounded-lg transition-all cursor-pointer ${
                        isLogin
                          ? "bg-white text-[#111827] shadow-xs font-bold"
                          : "text-[#6b7280] hover:text-[#111827]"
                      }`}
                    >
                      {t("auth.loginBtn", "Đăng nhập")}
                    </button>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setIsLogin(false);
                      }}
                      onClick={() => setIsLogin(false)}
                      className={`py-2 text-sm font-semibold rounded-lg transition-all cursor-pointer ${
                        !isLogin
                          ? "bg-white text-[#111827] shadow-xs font-bold"
                          : "text-[#6b7280] hover:text-[#111827]"
                      }`}
                    >
                      {t("auth.signupBtn", "Đăng ký")}
                    </button>
                  </div>

                  {/* Form Content */}
                  {isLogin ? (
                    <LoginForm
                      authConfig={authConfig}
                      turnstileReady={turnstileReady}
                      onSuccess={onSuccess || (() => {})}
                      onToggleMode={() => setIsLogin(false)}
                    />
                  ) : (
                    <SignupWizard
                      authConfig={authConfig}
                      turnstileReady={turnstileReady}
                      onSuccess={onSuccess || (() => {})}
                      onToggleMode={() => setIsLogin(true)}
                    />
                  )}
                </>
              )}
            </div>
          </div>

        </div>
      </main>
    </div>
  );
};
