/**
 * Languages the dashboard speaks: English and Vietnamese.
 * `short` is the label shown in the compact language switch.
 */
export const LOCALE = [
  { label: "English", short: "EN", value: "en-US" },
  { label: "Tiếng Việt", short: "VI", value: "vi-VN" },
] as const;

export type SupportedLocale = (typeof LOCALE)[number]["value"];

export const DEFAULT_LOCALE: SupportedLocale = "en-US";

/**
 * Maps any locale tag (browser setting, value stored on the account, old i18n cache)
 * to one of the two supported locales. Vietnamese stays Vietnamese; everything else is English.
 */
export function normalizeLocale(input?: string | null): SupportedLocale {
  const tag = (input || "").trim().toLowerCase();
  if (tag === "vi" || tag.startsWith("vi-") || tag.startsWith("vi_")) return "vi-VN";
  return DEFAULT_LOCALE;
}
