/**
 * 引擎间共享的纯工具函数。
 *
 * 三个引擎 shim（leaflet / openlayers / arcgis）此前各自复制了这些实现，
 * 复制后已出现行为漂移（如颜色白名单放行范围不一致：Leaflet 版放行
 * hsla，OpenLayers/ArcGIS 版不放行，同一个颜色值在不同引擎下可能被
 * 清洗或放行）。统一收敛到本模块：一处修改，三引擎同步生效。
 *
 * 新增共享工具前先确认它在三个引擎下语义一致；引擎专属逻辑请留在
 * 各引擎文件内，不要为了"看起来公共"而强行上提。
 */

/** 控件/图标可停靠的角落方位。 */
export type CornerPosition =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

/**
 * 校验颜色字符串是否是安全的 CSS 颜色字面量（hex / 关键字 / rgb(a) /
 * hsl(a)），非法值回退为默认蓝 "#3388ff"。该值会被嵌入内联 SVG/DOM，
 * 必须先经白名单清洗；三个引擎共用同一份白名单，禁止各自放宽。
 */
export function sanitizeCssColor(value: string): string {
  return /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgba?\([\d.,\s%]+\)|hsla?\([\d.,\s%deg]+\))$/.test(
    value.trim(),
  )
    ? value.trim()
    : '#3388ff';
}

/**
 * 归一化角落方位字符串：去掉空白/下划线/连字符并转小写后匹配，
 * 如 "Top_Left" → "top-left"；无法识别时回退 "top-right"。
 */
export function normalizeCorner(position: string): CornerPosition {
  const compact = position.trim().toLowerCase().replace(/[\s_-]/g, '');
  switch (compact) {
    case 'topleft':
      return 'top-left';
    case 'bottomleft':
      return 'bottom-left';
    case 'bottomright':
      return 'bottom-right';
    default:
      return 'top-right';
  }
}
