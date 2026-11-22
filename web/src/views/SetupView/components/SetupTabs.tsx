import React from "react";
import { Tabs, Tab, H5, Button, Icon, Intent, Tag, Callout } from "@blueprintjs/core";
import { Globe, AppWindowMac, Monitor, Terminal, Smartphone, Router, ExternalLink } from "lucide-react";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import { generateMobileConfig, formatProfileLabel, extractDomain } from "../../../utils/mobileconfig";
import { StepNumber } from "./StepStampWatermark";
import { useDeploymentMode } from "../../../hooks/useDeploymentMode";
import { useBranding } from "../../../hooks/useBranding";
import { isDummyOrPlaceholderDomain } from "../../../services";


/** Consistent panel layout: title (18px) -> description (14px muted) -> content blocks. */
const PanelHeader: React.FC<{ title: React.ReactNode; desc?: React.ReactNode }> = ({ title, desc }) => (
  <header className="space-y-2">
    <H5 className="section-title">{title}</H5>
    {desc && <p className="text-sm leading-6 text-gray-600 ">{desc}</p>}
  </header>
);

/** A labelled step: small semibold label above its content. */
const Step: React.FC<{ label?: React.ReactNode; children: React.ReactNode }> = ({ label, children }) => (
  <section className="space-y-2.5">
    {label && <h6 className="subsection-title">{label}</h6>}
    {children}
  </section>
);

/** Command box with a copy button that stays visible on touch screens. */
const CommandBlock: React.FC<{ command: string; onCopy: (text: string) => void }> = ({ command, onCopy }) => (
  <div className="relative group">
    <pre className="bg-gray-50 py-3.5 pl-4 pr-12 rounded-lg overflow-x-auto text-[13px] leading-6 font-mono border border-gray-200 ">
      <code>{command}</code>
    </pre>
    <Button
      className="absolute top-1/2 -translate-y-1/2 right-2 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 transition-opacity"
      icon="duplicate"
      minimal
      small
      onClick={() => onCopy(command)}
    />
  </div>
);

const Notes: React.FC<{ items: React.ReactNode[] }> = ({ items }) => (
  <ul className="space-y-1.5 text-[13px] leading-5 text-gray-500 list-disc pl-5 marker:text-gray-400">
    {items.map((item, i) => (
      <li key={i}>{item}</li>
    ))}
  </ul>
);

