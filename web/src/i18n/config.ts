import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import enUS from './locales/en-US.json';
import { DEFAULT_LOCALE, LOCALE, normalizeLocale } from '../config/locales';

/**
 * Maps a resolved i18next language tag to its canonical locale key and the
 * dynamic import that delivers the corresponding JSON bundle.
 *
 * Only en-US is bundled statically (it acts as the fallback language).
 * Vietnamese is split into its own async chunk by Rollup/Rolldown and
 * fetched the first time it is needed.
 */
const LOCALE_LOADERS: Record<string, () => Promise<Record<string, unknown>>> = {
  'vi-VN': () => import('./locales/vi-VN.json').then((m) => m.default),
};

/**
 * Load a locale bundle into the i18n instance if it has not been loaded yet.
 * Silently ignores unknown locale keys (falls back to en-US automatically).
 * Returns true if the locale was successfully loaded (or was already cached).
 */
export async function loadLocale(input: string): Promise<boolean> {
  const lang = normalizeLocale(input);
  if (i18n.hasResourceBundle(lang, 'translation')) return true;

  const loader = LOCALE_LOADERS[lang];
  if (!loader) return false;

  try {
    const translations = await loader();
    i18n.addResourceBundle(lang, 'translation', translations, true, true);
    return true;
  } catch (err) {
    console.warn(`[i18n] Failed to load locale "${lang}":`, err);
    return false;
  }
}

const getInitialAppName = (): string => {
  const winConfig = typeof window !== "undefined" ? window.DNS_WORKER_CONFIG : undefined;
  return winConfig?.appName || (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_APP_NAME) || "DNS Shield";
};

export function updateI18nAppName(appName: string) {
  if (!i18n.options.interpolation) {
    i18n.options.interpolation = {};
  }
  i18n.options.interpolation.defaultVariables = {
    ...i18n.options.interpolation.defaultVariables,
    appName,
  };
  i18n.emit('languageChanged', i18n.language);
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // Only en-US is bundled in the initial chunk; Vietnamese is loaded on demand.
    resources: {
      'en-US': { translation: enUS },
    },
    supportedLngs: LOCALE.map((l) => l.value),
    fallbackLng: DEFAULT_LOCALE,
    load: 'currentOnly',
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      // Whatever the browser or an old cache reports, land on English or Vietnamese.
      convertDetectedLanguage: (lng: string) => normalizeLocale(lng),
    },
    interpolation: {
      escapeValue: false,
      defaultVariables: {
        appName: getInitialAppName(),
      },
    },
  });

// Load the initially detected language as soon as possible.
loadLocale(i18n.language);

export default i18n;
