import type { GeoAgentLocale } from '@/lib/i18n';

/**
 * Storage key shared by every demo page: the language picked on the homepage
 * is persisted and every example page follows it (there is no per-example
 * switcher by design).
 */
const LOCALE_KEY = 'geoagent.locale';

/**
 * Resolve the locale for a demo page: the homepage-stored choice first, then
 * a browser-language hint (zh* -> zh-CN), otherwise English.
 */
export function resolveExamplesLocale(): GeoAgentLocale {
  try {
    const stored = localStorage.getItem(LOCALE_KEY);
    if (stored === 'en' || stored === 'zh-CN' || stored === 'zh-TW') {
      return stored;
    }
  } catch {
    // Ignore storage failures in private or restricted browser contexts.
  }
  try {
    const language = (navigator.language || '').toLowerCase();
    if (language.startsWith('zh')) {
      // Traditional-script regions get zh-TW; other Chinese locales (and a
      // bare "zh") get simplified Chinese.
      const traditional =
        language.includes('-tw') ||
        language.includes('-hk') ||
        language.includes('-mo') ||
        language.includes('hant');
      return traditional ? 'zh-TW' : 'zh-CN';
    }
  } catch {
    // Fall through to the default locale.
  }
  return 'en';
}

/**
 * Persist the locale picked on the homepage so example pages follow it.
 */
export function persistExamplesLocale(locale: GeoAgentLocale): void {
  try {
    localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    // Ignore storage failures; the page still switches for this visit.
  }
}

/**
 * Apply the locale to the page chrome: `<html lang>` and the document title.
 * The Agent panel receives the same locale via its `locale` option.
 */
export function applyExamplePageLocale(
  locale: GeoAgentLocale,
  title: { en: string; zh: string; tw?: string },
): void {
  document.documentElement.lang = locale;
  document.title =
    locale === 'zh-CN'
      ? title.zh
      : locale === 'zh-TW'
        ? (title.tw ?? title.zh)
        : title.en;
}
