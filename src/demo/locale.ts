import type { GeoAgentLocale } from '@/lib/i18n';

/**
 * 所有演示页共享的 localStorage key：首页选择的语言会被持久化，
 * 各示例页据此跟随（设计上示例页本身不提供语言切换）。
 */
const LOCALE_KEY = 'geoagent.locale';

/**
 * 解析某个演示页应使用的语言：优先读取首页持久化的选择，
 * 其次按浏览器语言提示推断（zh* -> zh-CN），否则回退英文。
 *
 * @returns 合法的 GeoAgentLocale 取值（en / zh-CN / zh-TW）。
 */
export function resolveExamplesLocale(): GeoAgentLocale {
  try {
    // 第一优先级：首页持久化的语言选择
    const stored = localStorage.getItem(LOCALE_KEY);
    if (stored === 'en' || stored === 'zh-CN' || stored === 'zh-TW') {
      return stored;
    }
  } catch {
    // 隐私模式等受限浏览器上下文里 storage 可能不可用，忽略失败。
  }
  try {
    // 第二优先级：浏览器语言提示
    const language = (navigator.language || '').toLowerCase();
    if (language.startsWith('zh')) {
      // 繁体字地区使用 zh-TW；其他中文 locale（以及裸的 "zh"）使用简体中文。
      const traditional =
        language.includes('-tw') ||
        language.includes('-hk') ||
        language.includes('-mo') ||
        language.includes('hant');
      return traditional ? 'zh-TW' : 'zh-CN';
    }
  } catch {
    // navigator 读取失败时继续走默认语言。
  }
  // 兜底默认英文
  return 'en';
}

/**
 * 持久化首页选择的语言，使各示例页跟随同一选择。
 *
 * @param locale 要写入的语言值。
 */
export function persistExamplesLocale(locale: GeoAgentLocale): void {
  try {
    localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    // 忽略 storage 写入失败；本次访问内页面仍会切换语言。
  }
}

/**
 * 把语言应用到页面框架：`<html lang>` 与 document 标题。
 * Agent 面板则通过其 `locale` 选项接收同一个语言值。
 *
 * @param locale 当前页面语言。
 * @param title  各语言的标题候选：`zh` 为简体文案，`tw` 可选（缺省时繁体沿用简体文案），
 *               `en` 为英文文案。
 */
export function applyExamplePageLocale(
  locale: GeoAgentLocale,
  title: { en: string; zh: string; tw?: string },
): void {
  // 同步 <html lang> 属性
  document.documentElement.lang = locale;
  // 按语言挑选标题：繁体缺省回退简体文案
  document.title =
    locale === 'zh-CN'
      ? title.zh
      : locale === 'zh-TW'
        ? (title.tw ?? title.zh)
        : title.en;
}
