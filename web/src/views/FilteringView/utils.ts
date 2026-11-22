import type { FilterList } from "./types";

export interface ListDisplay {
  /** Primary, human-readable name. */
  name: string;
  /** Secondary muted line (source host), empty when it would only repeat the name. */
  host: string;
}

/**
 * Builds what the list table shows instead of the raw URL: the list's own title when
 * known, otherwise a short `host · file` label derived from the URL.
 */
export function getListDisplay(list: Pick<FilterList, "url" | "title">): ListDisplay {
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
  const title = list.title?.trim();
  return { name: title || fallback, host: title ? host : "" };
}
