import React, { useState } from "react";
import { Globe, Monitor, Terminal, Smartphone, Router, ExternalLink, Copy, Check } from "lucide-react";
import { AppleIcon } from "../../../components/icons/AppleIcon";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import { generateMobileConfig, formatProfileLabel, extractDomain } from "../../../utils/mobileconfig";
import { useDeploymentMode } from "../../../hooks/useDeploymentMode";
import { useBranding } from "../../../hooks/useBranding";
import { isDummyOrPlaceholderDomain } from "../../../services";

const PANEL = "space-y-6 pt-1";

/** Unified NextDNS-style Command / Hostname Box with 1-click copy & wrap (no horizontal scrollbar) */
const CommandBlock: React.FC<{ command: string; onCopy: (text: string) => void }> = ({ command, onCopy }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 p-3 sm:p-3.5 rounded-xl bg-gray-50 border border-[#d0d7de] leading-relaxed">
      <code className="font-mono text-xs sm:text-sm text-[#111827] break-all select-all flex-1">
        {command}
      </code>
      <button
        type="button"
        onClick={() => {
          onCopy(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-white border border-transparent hover:border-[#d0d7de] transition-all cursor-pointer shrink-0 self-start sm:self-center"
        title={t("common.copy", "Copy")}
      >
        {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
      </button>
    </div>
  );
};

/** Unified clean notes list (plain text bullets without box borders) */
const NotesList: React.FC<{ items: React.ReactNode[] }> = ({ items }) => (
  <div className="text-xs text-[#6b7280] leading-relaxed space-y-1.5 pt-1">
    {items.map((item, i) => (
      <div key={i} className="flex items-start gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400 mt-1.5 shrink-0" />
        <span className="flex-1">{item}</span>
      </div>
    ))}
  </div>
);

type SetupTabId = "browsers" | "apple" | "windows" | "linux" | "routeros" | "android";

export interface SetupTabsProps {
  isMobile: boolean;
  copyToClipboard: (text: string) => void;
  profileKey: string;
  profileName?: string;
  accessPointName?: string;
  currentIps: { ip: string; area: string | null }[];
  dotDomain?: string;
}

export const SetupTabs: React.FC<SetupTabsProps> = ({
  isMobile: _isMobile,
  copyToClipboard,
  profileKey,
  profileName,
  accessPointName,
  currentIps: _currentIps,
  dotDomain,
}) => {
  const { t } = useTranslation();
  const { isCloudflare } = useDeploymentMode();
  const { appName } = useBranding();
  const dohUrl = `${window.location.origin}/${profileKey}`;
  const [activeTab, setActiveTab] = useState<SetupTabId>("browsers");
  const [selectedBrowser, setSelectedBrowser] = useState<"chrome" | "edge">("chrome");

  const browserStepsRaw = t(
    "setup.browserSteps",
    "Settings > Privacy and security > Security"
  );

  const tabs: { id: SetupTabId; label: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
    { id: "browsers", label: t("setup.browsers", "Browsers"), icon: Globe },
    { id: "apple", label: t("setup.apple", "Apple"), icon: AppleIcon },
    { id: "windows", label: t("setup.windows", "MS Windows"), icon: Monitor },
    { id: "linux", label: t("setup.linux", "Linux"), icon: Terminal },
    { id: "routeros", label: t("setup.routeros", "MikroTik"), icon: Router },
    { id: "android", label: t("setup.android", "Android"), icon: Smartphone },
  ];

  return (
    <div className="rounded-2xl border border-[#d0d7de] bg-white shadow-xs p-4 sm:p-6">
      {/* Platform Tabs Navigation: Responsive Grid (No horizontal dragging/scrollbar) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 pb-4 mb-5 border-b border-[#d0d7de]/70">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                "w-full flex items-center justify-center gap-2 py-2.5 px-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all cursor-pointer select-none",
                isActive
                  ? "bg-white text-[#0969da] border border-[#d0d7de] shadow-xs font-semibold"
                  : "text-[#6b7280] hover:text-[#111827] hover:bg-gray-100 bg-gray-50/80 border border-transparent font-medium"
              )}
            >
              <Icon size={16} className={isActive ? "text-[#0969da]" : "text-gray-400"} />
              <span className="truncate">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab Panels */}
      {/* Browsers Tab */}
      {activeTab === "browsers" && (
        <div className={PANEL}>
          <div>
            <h3 className="text-lg font-semibold text-gray-900 tracking-tight mb-1">
              {t("setup.browserTitle", "Browser Configuration (Chrome/Edge)")}
            </h3>
            <p className="text-sm text-gray-500 leading-relaxed mb-4">
              {t("setup.browserSubtitle", "Enable DNS-over-HTTPS (DoH) directly in your browser:")}
            </p>
          </div>

          {/* Step 1: Open Security Settings */}
          <div className="space-y-2.5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                {t("setup.browserStep1Title", "Step 1: Open Security Settings")}
              </span>
              <div className="inline-flex rounded-lg border border-gray-200 bg-gray-100 p-0.5 self-start sm:self-auto">
                <button
                  type="button"
                  onClick={() => setSelectedBrowser("chrome")}
                  className={`px-2.5 py-1 text-xs rounded-md transition-all cursor-pointer ${
                    selectedBrowser === "chrome"
                      ? "bg-white text-[#0969da] shadow-xs font-medium"
                      : "text-gray-500 hover:text-gray-900 font-medium"
                  }`}
                >
                  Chrome
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedBrowser("edge")}
                  className={`px-2.5 py-1 text-xs rounded-md transition-all cursor-pointer ${
                    selectedBrowser === "edge"
                      ? "bg-white text-[#0969da] shadow-xs font-medium"
                      : "text-gray-500 hover:text-gray-900 font-medium"
                  }`}
                >
                  Edge
                </button>
              </div>
            </div>

            <p className="text-sm text-gray-600 leading-relaxed">
              {t("setup.browserAddressBarHint", "Quick access: Paste this into your browser's address bar:")}
            </p>

            <CommandBlock
              command={selectedBrowser === "chrome" ? "chrome://settings/security" : "edge://settings/privacy/security"}
              onCopy={copyToClipboard}
            />

            <p className="text-xs text-gray-500 leading-relaxed">
              <span className="font-medium text-gray-700">{t("setup.browserOrManual", "Or navigate manually via menu:")}</span>{" "}
              <span>{browserStepsRaw}</span>
            </p>
          </div>

          {/* Step 2: Configure DoH */}
          <div className="space-y-2.5">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider block">
              {t("setup.browserStep2Title", "Step 2: Configure Secure DNS & Paste URL")}
            </span>
            <p className="text-sm text-gray-600 leading-relaxed">
              {t("setup.browserStep2Desc", "Enable \"Use secure DNS\" > select \"Custom\" > paste the DoH URL below:")}
            </p>
            <CommandBlock command={dohUrl} onCopy={copyToClipboard} />
          </div>
        </div>
      )}

      {/* Apple Tab */}
      {activeTab === "apple" && (
        <div className={PANEL}>
          <div>
            <h3 className="text-lg font-semibold text-gray-900 tracking-tight mb-1">
              {t("setup.appleTitle", "macOS / iOS / iPadOS / tvOS")}
            </h3>
            <p className="text-sm text-gray-500 leading-relaxed mb-4">
              {t("setup.appleDesc", "Open this link in Safari (or enter into Apple TV) to install the encrypted DoH profile:")}
            </p>
            <CommandBlock
              command={`${window.location.origin}/apple?key=${profileKey}`}
              onCopy={copyToClipboard}
            />
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-900">
                {t("setup.downloadConfig", "Download .mobileconfig Profile")}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {t("setup.appleManualHint", "For macOS or offline manual installation")}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                const xml = generateMobileConfig({
                  profileKey,
                  profileName,
                  accessPointName,
                  origin: window.location.origin,
                  appName,
                });
                const blob = new Blob([xml], { type: "application/x-apple-aspen-config" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                const label = formatProfileLabel(profileName, accessPointName, appName);
                const domain = extractDomain(window.location.origin);
                const fileTag =
                  (label || domain)
                    .replace(/[^\p{L}\p{N}_-]/gu, "_")
                    .replace(/_+/g, "_")
                    .replace(/^_|_$/g, "") || "profile";
                const appPrefix = (appName || "dns_worker")
                  .toLowerCase()
                  .replace(/[^a-z0-9_]/g, "_")
                  .replace(/_+/g, "_")
                  .replace(/^_|_$/g, "");
                a.download = `${appPrefix || "dns_worker"}-${fileTag}-${profileKey}.mobileconfig`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg bg-white hover:bg-gray-50 text-[#0969da] hover:text-[#0854ad] border border-[#d0d7de] hover:border-gray-400 text-xs sm:text-sm font-semibold shadow-xs transition-all cursor-pointer shrink-0"
            >
              <AppleIcon size={16} />
              <span>{t("common.download", "Download")}</span>
            </button>
          </div>

          <NotesList
            items={[
              t("setup.appleInstallHint", "Open in Safari on iOS / iPadOS / macOS, then go to Settings > Profile Downloaded to install."),
              t("setup.appleTvosHint", "Apple TV (tvOS): Settings > General > Privacy & Security > Send to Apple (press Play/Pause on remote) > Add Profile > Enter the URL above."),
              t("setup.appleWarning", "Profiles cannot be installed in 'Lockdown Mode'. Please ensure your system is not in this state."),
            ]}
          />
        </div>
      )}

      {/* Windows Tab */}
      {activeTab === "windows" && (
        <div className={PANEL}>
          <div>
            <h3 className="text-lg font-semibold text-gray-900 tracking-tight mb-1">
              {t("setup.windowsTitle", "Microsoft Windows")}
            </h3>
            <p className="text-sm text-gray-500 leading-relaxed mb-4">
              {t("setup.windowsStep1", "Open PowerShell (Run as Administrator) and run the following command:")}
            </p>
            <CommandBlock
              command={`irm "${window.location.origin}/setup.ps1?key=${profileKey}" | iex`}
              onCopy={copyToClipboard}
            />
          </div>

          <NotesList
            items={[
              t("setup.windowsNote1", "Automatically backs up current adapter DNS settings to dns-backup.txt."),
              t("setup.windowsNote2", "Includes restart.bat and uninstall.bat in the installation folder for quick management or clean removal."),
            ]}
          />
        </div>
      )}

      {/* Linux Tab */}
      {activeTab === "linux" && (
        <div className={PANEL}>
          <div>
            <h3 className="text-lg font-semibold text-gray-900 tracking-tight mb-1">
              {t("setup.linuxTitle", "Linux (systemd-resolved)")}
            </h3>
            <p className="text-sm text-gray-500 leading-relaxed mb-4">
              {t("setup.linuxStep1", "Run this script to install cloudflared and setup systemd service (listening on 127.0.0.1:53).")}
            </p>
            <CommandBlock
              command={`curl -sL "${window.location.origin}/setup.sh?key=${profileKey}" | sudo bash`}
              onCopy={copyToClipboard}
            />
          </div>

          <NotesList items={[t("setup.linuxStep2", "Change your system DNS to 127.0.0.1.")]} />
        </div>
      )}

      {/* MikroTik Tab */}
      {activeTab === "routeros" && (
        <div className={PANEL}>
          <div>
            <h3 className="text-lg font-semibold text-gray-900 tracking-tight mb-1">
              {t("setup.routerosTitle", "MikroTik (RouterOS)")}
            </h3>
            <p className="text-sm text-gray-500 leading-relaxed mb-4">
              {t("setup.routerosStep1", "Run in the RouterOS terminal (RouterOS 7):")}
            </p>
            <CommandBlock
              command={`/ip dns set use-doh-server="${window.location.origin}/${profileKey}" verify-doh-cert=yes`}
              onCopy={copyToClipboard}
            />
          </div>

          <NotesList items={[t("setup.routerosNote", "Queries forwarded by the router show up in the logs as the router, not as individual devices. Set up devices directly if you need per-device logs.")]} />

          <div>
            <a
              href="https://help.mikrotik.com/docs/spaces/ROS/pages/37748767/DNS"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-[#0969da] hover:underline font-medium"
            >
              <ExternalLink size={13} />
              <span>{t("setup.routerosDocs", "MikroTik DNS documentation")}</span>
            </a>
          </div>
        </div>
      )}

      {/* Android Tab */}
      {activeTab === "android" && (
        <div className={PANEL}>
          <div>
            <h3 className="text-lg font-semibold text-gray-900 tracking-tight mb-1">
              {t("setup.androidTitle", "Android")}
            </h3>

            {isCloudflare ? (
              <div>
                <p className="text-sm text-gray-500 leading-relaxed mb-4">
                  {t("setup.dotUnavailableCfDesc", "Running on Cloudflare Workers does not support DoT (port 853). Please install an app like Intra or AdGuard for Android and use the DoH URL below:"
                  )}
                </p>
                <CommandBlock command={dohUrl} onCopy={copyToClipboard} />
              </div>
            ) : (
              (() => {
                const isIpAddress =
                  /^(\d{1,3}\.){3}\d{1,3}$/.test(window.location.hostname) ||
                  window.location.hostname === "localhost" ||
                  window.location.hostname === "127.0.0.1" ||
                  window.location.hostname.includes(":");
                const cleanBaseDomain = (dotDomain || "").trim().replace(/^\*\./, "");
                const isDummy = isDummyOrPlaceholderDomain(cleanBaseDomain);
                const effectiveDotDomain =
                  (!isIpAddress ? window.location.hostname : "") || (!isDummy ? cleanBaseDomain : "");
                const dotHostname = effectiveDotDomain ? `${profileKey}.${effectiveDotDomain}` : "";

                return (
                  <div>
                    <p className="text-sm text-gray-500 leading-relaxed mb-4">
                      {t(
                        "setup.androidDesc",
                        "Settings > Network & internet > Private DNS > Private DNS provider hostname:"
                      )}
                    </p>
                    {dotHostname ? (
                      <CommandBlock command={dotHostname} onCopy={copyToClipboard} />
                    ) : (
                      <p className="text-xs text-amber-700 leading-relaxed pt-1">
                        {t("setup.androidIpNotice", "Android Private DNS requires a valid domain name (e.g. dns.example.com)."
                        )}
                      </p>
                    )}
                  </div>
                );
              })()
            )}
          </div>

          <NotesList
            items={[
              t("setup.androidWarning", "Supports Android 9 Pie and above."),
            ]}
          />
        </div>
      )}
    </div>
  );
};
