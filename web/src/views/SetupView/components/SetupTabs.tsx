import React, { useState } from "react";
import { Tabs, Tab } from "@blueprintjs/core";
import { Globe, Monitor, Terminal, Smartphone, Router, ExternalLink, Copy, Check } from "lucide-react";
import { AppleIcon } from "../../../components/icons/AppleIcon";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import { generateMobileConfig, formatProfileLabel, extractDomain } from "../../../utils/mobileconfig";
import { useDeploymentMode } from "../../../hooks/useDeploymentMode";
import { useBranding } from "../../../hooks/useBranding";
import { isDummyOrPlaceholderDomain } from "../../../services";

const PANEL = "space-y-6 md:pl-6 pt-4 md:pt-0";

/** Unified NextDNS-style Command / Hostname Box with 1-click copy */
const CommandBlock: React.FC<{ command: string; onCopy: (text: string) => void }> = ({ command, onCopy }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between p-3.5 rounded-xl bg-gray-50 border border-[#d0d7de] font-mono text-xs sm:text-sm text-[#111827] leading-relaxed">
      <code className="truncate pr-3 select-all">{command}</code>
      <button
        type="button"
        onClick={() => {
          onCopy(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-white border border-transparent hover:border-[#d0d7de] transition-all cursor-pointer shrink-0"
        title="Sao chép"
      >
        {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
      </button>
    </div>
  );
};

/** Unified clean notes container */
const NotesList: React.FC<{ items: React.ReactNode[] }> = ({ items }) => (
  <div className="p-3.5 rounded-xl bg-gray-50/70 border border-[#d0d7de] text-xs text-[#4b5563] leading-relaxed space-y-1.5">
    {items.map((item, i) => (
      <div key={i} className="flex items-start gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400 mt-1.5 shrink-0" />
        <span className="flex-1">{item}</span>
      </div>
    ))}
  </div>
);

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
  isMobile,
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
  const [selectedBrowser, setSelectedBrowser] = useState<"chrome" | "edge">("chrome");
  const [copiedBrowser, setCopiedBrowser] = useState(false);

  const browserStepsRaw = t(
    "setup.browserSteps",
    "Settings > Privacy and security > Security > Use secure DNS > Custom > Paste URL."
  );

  return (
    <div className="rounded-2xl border border-[#d0d7de] bg-white shadow-xs p-5 sm:p-6">
      <Tabs
        id="setup-tabs"
        renderActiveTabPanelOnly={true}
        vertical={!isMobile}
        size="large"
        className={clsx(
          "setup-tabs-container relative z-10 bg-transparent",
          isMobile && [
            "[&_.bp6-tab-list]:overflow-x-auto!",
            "[&_.bp6-tab-list]:flex-nowrap!",
            "[&_.bp6-tab-list]:pb-1",
            "[&_.bp6-tab-list]:scrollbar-none",
            "[&_.bp6-tab-list]:[-ms-overflow-style:none]",
            "[&_.bp6-tab-list::-webkit-scrollbar]:hidden",
            "[&_.bp6-tab]:shrink-0",
          ]
        )}
      >
        {/* Browsers Tab */}
        <Tab
          id="browsers"
          title={
            <span>
              <Globe size={16} className="inline mr-2" />
              {t("setup.browsers", "Trình duyệt")}
            </span>
          }
          panel={
            <div className={PANEL}>
              <div>
                <h3 className="text-base font-bold text-[#111827] tracking-tight mb-2">
                  {t("setup.browserTitle", "Cấu hình trình duyệt (Chrome/Edge)")}
                </h3>
                <p className="text-sm text-[#4b5563] leading-relaxed mb-3">
                  {t("setup.browserPathTitle", "Các bước thiết lập trong trình duyệt:")}
                </p>
                <div className="p-3.5 rounded-xl bg-gray-50 border border-[#d0d7de] font-mono text-xs sm:text-sm text-[#111827] leading-relaxed select-all">
                  {browserStepsRaw}
                </div>
              </div>

              {/* Direct address bar shortcuts with Chrome / Edge toggle */}
              <div className="p-4 rounded-xl bg-gray-50 border border-[#d0d7de]">
                <div className="flex items-center justify-between gap-3 mb-2.5">
                  <span className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider">
                    {t("setup.browserTips", "Hoặc dán trực tiếp vào thanh địa chỉ:")}
                  </span>
                  <div className="inline-flex rounded-lg border border-[#d0d7de] bg-white p-0.5 shadow-2xs">
                    <button
                      type="button"
                      onClick={() => setSelectedBrowser("chrome")}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all cursor-pointer ${
                        selectedBrowser === "chrome"
                          ? "bg-[#0969da] text-white shadow-xs"
                          : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                      }`}
                    >
                      Chrome
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedBrowser("edge")}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all cursor-pointer ${
                        selectedBrowser === "edge"
                          ? "bg-[#0969da] text-white shadow-xs"
                          : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                      }`}
                    >
                      Edge
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg bg-white border border-[#d0d7de]">
                  <code className="text-xs sm:text-sm font-mono text-[#111827] truncate select-all">
                    {selectedBrowser === "chrome" ? "chrome://settings/security" : "edge://settings/privacy/security"}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      const url = selectedBrowser === "chrome" ? "chrome://settings/security" : "edge://settings/privacy/security";
                      copyToClipboard(url);
                      setCopiedBrowser(true);
                      setTimeout(() => setCopiedBrowser(false), 2000);
                    }}
                    className="p-1.5 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-all cursor-pointer shrink-0 ml-2"
                    title={t("common.copy", "Sao chép")}
                  >
                    {copiedBrowser ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
          }
        />

        {/* Apple Tab */}
        <Tab
          id="apple"
          title={
            <span>
              <AppleIcon size={16} className="inline mr-2" />
              {t("setup.apple", "Apple")}
            </span>
          }
          panel={
            <div className={PANEL}>
              <div>
                <h3 className="text-base font-bold text-[#111827] tracking-tight mb-2">
                  {t("setup.appleTitle", "macOS / iOS / iPadOS / tvOS")}
                </h3>
                <p className="text-sm text-[#4b5563] leading-relaxed mb-3">
                  {t("setup.appleDesc", "Mở liên kết sau trong Safari (hoặc nhập vào Apple TV) để tự động cài đặt hồ sơ mã hóa DoH:")}
                </p>
                <CommandBlock
                  command={`${window.location.origin}/apple?key=${profileKey}`}
                  onCopy={copyToClipboard}
                />
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-gray-50 rounded-xl border border-[#d0d7de]">
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase tracking-wider text-[#6b7280]">
                    {t("setup.downloadConfig", "Tải tệp cấu hình .mobileconfig")}
                  </div>
                  <div className="text-xs text-[#4b5563] mt-0.5">
                    {t("setup.appleManualHint", "Dành cho macOS hoặc lưu trữ file cài đặt thủ công")}
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
                    const fileTag = (label || domain)
                      .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, "_")
                      .replace(/_+/g, "_")
                      .replace(/^_|_$/g, "");
                    const appPrefix = (appName || "dns_worker")
                      .toLowerCase()
                      .replace(/[^a-z0-9_]/g, "_")
                      .replace(/_+/g, "_")
                      .replace(/^_|_$/g, "");
                    a.download = `${appPrefix || "dns_worker"}-${fileTag}-${profileKey}.mobileconfig`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[#0969da] hover:bg-[#0854ad] text-white text-xs sm:text-sm font-semibold shadow-xs transition-colors cursor-pointer shrink-0"
                >
                  <AppleIcon size={16} />
                  <span>{t("common.download", "Download")}</span>
                </button>
              </div>

              <NotesList
                items={[
                  t("setup.appleInstallHint", "Mở liên kết trên bằng Safari trên iOS / iPadOS / macOS, sau đó vào Cài đặt > Đã tải về hồ sơ để cài đặt."),
                  t("setup.appleTvosHint", "Apple TV (tvOS): Cài đặt > Cài đặt chung > Quyền riêng tư & Bảo mật > Gửi cho Apple (nhấn phím Play/Pause trên Điều khiển) > Thêm hồ sơ > Nhập đường dẫn trên."),
                  t("setup.appleWarning", "Không thể cài đặt tệp cấu hình trong Chế độ phong tỏa (Lockdown Mode)."),
                ]}
              />
            </div>
          }
        />

        {/* Windows Tab */}
        <Tab
          id="windows"
          title={
            <span>
              <Monitor size={16} className="inline mr-2" />
              {t("setup.windows", "MS Windows")}
            </span>
          }
          panel={
            <div className={PANEL}>
              <div>
                <h3 className="text-base font-bold text-[#111827] tracking-tight mb-2">
                  {t("setup.windowsTitle", "Microsoft Windows")}
                </h3>
                <p className="text-sm text-[#4b5563] leading-relaxed mb-3">
                  {t("setup.windowsStep1", "Mở PowerShell với quyền Administrator và chạy lệnh sau:")}
                </p>
                <CommandBlock
                  command={`irm "${window.location.origin}/setup.ps1?key=${profileKey}" | iex`}
                  onCopy={copyToClipboard}
                />
              </div>

              <NotesList
                items={[
                  t("setup.windowsNote1", "Hỗ trợ Windows 11 và Windows 10 (bản 2004 trở lên)."),
                  t("setup.windowsNote2", "Lệnh sẽ tự động đăng ký DNS-over-HTTPS và áp dụng ngay lập tức."),
                ]}
              />
            </div>
          }
        />

        {/* Linux Tab */}
        <Tab
          id="linux"
          title={
            <span>
              <Terminal size={16} className="inline mr-2" />
              {t("setup.linux", "Linux")}
            </span>
          }
          panel={
            <div className={PANEL}>
              <div>
                <h3 className="text-base font-bold text-[#111827] tracking-tight mb-2">
                  {t("setup.linuxTitle", "Linux (systemd-resolved)")}
                </h3>
                <p className="text-sm text-[#4b5563] leading-relaxed mb-3">
                  {t("setup.linuxStep1", "Chạy lệnh sau trong Terminal để cấu hình DoH:")}
                </p>
                <CommandBlock
                  command={`curl -sL "${window.location.origin}/setup.sh?key=${profileKey}" | sudo bash`}
                  onCopy={copyToClipboard}
                />
              </div>

              <NotesList items={[t("setup.linuxStep2", "Áp dụng cấu hình DoH thông qua systemd-resolved trên các bản phân phối Ubuntu, Debian, Fedora, Arch.")]} />
            </div>
          }
        />

        {/* MikroTik Tab */}
        <Tab
          id="routeros"
          title={
            <span>
              <Router size={16} className="inline mr-2" />
              {t("setup.routeros", "MikroTik")}
            </span>
          }
          panel={
            <div className={PANEL}>
              <div>
                <h3 className="text-base font-bold text-[#111827] tracking-tight mb-2">
                  {t("setup.routerosTitle", "MikroTik (RouterOS)")}
                </h3>
                <p className="text-sm text-[#4b5563] leading-relaxed mb-3">
                  {t("setup.routerosStep1", "Mở Terminal RouterOS và chạy lệnh sau:")}
                </p>
                <CommandBlock
                  command={`/ip dns set use-doh-server="${window.location.origin}/${profileKey}" verify-doh-cert=yes`}
                  onCopy={copyToClipboard}
                />
              </div>

              <NotesList items={[t("setup.routerosNote", "Yêu cầu RouterOS v6.47 trở lên. Đảm bảo router đã nhập chứng chỉ gốc nếu cần xác thực SSL.")]} />

              <div>
                <a
                  href="https://help.mikrotik.com/docs/spaces/ROS/pages/37748767/DNS"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-[#0969da] hover:underline font-medium"
                >
                  <ExternalLink size={13} />
                  <span>{t("setup.routerosDocs", "Xem tài liệu hướng dẫn chính thức từ MikroTik")}</span>
                </a>
              </div>
            </div>
          }
        />

        {/* Android Tab */}
        <Tab
          id="android"
          title={
            <span>
              <Smartphone size={16} className="inline mr-2" />
              {t("setup.android", "Android")}
            </span>
          }
          panel={
            <div className={PANEL}>
              <div>
                <h3 className="text-base font-bold text-[#111827] tracking-tight mb-2">
                  {t("setup.androidTitle", "Android")}
                </h3>

                {isCloudflare ? (
                  <div>
                    <p className="text-sm text-[#4b5563] leading-relaxed mb-3">
                      {t(
                        "setup.dotUnavailableCfDesc",
                        "Cloudflare Workers không hỗ trợ cổng DoT (853). Vui lòng cài đặt ứng dụng Intra hoặc AdGuard for Android và sử dụng URL DoH bên dưới:"
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
                      (!isDummy && cleanBaseDomain) || (!isIpAddress ? window.location.hostname : "");
                    const dotHostname = effectiveDotDomain ? `${profileKey}.${effectiveDotDomain}` : "";

                    return (
                      <div>
                        <p className="text-sm text-[#4b5563] leading-relaxed mb-3">
                          {t(
                            "setup.androidDesc",
                            "Settings > Network & internet > Private DNS > Private DNS provider hostname:"
                          )}
                        </p>
                        {dotHostname ? (
                          <CommandBlock command={dotHostname} onCopy={copyToClipboard} />
                        ) : (
                          <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">
                            {t(
                              "setup.androidIpNotice",
                              "Android Private DNS yêu cầu tên miền hợp lệ (ví dụ: dns.example.com)."
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()
                )}
              </div>

              <NotesList
                items={[
                  t("setup.androidWarning", "Hỗ trợ Android 9 Pie trở lên."),
                ]}
              />
            </div>
          }
        />
      </Tabs>
    </div>
  );
};
