/**
 * GeoAgent 控件 UI 的轻量 i18n 支持。提供三个 locale（'en'、'zh-CN'、
 * 'zh-TW'）；各语言词典分别位于 `en.ts`（消息 key 的事实来源）、
 * `zh-cn.ts` 与 `zh-tw.ts`。
 */

import { en, type GeoAgentMessageKey } from './en';
import { zhCN } from './zh-cn';
import { zhTW } from './zh-tw';

// 转发导出消息 key 联合类型，宿主可据此对文案做类型安全校验。
export type { GeoAgentMessageKey };

/** 支持的 locale 联合类型：英文、简体中文、繁体中文。 */
export type GeoAgentLocale = 'en' | 'zh-CN' | 'zh-TW';

/** 各 locale 的全部 UI 文案。导出以便宿主校验各语言包 key 的一致性。 */
export const MESSAGES: Record<GeoAgentLocale, Record<GeoAgentMessageKey, string>> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

/**
 * 按指定 locale 查找 UI 文案，并把 `params` 中的值插值到 `{name}` 占位符。
 * 插值按字面量替换（参数值中的 `$` 不会被当作替换模式处理）。
 *
 * @param locale - 目标语言；找不到对应词条时回退到英文，英文也缺失时返回 key 本身
 * @param key - 消息 key（来自 `GeoAgentMessageKey` 联合类型）
 * @param params - 可选的占位符参数表，形如 `{ count: 3 }` 对应 `{count}`
 * @returns 插值后的文案字符串
 */
export function t(
  locale: GeoAgentLocale,
  key: GeoAgentMessageKey,
  params?: Record<string, string | number>,
): string {
  // 依次回退：目标 locale 的词条 -> 英文词条 -> key 本身，保证任何情况下都有可展示文本。
  const template = MESSAGES[locale]?.[key] ?? MESSAGES.en[key] ?? key;
  // 无参数时直接返回模板原文，跳过正则替换。
  if (!params) {
    return template;
  }
  // 匹配形如 {name} 的占位符；参数表中存在该 name 时替换，否则原样保留占位符。
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
