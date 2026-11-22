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

/**
 * 判断值是否为非空普通对象（不含 null 与数组），用于收敛 unknown 类型的
 * 鸭子类型访问。取三份引擎实现中更严格的语义（排除数组）——对现有调用点
 * （探测 map/layer/popup 的方法组合）行为等价。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 通过 JSON 序列化/反序列化做一次深拷贝（仅适用于可 JSON 化的数据）。
 */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 构造一个空的 GeoJSON FeatureCollection，作为数据源的初始值/兜底返回。 */
export function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * 转义 HTML 特殊字符，防止模型生成的弹窗/标注文本被当作 HTML 注入 DOM。
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 解析后的 RGBA 颜色：r/g/b 为 0–255，a 为 0–1。 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * 把 CSS 颜色字符串解析为 Rgba。支持 #RGB/#RGBA/#RRGGBB/#RRGGBBAA 的缩写
 * 与完整 hex（大小写均可），以及 rgb()/rgba()（兼容逗号/空格分隔、百分比
 * 通道与斜杠 alpha）。无法解析时返回 null。
 *
 * 收敛自 openlayers/arcgis 两份同语义实现；leaflet 的旧 parseColor 不支持
 * 大小写 hex 与百分比分量，本实现是其超集，行为只放宽不收紧。
 */
export function parseCssColor(value: unknown): Rgba | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  // 先尝试 hex 形式（大小写均可）。
  const hex = /^#([0-9a-f]{3,8})$/i.exec(trimmed);
  if (hex) {
    const digits = hex[1];
    // 单位 digit 重复成两位展开。
    const expand = (pair: string): number =>
      pair.length === 1 ? parseInt(pair.repeat(2), 16) : parseInt(pair, 16);
    // 3/4 位缩写形式逐位展开；第 4 位是 alpha。
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits.slice(0, 1)),
        g: expand(digits.slice(1, 2)),
        b: expand(digits.slice(2, 3)),
        a: digits.length === 4 ? expand(digits.slice(3, 4)) / 255 : 1,
      };
    }
    // 6/8 位完整形式两两解析；第 4 组是 alpha。
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: expand(digits.slice(0, 2)),
        g: expand(digits.slice(2, 4)),
        b: expand(digits.slice(4, 6)),
        a: digits.length === 8 ? expand(digits.slice(6, 8)) / 255 : 1,
      };
    }
    // hex 长度落在 5/7 等非法值上。
    return null;
  }
  // 再尝试 rgb()/rgba() 函数形式：分隔符兼容逗号、空白与斜杠
  // （"rgb(1 2 3 / 50%)"）。
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(trimmed);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter((part) => part.length > 0);
    // 百分比通道换算到 0–255；缺参返回 NaN，交给后面的统一非法判定。
    const number = (part: string | undefined): number => {
      if (part === undefined) {
        return Number.NaN;
      }
      return part.endsWith('%')
        ? (parseFloat(part) / 100) * 255
        : parseFloat(part);
    };
    const r = number(parts[0]);
    const g = number(parts[1]);
    const b = number(parts[2]);
    const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
    // 任一分量非有限数即视为解析失败。
    if ([r, g, b, a].some((component) => !Number.isFinite(component))) {
      return null;
    }
    return { r, g, b, a };
  }
  return null;
}
