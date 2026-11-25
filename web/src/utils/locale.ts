import i18n from "../i18n/config";
import { loadLocale } from "../i18n/config";
import { setSystemLocale } from "./date";

import { updateMe } from "../services";
import { getAccessToken } from "./token";

/**
 * Updates the application locale and persists the change to the user account if logged in.
 *
 * The locale bundle is fetched (and cached) before `i18n.changeLanguage` is
 * called, so the UI never reverts to the fallback language mid-render.
 *
 * @param newLocale - The new locale code to set.
 * Resolves as soon as the UI language has switched; saving the preference to the server continues
 * in the background so the caller never waits for a network round trip.
 *
 * @returns A promise resolving to `{ loaded, persisted }`:
 *   - `loaded`:    true if the locale bundle was available (cached or just downloaded).
 *   - `persisted`: a promise that resolves to true once the server PATCH succeeded (false if it
 *                  failed or there is no logged-in user to save it for).
 */
export async function updateLocale(
  newLocale: string,
): Promise<{ loaded: boolean; persisted: Promise<boolean> }> {
  const locale = newLocale || "en-US";

  // Fetch and cache the locale bundle BEFORE switching the language.
  // For English variants (en-GB, en-SG) loadLocale returns false (no separate
  // bundle), which is fine — they share the bundled en-US translations.
  const loaded = await loadLocale(locale);

  // Switch the language only after the bundle is ready.
  i18n.changeLanguage(locale);
  setSystemLocale(locale);

  // If user is not logged in (e.g. on login/signup page), mark explicit locale selection
  // so that when they log in, their explicit choice is preserved and synced to the profile.
  if (!getAccessToken()) {
    try {
      sessionStorage.setItem("obex_explicit_locale", locale);
      localStorage.setItem("obex_explicit_locale", locale);
    } catch {}
  } else {
    try {
      sessionStorage.removeItem("obex_explicit_locale");
      localStorage.removeItem("obex_explicit_locale");
    } catch {}
  }

  // Persist the preference to the server in the background (only when someone is logged in:
  // on the login screen the request would just fail with 401 and trigger a pointless token refresh).
  const persisted = getAccessToken()
    ? updateMe({ locale }).then(
        () => true,
        (e) => {
          console.error("Failed to persist locale to server:", e);
          return false;
        },
      )
    : Promise.resolve(false);

  return { loaded, persisted };
}
