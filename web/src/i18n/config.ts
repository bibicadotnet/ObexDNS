import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import enUS from './locales/en-US.json';

/**
 * Only en-US is bundled statically. Vietnamese is lazy-loaded.
 */
const LOCALE_LOADERS: Record<string, () => Promise<Record<string, unknown>>> = {
  'vi-VN': () => import('./locales/vi-VN.json').then((m) => m.default),
};

/**
 * Load a locale bundle if not already loaded.
 */
export async function loadLocale(lang: string): Promise<boolean> {
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
    resources: {
      'en-US': { translation: enUS },
    },
    fallbackLng: 'en-US',
    interpolation: {
      escapeValue: false,
      defaultVariables: {
        appName: getInitialAppName(),
      },
    },
  });

loadLocale(i18n.language);

export default i18n;
