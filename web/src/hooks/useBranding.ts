import { useState, useEffect } from "react";
import { getAuthConfig } from "../services/auth";
import { updateI18nAppName } from "../i18n/config";

export interface BrandingInfo {
  appName: string;
  appLogoUrl: string;
  appFaviconUrl: string;
  githubCornerEnabled: boolean;
  githubCornerUrl: string;
}

let cachedBranding: BrandingInfo | null = null;
const listeners = new Set<(branding: BrandingInfo) => void>();

function notify(branding: BrandingInfo) {
  cachedBranding = branding;
  updateI18nAppName(branding.appName);
  for (const l of listeners) {
    l(branding);
  }
}

export function getBranding(): BrandingInfo {
  if (cachedBranding) return cachedBranding;

  const winConfig = typeof window !== "undefined" ? window.DNS_WORKER_CONFIG : undefined;
  const appName = winConfig?.appName || (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_APP_NAME) || "DNS Shield";
  const appLogoUrl = winConfig?.appLogoUrl || (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_APP_LOGO_URL) || "https://img.bibica.net/CsXOg50M.png";
  const appFaviconUrl = winConfig?.appFaviconUrl || (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_APP_FAVICON_URL) || "https://img.bibica.net/UsF6Oisg.png";
  const githubCornerEnabled = winConfig?.githubCornerEnabled ?? (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_GITHUB_CORNER_ENABLED !== "false");
  const githubCornerUrl = winConfig?.githubCornerUrl || (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_GITHUB_CORNER_URL) || "https://github.com/bibicadotnet/ObexDNS";

  cachedBranding = {
    appName,
    appLogoUrl,
    appFaviconUrl,
    githubCornerEnabled,
    githubCornerUrl,
  };

  return cachedBranding;
}

function applyFavicon(faviconUrl: string) {
  if (!faviconUrl || typeof document === "undefined") return;
  const icons = document.querySelectorAll("link[rel*='icon']");
  if (icons.length > 0) {
    icons.forEach((el) => {
      (el as HTMLLinkElement).href = faviconUrl;
    });
  } else {
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = faviconUrl;
    document.head.appendChild(link);
  }
}

export function useBranding(): BrandingInfo {
  const [branding, setBranding] = useState<BrandingInfo>(getBranding);

  useEffect(() => {
    const listener = (newBranding: BrandingInfo) => setBranding(newBranding);
    listeners.add(listener);

    if (branding.appFaviconUrl) {
      applyFavicon(branding.appFaviconUrl);
    }

    const winConfig = typeof window !== "undefined" ? window.DNS_WORKER_CONFIG : undefined;
    if (!winConfig?.appName) {
      getAuthConfig().then((cfg) => {
        if (cfg) {
          const updated: BrandingInfo = {
            appName: cfg.app_name || branding.appName,
            appLogoUrl: cfg.app_logo_url || branding.appLogoUrl,
            appFaviconUrl: cfg.app_favicon_url || branding.appFaviconUrl,
            githubCornerEnabled: cfg.github_corner_enabled ?? branding.githubCornerEnabled,
            githubCornerUrl: cfg.github_corner_url || branding.githubCornerUrl,
          };
          notify(updated);
          if (updated.appFaviconUrl) {
            applyFavicon(updated.appFaviconUrl);
          }
        }
      }).catch(() => {});
    }

    return () => {
      listeners.delete(listener);
    };
  }, []);

  return branding;
}
