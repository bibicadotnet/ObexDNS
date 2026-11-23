import type { FilterList } from "./types";
import i18n from "../../i18n/config";

export interface ListDisplay {
  /** Primary, human-readable name. */
  name: string;
  /** Secondary muted line (source host), empty when it would only repeat the name. */
  host: string;
}

const KNOWN_PRESET_NAMES: Record<string, string> = {
  "filtering.presetOisdBig": "OISD Big (Ads/Malware etc.)",
  "presetOisdBig": "OISD Big (Ads/Malware etc.)",
  "filtering.presetOisdNsfw": "OISD NSFW (Adult/Shock content)",
  "presetOisdNsfw": "OISD NSFW (Adult/Shock content)",
  "filtering.presetAdGuard": "AdGuard AdServers",
  "presetAdGuard": "AdGuard AdServers",
  "filtering.presetStevenBlack": "StevenBlack Hosts",
  "presetStevenBlack": "StevenBlack Hosts",
};

/**
 * Builds what the list table shows instead of the raw URL: the list's own title when
 * known, otherwise a short `host · file` label derived from the URL.
 */
export function getListDisplay(
  list: Pick<FilterList, "url" | "title">,
  t?: (key: string, options?: any) => string
): ListDisplay {
  let host = "";
  let fallback = list.url;
  try {
    const u = new URL(list.url);
    host = u.hostname.replace(/^www\./, "");
    const file = u.pathname.split("/").filter(Boolean).pop() || "";
    fallback = file ? `${host} · ${file}` : host;
  } catch {
    // Not a parseable URL: keep the raw string as the name.
  }
  let title = list.title?.trim() || "";
  if (title) {
    const translate = t || i18n.t.bind(i18n);
    let resolved = "";
    if (title.startsWith("filtering.")) {
      resolved = translate(title);
    } else if (title.startsWith("preset")) {
      const key = `filtering.${title}`;
      resolved = translate(key);
    } else {
      resolved = title;
    }
    // Fallback if i18n returns the raw key or empty
    if (!resolved || resolved.startsWith("filtering.") || resolved.startsWith("preset")) {
      resolved = KNOWN_PRESET_NAMES[title] || KNOWN_PRESET_NAMES[title.replace(/^filtering\./, "")] || fallback;
    }
    title = resolved;
  }
  return { name: title || fallback, host: title ? host : "" };
}
