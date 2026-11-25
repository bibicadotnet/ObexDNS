import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import enUS from './locales/en-US.json';
import viVN from './locales/vi-VN.json';

/**
 * en-US and vi-VN are both bundled statically: a lazily loaded vi-VN chunk costs an extra network
 * round trip (HTML -> JS -> chunk) before the first render, which is far more expensive than its size.
 */

/**
 * Reports whether a locale bundle is available. Both bundles ship in the main chunk, so this resolves
 * immediately; the function stays async so existing callers (await / .finally) keep working.
 */
export async function loadLocale(lang: string): Promise<boolean> {
  return i18n.hasResourceBundle(lang, 'translation');
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
      'vi-VN': { translation: viVN },
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
