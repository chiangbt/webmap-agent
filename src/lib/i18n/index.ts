/**
 * Minimal i18n support for the GeoAgent control UI. Three locales are
 * provided ('en', 'zh-CN', and 'zh-TW'); the per-language dictionaries live
 * in `en.ts` (the source of truth for message keys), `zh-cn.ts`, and
 * `zh-tw.ts`.
 */

import { en, type GeoAgentMessageKey } from './en';
import { zhCN } from './zh-cn';
import { zhTW } from './zh-tw';

export type { GeoAgentMessageKey };

export type GeoAgentLocale = 'en' | 'zh-CN' | 'zh-TW';

/** All UI strings per locale. Exported so hosts can inspect key parity. */
export const MESSAGES: Record<GeoAgentLocale, Record<GeoAgentMessageKey, string>> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

/**
 * Look up a UI string for the given locale, interpolating `{name}` placeholders
 * from `params`. Values are substituted literally (a `$` in a value is never
 * treated as a replacement pattern).
 */
export function t(
  locale: GeoAgentLocale,
  key: GeoAgentMessageKey,
  params?: Record<string, string | number>,
): string {
  const template = MESSAGES[locale]?.[key] ?? MESSAGES.en[key] ?? key;
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