const PANEL = "space-y-6 md:pl-6 pt-4 md:pt-0";

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

  return (
    <div className="group relative overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center border-b border-gray-200 px-4 py-3.5 md:px-6">
        <StepNumber step={3} />
        <h2 className="section-title">{t("setup.guideTitle", "Set up your device")}</h2>
      </div>
      <Tabs
        id="setup-tabs"
        renderActiveTabPanelOnly={true}
        vertical={!isMobile} // 移动端使用水平 Tab
        size="large"
        className={clsx(
          "p-4 md:p-6 setup-tabs-container relative z-10 bg-transparent",
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
      <Tab
        id="browsers"
        title={
          <span>
            <Globe size={16} className="inline mr-2" />
            {t("setup.browsers")}
          </span>
        }
        panel={
          <div className={PANEL}>
            <PanelHeader title={t("setup.browserTitle")} desc={t("setup.browserSteps")} />
            <Step label={t("setup.browserTips", "or copy this URL to the address bar: ").replace(/:\s*$/, "")}>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <p className="text-[13px] text-gray-500 ">Chrome</p>
                  <CommandBlock command="chrome://settings/security" onCopy={copyToClipboard} />
                </div>
                <div className="space-y-1.5">
                  <p className="text-[13px] text-gray-500 ">Edge</p>
                  <CommandBlock command="edge://settings/privacy/security" onCopy={copyToClipboard} />
                </div>
              </div>
            </Step>
          </div>
        }
      />

      <Tab
        id="apple"
        title={
          <span>
            <AppWindowMac size={16} className="inline mr-2" />
            {t("setup.apple")}
          </span>
        }
        panel={
          <div className={PANEL}>
            <PanelHeader title={t("setup.appleTitle")} desc={t("setup.appleDesc")} />
            <div className="p-6 bg-gray-50 rounded-xl border border-dashed border-gray-300 flex flex-col items-center justify-center">
              <Icon icon="document" size={36} className="opacity-25 mb-4" />
              <Button
                intent={Intent.PRIMARY}
                text={t("setup.downloadConfig")}
                icon="download"
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
              />
            </div>
            <Notes items={[t("setup.appleWarning"), t("setup.appleInstallHint")]} />
          </div>
        }
      />
      <Tab
        id="windows"
        title={
          <span>
            <Monitor size={16} className="inline mr-2" />
            {t("setup.windows")}
          </span>
        }
        panel={
          <div className={PANEL}>
            <PanelHeader title={t("setup.windowsTitle")} desc={t("setup.windowsDesc")} />

            <Step label={t("setup.windowsStep1")}>
              <CommandBlock command={`irm "${window.location.origin}/setup.ps1?key=${profileKey}" | iex`} onCopy={copyToClipboard} />
            </Step>

            <Notes items={[t("setup.windowsNote1"), t("setup.windowsNote2")]} />
          </div>
        }
      />

      <Tab
        id="linux"
        title={
          <span>
            <Terminal size={16} className="inline mr-2" />
            {t("setup.linux")}
          </span>
        }
        panel={
          <div className={PANEL}>
            <PanelHeader title={t("setup.linuxTitle")} desc={t("setup.linuxDesc")} />

            <Step label={t("setup.linuxStep1")}>
              <CommandBlock command={`curl -sL "${window.location.origin}/setup.sh?key=${profileKey}" | sudo bash`} onCopy={copyToClipboard} />
            </Step>

            <p className="text-sm leading-6 text-gray-600 ">{t("setup.linuxStep2")}</p>
          </div>
        }
      />

      <Tab
        id="routeros"
        title={
          <span>
            <Router size={16} className="inline mr-2" />
            {t("setup.routeros")}
          </span>
        }
        panel={
          <div className={PANEL}>
            <PanelHeader title={t("setup.routerosTitle")} desc={t("setup.routerosDesc")} />

            <Step label={t("setup.routerosStep1")}>
              <CommandBlock command={`/ip dns set use-doh-server="${window.location.origin}/${profileKey}" verify-doh-cert=yes`} onCopy={copyToClipboard} />
            </Step>

            <Notes items={[t("setup.routerosNote")]} />

            <a
              href="https://help.mikrotik.com/docs/spaces/ROS/pages/37748767/DNS"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[13px] text-blue-500 hover:underline"
            >
              <ExternalLink size={12} /> {t("setup.routerosDocs")}
            </a>
          </div>
        }
      />

      <Tab
        id="android"
        title={
          <span>
            <Smartphone size={16} className="inline mr-2" />
            {t("setup.android")}
          </span>
        }
        panel={
          <div className={PANEL}>
            <PanelHeader title={t("setup.androidTitle")} desc={t("setup.androidDesc")} />

            {isCloudflare ? (
              <Callout intent={Intent.WARNING} icon="warning-sign" className="text-xs">
                <div className="font-semibold mb-1">{t("setup.dotUnavailableCfTitle")}</div>
                <div>{t("setup.dotUnavailableCfDesc")}</div>
              </Callout>
            ) : (
              (() => {
                const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(window.location.hostname) ||
                                    window.location.hostname === "localhost" ||
                                    window.location.hostname === "127.0.0.1" ||
                                    window.location.hostname.includes(":");
                const cleanBaseDomain = (dotDomain || "").trim().replace(/^\*\./, "");
                const isDummy = isDummyOrPlaceholderDomain(cleanBaseDomain);
                const effectiveDotDomain = (!isDummy && cleanBaseDomain) || (!isIpAddress ? window.location.hostname : "");

                return (
                  <div className="p-4 bg-gray-50 rounded-xl border border-gray-200 space-y-3">
                    <div className="text-sm font-semibold text-gray-800 ">
                      {t("setup.androidDotTitle")}
                    </div>
                    <p className="text-[13px] leading-5 text-gray-500 ">
                      {t("setup.androidDotDesc")}
                    </p>

                    {effectiveDotDomain ? (
                      <div className="space-y-3 pt-1">
                        <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2">
                          <Tag
                            minimal
                            interactive
                            onClick={() => copyToClipboard(`${profileKey}.${effectiveDotDomain}`)}
                            icon="duplicate"
                            className="font-mono text-xs sm:text-sm py-1 px-3 self-start"
                            intent={Intent.PRIMARY}
                          >
                            {`${profileKey}.${effectiveDotDomain}`}
                          </Tag>
                        </div>
                      </div>
                    ) : (
                      <Callout intent={Intent.WARNING} icon="warning-sign" className="text-xs">
                        {t("setup.androidIpNotice")}
                      </Callout>
                    )}
                  </div>
                );
              })()
            )}

            {!isCloudflare && (
              <Callout intent={Intent.PRIMARY} icon="info-sign" className="text-xs">
                {t("setup.androidWarning")}
              </Callout>
            )}
          </div>
        }
      />
    </Tabs>
    </div>
  );
};
