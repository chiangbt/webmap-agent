/**
 * GeoAgent 控件的 Leaflet 宿主支持。
 *
 * GeoAgent 工具通过 MapLibre GL JS 的 API 表面驱动地图：
 * Style Spec 的 source/layer、setStyle、queryRenderedFeatures 等。
 * Leaflet 完全没有这些概念 —— 它的图层是对象（TileLayer、GeoJSON、
 * Marker），也不存在 style 文档。
 *
 * LeafletMapShim 负责弥合这一差距。它维护一份类 Style Spec 的
 * source/layer 注册表，把它们物化成真实的 Leaflet 图层，并暴露工具
 * 会调用的 maplibregl.Map API 子集。Leaflet 确实缺失的能力（globe
 * projection、terrain、sky、3D buildings、canvas 截图）会抛出明确的
 * 错误而不是静默失败 —— 与 README 为 mapbox-gl 宿主约定的契约一致。
 *
 * 本文件不 import Leaflet；由宿主传入自己的命名空间：
 *
 *   import L from "leaflet";
 *   new GeoAgentControl({ mapEngine: { kind: "leaflet", namespace: L } })
 *   addGeoAgentToLeafletMap(control, map); // Leaflet 没有 map.addControl
 */

import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoAgentControl } from "../control/GeoAgentControl";
import { normalizeCorner, sanitizeCssColor } from "./shared";

/* -------------------------------------------------------------------------- */
/* 结构化的 Leaflet 类型（shim 从不直接 import leaflet 本体）                 */
/* -------------------------------------------------------------------------- */

/**
 * Leaflet 经纬度坐标的鸭子类型结构，对应 L.LatLng。
 */
export interface LeafletLatLngLike {
  lat: number;
  lng: number;
}

/**
 * Leaflet 像素坐标的鸭子类型结构，对应 L.Point（x 向右、y 向下）。
 */
export interface LeafletPointLike {
  x: number;
  y: number;
}

/**
 * Leaflet 地理边界框的鸭子类型结构，对应 L.LatLngBounds 的四个取值方法。
 */
export interface LeafletBoundsLike {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}

/**
 * shim 依赖的 Leaflet 地图实例最小接口（结构化子集）。
 * 只声明工具层实际调用的方法，参数/返回值用 unknown 放宽，
 * 使宿主传入的真实 L.Map 可直接赋值兼容。
 */
export interface LeafletMapLike {
  getContainer(): HTMLElement;
  getCenter(): LeafletLatLngLike;
  getZoom(): number;
  getBounds(): LeafletBoundsLike;
  getSize(): LeafletPointLike;
  setView(center: unknown, zoom?: number, options?: unknown): unknown;
  flyTo(center: unknown, zoom?: number, options?: unknown): unknown;
  fitBounds(bounds: unknown, options?: unknown): unknown;
  setZoom(zoom: number, options?: unknown): unknown;
  project(latlng: unknown, zoom?: number): LeafletPointLike;
  latLngToContainerPoint(latlng: unknown): LeafletPointLike;
  containerPointToLatLng(point: unknown): LeafletLatLngLike;
  addLayer(layer: unknown): unknown;
  removeLayer(layer: unknown): unknown;
  hasLayer(layer: unknown): boolean;
  eachLayer(method: (layer: unknown) => void): unknown;
  createPane(name: string, container?: HTMLElement): HTMLElement;
  removePane?(name: string): void;
  getPane(name: string): HTMLElement | undefined;
  whenReady(callback: () => void): unknown;
  on(type: string, fn: (event?: unknown) => void, context?: unknown): unknown;
  once(type: string, fn: (event?: unknown) => void, context?: unknown): unknown;
  off(type: string, fn?: (event?: unknown) => void, context?: unknown): unknown;
  fire(type: string, data?: unknown): unknown;
}

/**
 * Leaflet 图层（L.Layer）的最小鸭子类型：能加入地图、能自我移除。
 */
interface LeafletLayerLike {
  addTo(map: unknown): unknown;
  remove(): unknown;
}

/**
 * 瓦片图层（L.TileLayer）的最小鸭子类型：额外支持 setOpacity。
 */
interface TileLayerLike extends LeafletLayerLike {
  setOpacity(opacity: number): unknown;
}

/**
 * GeoJSON 图层（L.GeoJSON）的最小鸭子类型：支持追加/清空内部要素。
 */
interface GeoJSONLayerLike extends LeafletLayerLike {
  addData(data: unknown): unknown;
  clearLayers(): unknown;
}

/**
 * 标注点（L.Marker）的最小鸭子类型：支持移动位置、绑定弹窗、取 DOM 元素。
 */
interface MarkerLike extends LeafletLayerLike {
  setLatLng(latlng: unknown): unknown;
  bindPopup(popup: unknown): unknown;
  getElement(): HTMLElement | undefined;
}

/**
 * 弹窗（L.Popup）的最小鸭子类型：仅需支持 setContent。
 */
interface PopupLike {
  setContent(content: unknown): unknown;
}

/**
 * shim 实际用到的 Leaflet 工厂方法集合（即宿主传入的 L 命名空间子集）。
 * shim 不 import leaflet，而是通过该结构以鸭子类型调用 L.tileLayer 等工厂。
 */
interface LeafletFactory {
  tileLayer(url: string, options?: Record<string, unknown>): TileLayerLike;
  geoJSON(data?: unknown, options?: Record<string, unknown>): GeoJSONLayerLike;
  marker(latlng: [number, number], options?: Record<string, unknown>): MarkerLike;
  circleMarker(
    latlng: [number, number],
    options?: Record<string, unknown>,
  ): LeafletLayerLike;
  popup(options?: Record<string, unknown>): PopupLike;
  divIcon(options: Record<string, unknown>): unknown;
  imageOverlay(
    url: string,
    bounds: unknown,
    options?: Record<string, unknown>,
  ): TileLayerLike;
}

/**
 * asLeafletFactory 校验宿主命名空间时必须存在的工厂方法名清单。
 */
const REQUIRED_LEAFLET_FACTORIES = [
  "tileLayer",
  "geoJSON",
  "marker",
  "circleMarker",
  "popup",
  "divIcon",
  "imageOverlay",
] as const;

/**
 * 把宿主传入的命名空间校验并收窄为 LeafletFactory。
 * 逐个检查必需的工厂方法是否存在且为函数，缺任何一个都直接抛错，
 * 避免到物化图层时才在深处失败。
 * @param namespace 宿主传入的 Leaflet 命名空间对象（通常是 import L from "leaflet" 的 L）
 * @returns 校验通过后的 LeafletFactory
 */
function asLeafletFactory(namespace: Record<string, unknown>): LeafletFactory {
  // 逐项校验必需的工厂方法；缺失即抛错，并指明具体缺少哪个 L.* 方法。
  for (const key of REQUIRED_LEAFLET_FACTORIES) {
    if (typeof namespace[key] !== "function") {
      throw new Error(
        `mapEngine.namespace for the Leaflet engine must be the Leaflet factory object (L); missing L.${key}().`,
      );
    }
  }
  return namespace as unknown as LeafletFactory;
}

/** 鸭子类型探测：该值是否像一个 Leaflet 地图实例。 */
export function isLeafletMap(value: unknown): value is LeafletMapLike {
  if (!isRecord(value)) {
    return false;
  }
  // 探测 Leaflet 特有的方法组合（MapLibre / OpenLayers 地图均不具备），
  // 四个特征方法同时存在才判定为 Leaflet 地图。
  return (
    typeof value.setView === "function" &&
    typeof value.addLayer === "function" &&
    typeof value.latLngToContainerPoint === "function" &&
    typeof value.getCenter === "function"
  );
}

/* -------------------------------------------------------------------------- */
/* 小工具函数                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 判断值是否为非空对象（不含 null），用于收敛 unknown 类型的鸭子类型访问。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 通过 JSON 序列化/反序列化做一次深拷贝（仅适用于可 JSON 化的数据）。
 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 转义 HTML 特殊字符，防止模型生成的弹窗/标注文本被当作 HTML 注入 DOM。
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


/**
 * 构造一个空的 GeoJSON FeatureCollection，作为数据源的初始值/兜底返回。
 */
function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/**
 * 把任意输入归一化为 GeoJSON.FeatureCollection：
 * - 已是 FeatureCollection 且 features 为数组：原样返回；
 * - 是单个 Feature：包装成单要素的 FeatureCollection；
 * - 是裸几何（type 为 Point 等）：包装成 properties 为空的 Feature；
 * - 其余情况返回空 FeatureCollection。
 * @param input 任意来源的 GeoJSON 数据
 * @returns 归一化后的 FeatureCollection
 */
export function normalizeFeatureCollection(input: unknown): GeoJSON.FeatureCollection {
  if (!isRecord(input)) {
    return emptyFeatureCollection();
  }
  const value = input as { type?: unknown; features?: unknown };
  // 已经是合法 FeatureCollection：直接原样返回，不做拷贝。
  if (value.type === "FeatureCollection" && Array.isArray(value.features)) {
    return input as unknown as GeoJSON.FeatureCollection;
  }
  // 单个 Feature：包一层 FeatureCollection。
  if (value.type === "Feature") {
    return {
      type: "FeatureCollection",
      features: [input as unknown as GeoJSON.Feature],
    };
  }
  // 裸几何对象（如 {type:"Point",...}）：包成无属性的 Feature。
  if (typeof value.type === "string") {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: input as unknown as GeoJSON.Geometry,
          properties: {},
        },
      ],
    };
  }
  // 无法识别的结构：返回空集合。
  return emptyFeatureCollection();
}

/**
 * 把 Multi* 几何类型归约到对应的基础类型，供命中测试等按基础类型分支处理。
 * @param type GeoJSON 几何类型名
 * @returns Point/LineString/Polygon 等基础类型名（其他类型原样返回）
 */
export function normalizeGeometryType(type: string): string {
  switch (type) {
    case "MultiPoint":
      return "Point";
    case "MultiLineString":
      return "LineString";
    case "MultiPolygon":
      return "Polygon";
    default:
      return type;
  }
}

/* -------------------------------------------------------------------------- */
/* MapLibre 表达式子集求值器                                                   */
/* -------------------------------------------------------------------------- */

/**
 * MapLibre 表达式求值上下文：提供 get/has 取值的属性表、
 * geometry-type、zoom 与要素 id。
 */
export interface ExpressionContext {
  properties?: Record<string, unknown> | null;
  geometryType?: string;
  zoom?: number;
  id?: unknown;
}

/**
 * 判断表达式结果是否为"真值"，语义对齐 MapLibre：
 * false / null / undefined 为假，NaN 为假，其余（含 0 与空串）为真。
 */
export function expressionTruthy(value: unknown): boolean {
  if (value === false || value === null || value === undefined) {
    return false;
  }
  // 与 MapLibre 一致：NaN 视为假，0 与空字符串视为真。
  if (typeof value === "number") {
    return !Number.isNaN(value);
  }
  return true;
}

/**
 * 表达式比较中的宽松相等：严格相等，或双方都为 null/undefined 时相等。
 */
function looseEquals(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  return left == null && right == null;
}

/**
 * 数值/字符串的大小比较，返回 -1/0/1；
 * 类型不可比时返回 NaN（调用方的各比较运算符都会判为不成立）。
 */
function compareValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  // 类型不一致（或非数值/字符串）时不可比较，返回 NaN 让比较运算全部失败。
  return Number.NaN;
}

/**
 * parseColor 的解析结果：各通道 0-255 的 RGB 值与 0-1 的 alpha。
 */
interface RgbColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * 把 CSS 颜色字符串解析为 RgbColor，供 interpolate 做颜色插值。
 * 支持 3/4/6/8 位 hex 与 rgb()/rgba() 函数形式；无法解析时返回 null。
 */
function parseColor(value: unknown): RgbColor | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  // 先尝试 hex 形式（#rgb/#rgba/#rrggbb/#rrggbbaa）。
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(text);
  if (hex) {
    const digits = hex[1];
    // 3/4 位缩写：每位重复两次展开成完整字节。
    if (digits.length === 3 || digits.length === 4) {
      const parts = digits.split("").map((digit) => parseInt(digit + digit, 16));
      return {
        r: parts[0],
        g: parts[1],
        b: parts[2],
        a: parts.length > 3 ? parts[3] / 255 : 1,
      };
    }
    // 6/8 位完整形式：两两一组解析各通道。
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: parseInt(digits.slice(0, 2), 16),
        g: parseInt(digits.slice(2, 4), 16),
        b: parseInt(digits.slice(4, 6), 16),
        a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }
  // 再尝试 rgb()/rgba() 函数形式。
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return {
        r: parts[0],
        g: parts[1],
        b: parts[2],
        a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1,
      };
    }
  }
  return null;
}

/**
 * 把 RgbColor 格式化为 "#rrggbb" 字符串（丢弃 alpha，各通道钳制到 0-255）。
 */
function formatColor(color: RgbColor): string {
  const clamp = (value: number): number =>
    Math.max(0, Math.min(255, Math.round(value)));
  const toHex = (value: number): string =>
    clamp(value).toString(16).padStart(2, "0");
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

/**
 * 按 ratio 对两个 RgbColor 做逐通道线性插值（含 alpha）。
 */
function lerpColor(from: RgbColor, to: RgbColor, ratio: number): RgbColor {
  return {
    r: from.r + (to.r - from.r) * ratio,
    g: from.g + (to.g - from.g) * ratio,
    b: from.b + (to.b - from.b) * ratio,
    a: from.a + (to.a - from.a) * ratio,
  };
}

/**
 * 求值工具层会用到的 MapLibre Style Spec 表达式子集与旧式 filter
 * （geometry-type / get / has / step / interpolate / 比较运算等）。
 * 未知的运算符返回 undefined，与"paint 属性未命中时回退默认值"的行为一致。
 */
export function evaluateExpression(
  expression: unknown,
  context: ExpressionContext,
): unknown {
  // 非数组（字面量）或空表达式：原样返回。
  if (!Array.isArray(expression) || expression.length === 0) {
    return expression;
  }
  const [operator, ...args] = expression;
  // 首元素不是运算符字符串：按字面量原样返回。
  if (typeof operator !== "string") {
    return expression;
  }
  // 递归求值当前上下文下的子表达式。
  const evaluate = (value: unknown): unknown =>
    evaluateExpression(value, context);
  // 求值并转数字，失败时回退到给定默认值。
  const toNumber = (value: unknown, fallback = 0): number => {
    const parsed = Number(evaluate(value));
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  switch (operator) {
    case "literal":
      return args[0];
    case "get": {
      // 带第二参数的取值对象形式（["get","key",obj]）；否则从要素属性取。
      if (args.length >= 2 && isRecord(args[1])) {
        return (args[1] as Record<string, unknown>)[String(args[0])];
      }
      return context.properties?.[String(args[0])];
    }
    case "has": {
      // 同 get：优先从显式对象取，否则查要素属性表。
      if (args.length >= 2 && isRecord(args[1])) {
        return (args[1] as Record<string, unknown>)[String(args[0])] !== undefined;
      }
      return context.properties?.[String(args[0])] !== undefined;
    }
    case "properties":
      return context.properties ?? {};
    case "geometry-type":
      return context.geometryType ?? "";
    case "id":
      return context.id ?? null;
    case "zoom":
      return context.zoom ?? 0;
    case "pi":
      return Math.PI;
    case "e":
      return Math.E;
    case "!":
      return !expressionTruthy(evaluate(args[0]));
    case "all":
      return args.every((arg) => expressionTruthy(evaluate(arg)));
    case "any":
      return args.some((arg) => expressionTruthy(evaluate(arg)));
    case "==":
    case "!=":
    case ">":
    case ">=":
    case "<":
    case "<=": {
      // 旧式 filter 直接用属性名与字面量比较：["==", "name", "foo"]。
      // 表达式式 filter 会包裹取值输入：["==", ["get", "name"], "foo"]。
      // 第一个操作数是字符串即视为旧式 filter。
      const legacy = typeof args[0] === "string";
      const left = legacy
        ? context.properties?.[args[0] as string]
        : evaluate(args[0]);
      const right = legacy ? args[1] : evaluate(args[1]);
      switch (operator) {
        case "==":
          return looseEquals(left, right);
        case "!=":
          return !looseEquals(left, right);
        case ">":
          return compareValues(left, right) > 0;
        case ">=":
          return compareValues(left, right) >= 0;
        case "<":
          return compareValues(left, right) < 0;
        default:
          return compareValues(left, right) <= 0;
      }
    }
    case "in": {
      // 与 "==" / "!in" 同一约定：第一个操作数为字符串即旧式 filter，
      // 直接按属性名取值，其余操作数是字面量集合 ["in", "prop", v1, v2...]。
      const legacy = typeof args[0] === "string";
      const needle = legacy
        ? context.properties?.[args[0] as string]
        : evaluate(args[0]);
      const haystack = legacy ? args.slice(1) : [evaluate(args[1])];
      // 现代形式第二个操作数为数组时判断成员包含；为字符串且 needle 也是
      // 字符串时判断子串；其余形式不匹配。
      if (!legacy) {
        const value = haystack[0];
        if (Array.isArray(value)) {
          return value.some((item) => looseEquals(item, needle));
        }
        if (typeof value === "string" && typeof needle === "string") {
          return value.includes(needle);
        }
        return false;
      }
      return haystack.some((item) => looseEquals(item, needle));
    }
    case "!has": {
      // 旧式否定存在性 filter：["!has", "prop"]。
      return context.properties?.[String(args[0])] === undefined;
    }
    case "!in": {
      // 旧式否定成员 filter：["!in", "prop", v1, v2, ...]。
      const legacy = typeof args[0] === "string";
      const needle = legacy ? context.properties?.[args[0] as string] : evaluate(args[0]);
      const haystack = legacy ? args.slice(1) : [evaluate(args[1])];
      return !haystack.some((item) =>
        looseEquals(legacy ? item : evaluate(item), needle),
      );
    }
    case "nin": {
      const needle = evaluate(args[0]);
      const haystack = evaluate(args[1]);
      if (Array.isArray(haystack)) {
        return !haystack.some((item) => looseEquals(item, needle));
      }
      return true;
    }
    case "case": {
      // 成对遍历 条件/结果：首个条件为真的分支即返回其结果。
      for (let index = 0; index + 1 < args.length; index += 2) {
        if (expressionTruthy(evaluate(args[index]))) {
          return evaluate(args[index + 1]);
        }
      }
      // 参数个数为奇数表示带兜底分支；否则无命中返回 null。
      return args.length % 2 === 1 ? evaluate(args[args.length - 1]) : null;
    }
    case "match": {
      const input = evaluate(args[0]);
      // 标签可以是单个值或数组：命中任一标签即返回对应输出。
      for (let index = 1; index + 1 < args.length; index += 2) {
        const labels: unknown[] = Array.isArray(args[index])
          ? (args[index] as unknown[])
          : [args[index]];
        if (labels.some((label) => looseEquals(label, input))) {
          return evaluate(args[index + 1]);
        }
      }
      // 参数个数为偶数表示带兜底输出；否则返回 null。
      return args.length % 2 === 0 ? evaluate(args[args.length - 1]) : null;
    }
    case "coalesce": {
      // 依次求值，返回第一个非 null/undefined 的结果。
      for (const arg of args) {
        const value = evaluate(arg);
        if (value !== null && value !== undefined) {
          return value;
        }
      }
      return null;
    }
    case "step": {
      const input = toNumber(args[0]);
      // 输出从首个 stop 之前的基线值开始。
      let output = evaluate(args[1]);
      // 阶梯插值：input 越过某个 stop 阈值才更新输出；未越过即停在当前值。
      for (let index = 2; index + 1 < args.length; index += 2) {
        const stop = Number(args[index]);
        if (!Number.isFinite(stop) || input < stop) {
          break;
        }
        output = evaluate(args[index + 1]);
      }
      return output;
    }
    case "interpolate": {
      const input = toNumber(args[1]);
      const stops: Array<[number, unknown]> = [];
      // 收集所有数值有效的 stop 点对。
      for (let index = 2; index + 1 < args.length; index += 2) {
        const stop = Number(args[index]);
        if (Number.isFinite(stop)) {
          stops.push([stop, args[index + 1]]);
        }
      }
      // 没有任何有效 stop：无法插值。
      if (stops.length === 0) {
        return null;
      }
      // 低于最小 stop：直接取首段输出。
      if (input <= stops[0][0]) {
        return evaluate(stops[0][1]);
      }
      const last = stops[stops.length - 1];
      // 高于最大 stop：直接取末段输出。
      if (input >= last[0]) {
        return evaluate(last[1]);
      }
      for (let index = 0; index + 1 < stops.length; index += 1) {
        const [stop0, out0] = stops[index];
        const [stop1, out1] = stops[index + 1];
        // 找到 input 所在的相邻 stop 区间。
        if (input >= stop0 && input <= stop1) {
          const value0 = evaluate(out0);
          const value1 = evaluate(out1);
          // 区间内归一化比例（零宽区间取 0）。
          const ratio = stop1 === stop0 ? 0 : (input - stop0) / (stop1 - stop0);
          const number0 = Number(value0);
          const number1 = Number(value1);
          // 两侧输出都是数值：按比例线性插值。
          if (Number.isFinite(number0) && Number.isFinite(number1)) {
            return number0 + (number1 - number0) * ratio;
          }
          const color0 = parseColor(value0);
          const color1 = parseColor(value1);
          // 两侧输出都是颜色：做 RGB 逐通道插值。
          if (color0 && color1) {
            return formatColor(lerpColor(color0, color1, ratio));
          }
          // 其他类型输出：就近取值。
          return ratio < 0.5 ? value0 : value1;
        }
      }
      return evaluate(last[1]);
    }
    case "+":
      return args.reduce<number>((sum, arg) => sum + toNumber(arg), 0);
    case "*":
      return args.reduce<number>(
        (product, arg) => product * toNumber(arg, 1),
        1,
      );
    case "-":
      return args.length === 1 ? -toNumber(args[0]) : toNumber(args[0]) - toNumber(args[1]);
    case "/":
      return toNumber(args[0]) / toNumber(args[1]);
    case "%": {
      const divisor = toNumber(args[1]);
      // 除零保护：直接返回 0。
      return divisor === 0 ? 0 : toNumber(args[0]) % divisor;
    }
    case "min":
      return Math.min(...args.map((arg) => toNumber(arg)));
    case "max":
      return Math.max(...args.map((arg) => toNumber(arg)));
    case "abs":
      return Math.abs(toNumber(args[0]));
    case "round":
      return Math.round(toNumber(args[0]));
    case "floor":
      return Math.floor(toNumber(args[0]));
    case "ceil":
      return Math.ceil(toNumber(args[0]));
    case "to-number": {
      const parsed = Number(evaluate(args[0]));
      return Number.isFinite(parsed) ? parsed : null;
    }
    case "to-string": {
      const value = evaluate(args[0]);
      return value == null ? "" : String(value);
    }
    case "to-boolean":
      return expressionTruthy(evaluate(args[0]));
    case "to-color": {
      const value = evaluate(args[0]);
      return typeof value === "string" ? value : null;
    }
    case "concat":
      return args.map((arg) => String(evaluate(arg) ?? "")).join("");
    case "length": {
      const value = evaluate(args[0]);
      return Array.isArray(value) || typeof value === "string"
        ? value.length
        : 0;
    }
    case "at": {
      const value = evaluate(args[1]);
      const index = toNumber(args[0]);
      return Array.isArray(value) ? (value[index] ?? null) : null;
    }
    case "slice": {
      const value = evaluate(args[0]);
      const start = toNumber(args[1]);
      const end = args.length > 2 ? toNumber(args[2]) : undefined;
      if (Array.isArray(value)) {
        return value.slice(start, end);
      }
      if (typeof value === "string") {
        return value.slice(start, end);
      }
      return null;
    }
    default:
      // 未知运算符：返回 undefined，由调用方回退默认样式。
      return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Grid 聚类（Leaflet 没有原生的 cluster source）                             */
/* -------------------------------------------------------------------------- */

/**
 * 把点数缩写为聚类标签文本：≥1 万按 "12k" 取整，≥1 千保留一位小数，其余原样。
 */
function abbreviateCount(count: number): string {
  if (count >= 10000) {
    return `${Math.round(count / 1000)}k`;
  }
  if (count >= 1000) {
    return `${Math.round(count / 100) / 10}k`;
  }
  return String(count);
}

/**
 * 对 Point 要素做贪心网格聚类，行为足够贴近 maplibre-gl 的 cluster source
 * 以支撑聚类工具：聚合点带 point_count / point_count_abbreviated 属性，
 * 单点原样透传；非 Point 要素一律原样透传。
 */
export function computeClusteredFeatures(
  features: GeoJSON.Feature[],
  radiusPx: number,
  project: (lat: number, lng: number) => LeafletPointLike,
): GeoJSON.Feature[] {
  // 半径非法（NaN 或 <=0）时不聚类，全部原样返回。
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) {
    return features;
  }
  // 网格边长即聚类半径（像素）。
  const cell = radiusPx;
  const clusters: Array<{
    x: number;
    y: number;
    latSum: number;
    lngSum: number;
    count: number;
    first: GeoJSON.Feature;
  }> = [];
  // 网格桶：键为 "cellX:cellY"，值为该格内聚类在 clusters 中的下标。
  const grid = new Map<string, number[]>();
  // 无法参与聚类的要素（非 Point / 坐标非法）收集到这里。
  const passThrough: GeoJSON.Feature[] = [];

  for (const feature of features) {
    const geometry = feature.geometry;
    // 只聚合 Point 要素，其余直接透传。
    if (!geometry || geometry.type !== "Point") {
      passThrough.push(feature);
      continue;
    }
    const [lng, lat] = geometry.coordinates as [number, number];
    // 坐标非法的点无法投影，也走透传。
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      passThrough.push(feature);
      continue;
    }
    // 投影到当前缩放级别的屏幕像素坐标。
    const point = project(lat, lng);
    const cellX = Math.floor(point.x / cell);
    const cellY = Math.floor(point.y / cell);
    // 在 3x3 邻域内寻找距离最近的已有聚类。
    let bestIndex = -1;
    let bestDistance = radiusPx * radiusPx;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const indices = grid.get(`${cellX + dx}:${cellY + dy}`);
        if (!indices) {
          continue;
        }
        for (const index of indices) {
          const cluster = clusters[index];
          // 与聚类质心的平方距离（避免开方）。
          const distance =
            (cluster.x - point.x) * (cluster.x - point.x) +
            (cluster.y - point.y) * (cluster.y - point.y);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
          }
        }
      }
    }
    // 命中已有聚类：把该点并入，质心按计数加权平移。
    if (bestIndex >= 0) {
      const cluster = clusters[bestIndex];
      cluster.x = (cluster.x * cluster.count + point.x) / (cluster.count + 1);
      cluster.y = (cluster.y * cluster.count + point.y) / (cluster.count + 1);
      cluster.count += 1;
      cluster.latSum += lat;
      cluster.lngSum += lng;
    } else {
      // 附近没有聚类：以该点为中心新建聚类，并登记到网格桶。
      const index = clusters.length;
      clusters.push({
        x: point.x,
        y: point.y,
        latSum: lat,
        lngSum: lng,
        count: 1,
        first: feature,
      });
      const key = `${cellX}:${cellY}`;
      const bucket = grid.get(key);
      if (bucket) {
        bucket.push(index);
      } else {
        grid.set(key, [index]);
      }
    }
  }

  // 透传要素排在前面，随后追加聚类结果。
  const result: GeoJSON.Feature[] = [...passThrough];
  for (const cluster of clusters) {
    // 单点聚类还原为原始 Feature，不产生聚合属性。
    if (cluster.count === 1) {
      result.push(cluster.first);
      continue;
    }
    // 多点聚类：以平均经纬度为质心，叠加 maplibre 风格的计数属性。
    result.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [
          cluster.lngSum / cluster.count,
          cluster.latSum / cluster.count,
        ],
      },
      properties: {
        // 保留首个成员的原有属性，再叠加聚类标记。
        ...(isRecord(cluster.first.properties)
          ? (cluster.first.properties as Record<string, unknown>)
          : {}),
        cluster: true,
        point_count: cluster.count,
        point_count_abbreviated: abbreviateCount(cluster.count),
      },
    });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* 底图解析                                                                    */
/* -------------------------------------------------------------------------- */

/** OpenStreetMap 栅格瓦片配置，多个内置底图别名共用这一份。 */
const OSM_TILES = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "&copy; OpenStreetMap contributors",
};
/** CARTO 系瓦片（positron/dark/voyager）共用的版权信息。 */
const CARTO_ATTRIBUTION = "&copy; OpenStreetMap contributors &copy; CARTO";

/**
 * Leaflet 无法渲染 MapLibre 的矢量 style URL（DEFAULT_BASEMAPS 的取值）。
 * 已知底图名/URL 映射到等价的 raster XYZ 瓦片；其余输入必须是
 * {z}/{x}/{y} 模板，或带 raster source 的 style 文档。
 */
export const LEAFLET_BASEMAP_TILES: Record<
  string,
  { url: string; attribution: string }
> = {
  liberty: OSM_TILES,
  "https://tiles.openfreemap.org/styles/liberty": OSM_TILES,
  osm: OSM_TILES,
  openstreetmap: OSM_TILES,
  demotiles: OSM_TILES,
  "https://demotiles.maplibre.org/style.json": OSM_TILES,
  positron: {
    url: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    attribution: CARTO_ATTRIBUTION,
  },
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json": {
    url: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    attribution: CARTO_ATTRIBUTION,
  },
  dark: {
    url: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    attribution: CARTO_ATTRIBUTION,
  },
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json": {
    url: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    attribution: CARTO_ATTRIBUTION,
  },
  voyager: {
    url: "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    attribution: CARTO_ATTRIBUTION,
  },
  "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json": {
    url: "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    attribution: CARTO_ATTRIBUTION,
  },
};

/**
 * 把 setStyle 的 style 参数解析为 Leaflet 可渲染的 XYZ 瓦片配置。
 * 接受：内置底图别名（大小写不敏感）、{z}/{x}/{y} URL 模板、
 * 带 raster source 的 style 文档对象。
 * @param style 底图名称、URL 或 Style Spec 文档
 * @param engineName 错误信息中显示的引擎名
 * @returns 瓦片 URL 与 attribution
 * @throws 无法解析出可渲染瓦片时抛出带指引信息的错误
 */
export function resolveBasemapStyle(
  style: unknown,
  engineName = "Leaflet",
): {
  url: string;
  attribution: string;
} {
  if (typeof style === "string") {
    const trimmed = style.trim();
    // 字符串输入：先查内置别名表（小写形式优先，再查原样写法）。
    const alias =
      LEAFLET_BASEMAP_TILES[trimmed.toLowerCase()] ??
      LEAFLET_BASEMAP_TILES[trimmed];
    if (alias) {
      return alias;
    }
    // 是 XYZ 模板（含 {z} 且含 {x} 或子域 {s}）：直接作为瓦片 URL 使用。
    if (/\{z\}/.test(trimmed) && (/\{x\}/.test(trimmed) || /\{s\}/.test(trimmed))) {
      return { url: trimmed, attribution: "" };
    }
    // 无法识别的字符串：报错并给出可操作的指引。
    throw new Error(
      `The ${engineName} engine cannot load basemap "${trimmed}". Pass an XYZ raster tile URL template (containing {z}/{x}/{y}), a built-in basemap name (${Object.keys(LEAFLET_BASEMAP_TILES).filter((key) => !key.startsWith("http")).join(", ")}), or a style document with a raster source. Vector styles require maplibre-gl or mapbox-gl.`,
    );
  }
  if (isRecord(style)) {
    // 对象输入：在 style 文档的 sources 中寻找第一个带 tiles URL 的 raster source。
    const sources = isRecord(style.sources) ? style.sources : {};
    for (const source of Object.values(sources)) {
      // 命中 raster source：取其第一个 tiles URL 与 attribution。
      if (
        isRecord(source) &&
        source.type === "raster" &&
        Array.isArray(source.tiles) &&
        typeof source.tiles[0] === "string"
      ) {
        return {
          url: source.tiles[0],
          attribution:
            typeof source.attribution === "string" ? source.attribution : "",
        };
      }
    }
    // 文档里没有 raster source：矢量样式需要 maplibre-gl/mapbox-gl。
    throw new Error(
      `The ${engineName} engine cannot load this style document: no raster source with a tiles URL was found. Vector styles require maplibre-gl or mapbox-gl.`,
    );
  }
  // 既不是字符串也不是对象：参数类型不支持。
  throw new Error(
    `Unsupported style argument for the ${engineName} engine: ${String(style)}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Source / layer 注册表                                                       */
/* -------------------------------------------------------------------------- */

/**
 * shim 注册表中一个 MapLibre 风格图层的条目：
 * spec 为原始样式定义，leaflet 为物化后的 Leaflet 图层（未物化为 null），
 * paneName 为该层专属的 Leaflet pane 名（用 z-index 排序）。
 */
interface ShimLayerEntry {
  spec: Record<string, unknown>;
  leaflet: LeafletLayerLike | null;
  paneName: string | null;
}

/**
 * shim 注册表中的一个 MapLibre 风格数据源。
 * 保存原始 spec 与已加载的 GeoJSON 数据；geojson 且开启 cluster 的数据源
 * 会按当前缩放级别做网格聚类并缓存结果。
 */
class ShimSource {
  readonly id: string;
  readonly type: string;
  readonly cluster: boolean;
  readonly clusterRadius: number;
  readonly clusterMaxZoom: number;
  spec: Record<string, unknown>;
  data: GeoJSON.FeatureCollection = emptyFeatureCollection();
  /** 聚类结果缓存：仅在缩放级别未变时复用。 */
  private clusterCache: { zoom: number; features: GeoJSON.Feature[] } | null =
    null;
  /** 所属的 LeafletMapShim：读取缩放级别、投影点坐标并刷新依赖图层。 */
  private readonly shim: LeafletMapShim;

  constructor(shim: LeafletMapShim, id: string, spec: Record<string, unknown>) {
    this.shim = shim;
    this.id = id;
    this.spec = cloneJson(spec);
    this.type = String(spec.type ?? "unknown");
    // 仅 geojson 数据源支持 cluster 聚类选项。
    this.cluster = this.type === "geojson" && Boolean(spec.cluster);
    this.clusterRadius = Number(spec.clusterRadius ?? 50);
    this.clusterMaxZoom = Number(spec.clusterMaxZoom ?? 14);
    if (this.type === "geojson") {
      const data = spec.data;
      // data 是 URL：异步 fetch，成功后 setData 刷新图层；失败仅告警不中断。
      if (typeof data === "string") {
        void shim
          .fetchGeoJson(data)
          .then((loaded) => this.setData(loaded))
          .catch((error: unknown) => {
            console.warn(
              `Leaflet engine: could not load GeoJSON source "${id}":`,
              error,
            );
          });
      } else {
        // data 是内联对象：直接归一化为 FeatureCollection。
        this.data = normalizeFeatureCollection(data);
      }
    }
  }

  /** 更新数据源数据并刷新所有依赖它的图层。 */
  setData(data: unknown): void {
    this.data = normalizeFeatureCollection(data);
    this.spec.data = data;
    // 数据已变化，聚类缓存随之失效。
    this.clusterCache = null;
    this.shim.refreshLayersForSource(this.id);
  }

  /** 主动使聚类缓存失效（缩放变化时由 shim 调用）。 */
  invalidateClusterCache(): void {
    this.clusterCache = null;
  }

  /**
   * 返回当前缩放级别下应渲染的要素：
   * 非 cluster 数据源直接返回全部数据；cluster 数据源在达到
   * clusterMaxZoom 后返回原始点，否则返回网格聚类结果（带缓存）。
   */
  resolvedFeatures(): GeoJSON.Feature[] {
    if (!this.cluster) {
      return this.data.features;
    }
    const zoom = this.shim.getZoom();
    // 同一缩放级别命中缓存直接复用，避免每次渲染重算聚类。
    if (this.clusterCache && this.clusterCache.zoom === zoom) {
      return this.clusterCache.features;
    }
    // 达到 clusterMaxZoom 后展开为原始点；否则按像素半径聚类。
    const features =
      zoom >= this.clusterMaxZoom
        ? this.data.features
        : computeClusteredFeatures(
            this.data.features,
            this.clusterRadius,
            (lat, lng) => this.shim.projectPoint(lat, lng, zoom),
          );
    this.clusterCache = { zoom, features };
    return features;
  }
}

/* -------------------------------------------------------------------------- */
/* 引擎 shim 本体                                                              */
/* -------------------------------------------------------------------------- */

/** 依赖 GeoJSON 数据源的矢量图层类型清单，物化与命中测试都按此分支。 */
const GEOJSON_LAYER_TYPES = ["fill", "line", "circle", "symbol"];

/**
 * Leaflet 引擎 shim：在真实 L.Map 之上呈现 GeoAgent 工具所需的
 * maplibregl.Map API 子集。
 * 以类 Style Spec 的 source/layer 注册表管理地图内容，把 spec 物化为
 * Leaflet 图层（瓦片层、L.GeoJSON、marker 标注）；Leaflet 确实缺失的
 * 能力（terrain、canvas 截图等）抛出明确错误。
 */
export class LeafletMapShim {
  /** 被包装的真实 Leaflet 地图实例。 */
  private readonly raw: LeafletMapLike;
  /** 宿主命名空间校验后的 Leaflet 工厂方法集合（L）。 */
  private readonly factory: LeafletFactory;
  /** 数据源注册表：id -> ShimSource。 */
  private readonly sources = new Map<string, ShimSource>();
  /** 图层注册表：id -> ShimLayerEntry。 */
  private readonly layers = new Map<string, ShimLayerEntry>();
  /** 图层渲染顺序（自底向上），对应 MapLibre style.layers 的顺序。 */
  private layerOrder: string[] = [];
  /** 宿主自己的底图瓦片层（change_basemap 时替换它而不是无限叠加）。 */
  private baseTileLayer: TileLayerLike | null = null;
  /** 底图专用 pane 名（首次 setStyle 时懒创建）。 */
  private basePaneName: string | null = null;
  /** geoagent 专属 pane 的自增序号，用于生成唯一 pane 名。 */
  private paneSeq = 0;
  /** 地图是否已就绪（whenReady 回调或 _loaded 标记）。 */
  private ready = false;
  /** shim 是否已销毁：销毁后不再触发 style.load 模拟事件。 */
  private disposed = false;
  /** setStyle 挂起的 style.load 模拟定时器 id；destroy 时取消。 */
  private styleLoadTimer: number | null = null;
  /** 以字段保存构造时绑定的 zoomend 监听，destroy() 才能精确解绑。 */
  private readonly zoomHandler = (): void => {
    this.handleZoomChange();
  };

  constructor(map: LeafletMapLike, namespace: Record<string, unknown>) {
    this.raw = map;
    this.factory = asLeafletFactory(namespace);
    let foundBase = false;
    // 遍历宿主已有图层，探测并记住它自己的底图瓦片层。
    this.raw.eachLayer((layer) => {
      // Leaflet 的 TileLayer 暴露 getTileUrl（任何 Leaflet 类都没有
      // getURL 方法）—— 用这一特征探测宿主自己的底图，
      // change_basemap 才能真正替换掉它。
      if (
        !foundBase &&
        isRecord(layer) &&
        typeof (layer as { getTileUrl?: unknown }).getTileUrl === "function"
      ) {
        this.baseTileLayer = layer as unknown as TileLayerLike;
        foundBase = true;
      }
    });
    // 通过 whenReady 与内部 _loaded 标记两个途径判定"已就绪"。
    this.raw.whenReady(() => {
      this.ready = true;
    });
    // 地图已加载完成时 whenReady 也会立即触发，这里先行标记以便同步查询。
    if ((this.raw as unknown as { _loaded?: boolean })._loaded === true) {
      this.ready = true;
    }
    // 缩放结束后需重算聚类并同步图层可见性（minzoom/maxzoom 门控）。
    this.raw.on("zoomend", this.zoomHandler);
  }

  /**
   * 解绑 shim 在地图上注册的监听器。由工具层在销毁时调用；
   * 不解绑的话，对同一张地图重复挂载会每次泄漏一个 handler。
   */
  destroy(): void {
    this.disposed = true;
    this.raw.off("zoomend", this.zoomHandler);
    // 取消未触发的 style.load 模拟定时器，避免销毁后仍向地图 fire 事件。
    if (this.styleLoadTimer !== null) {
      window.clearTimeout(this.styleLoadTimer);
      this.styleLoadTimer = null;
    }
  }

  /** 返回该 shim 背后的真实 Leaflet 地图实例。 */
  getRawMap(): LeafletMapLike {
    return this.raw;
  }

  /* ------------------------- 地图基础 ------------------------- */

  /** 返回地图容器 DOM 元素。 */
  getContainer(): HTMLElement {
    return this.raw.getContainer();
  }

  /** 返回地图中心（Leaflet 的 lat/lng 结构）。 */
  getCenter(): LeafletLatLngLike {
    return this.raw.getCenter();
  }

  /** 返回当前缩放级别。 */
  getZoom(): number {
    return this.raw.getZoom();
  }

  /** 返回当前视野的地理边界框。 */
  getBounds(): LeafletBoundsLike {
    return this.raw.getBounds();
  }

  /** 返回地图容器尺寸（像素）。 */
  getSize(): LeafletPointLike {
    return this.raw.getSize();
  }

  /** Leaflet 核心不支持旋转与倾斜，方位角恒为 0。 */
  getBearing(): number {
    return 0;
  }

  /** Leaflet 核心不支持旋转与倾斜，俯仰角恒为 0。 */
  getPitch(): number {
    return 0;
  }

  /**
   * 地图是否已就绪。优先用内部 ready 标记，
   * 同时兜底读取 Leaflet 私有的 _loaded 标记。
   */
  loaded(): boolean {
    return (
      this.ready ||
      (this.raw as unknown as { _loaded?: boolean })._loaded === true
    );
  }

  /** 把经纬度投影为指定缩放级别（缺省当前级别）下的像素坐标。 */
  projectPoint(lat: number, lng: number, zoom?: number): LeafletPointLike {
    return this.raw.project([lat, lng], zoom);
  }

  /**
   * 无动画跳转到指定中心/缩放级别；未提供的参数保持当前值。
   * @param options center 为 [lng, lat]（MapLibre 顺序）
   */
  jumpTo(options: { center?: [number, number]; zoom?: number }): void {
    // 缺省时取当前中心（MapLibre 用 [lng, lat]，Leaflet 用 [lat, lng]）。
    const center = options.center ?? [
      this.raw.getCenter().lng,
      this.raw.getCenter().lat,
    ];
    // setView 关闭动画实现"跳转"语义。
    this.raw.setView(
      [center[1], center[0]],
      options.zoom ?? this.raw.getZoom(),
      { animate: false },
    );
  }

  /** 飞行动画到指定中心/缩放级别（Leaflet 默认时长）。 */
  flyTo(options: { center?: [number, number]; zoom?: number }): void {
    // 容器尺寸可能已变（面板收起/展开后 Leaflet 并不知道），起飞前刷新，
    // 避免动画按过期尺寸计算终点导致目标点偏离视图中心。
    this.raw.invalidateSize();
    // 缺省参数保持当前值；坐标顺序转换为 Leaflet 的 [lat, lng]。
    const center = options.center ?? [
      this.raw.getCenter().lng,
      this.raw.getCenter().lat,
    ];
    const target: [number, number] = [center[1], center[0]];
    const zoom = options.zoom ?? this.raw.getZoom();
    // 动画结束后无条件把视图中心无动画地钉到目标点：flyTo 的终点按起飞
    // 时的容器尺寸计算，用户中途拖拽、连续调用、尺寸变化都会让最终中心
    // 偏离目标；终态校正保证 marker 永远落在视图正中。
    this.raw.once('moveend', () => {
      this.raw.setView(target, zoom, { animate: false });
    });
    this.raw.flyTo(target, zoom);
  }

  /**
   * 缓动到指定中心/缩放级别。Leaflet 没有 easeTo，
   * 用短时长（0.3s）的 flyTo 近似。
   */
  easeTo(options: { center?: [number, number]; zoom?: number }): void {
    const center = options.center ?? [
      this.raw.getCenter().lng,
      this.raw.getCenter().lat,
    ];
    // 用 0.3 秒的 flyTo 模拟 MapLibre easeTo 的快速缓动（Leaflet duration 单位是毫秒）。
    this.raw.flyTo([center[1], center[0]], options.zoom ?? this.raw.getZoom(), {
      duration: 300,
    });
  }

  /** 直接设置缩放级别。 */
  setZoom(zoom: number): void {
    this.raw.setZoom(zoom);
  }

  /**
   * 把视野适配到给定的经纬度范围。
   * @param corners [[west, south], [east, north]]（MapLibre 的 LngLat 顺序）
   * @param options padding 为四周内边距像素；maxZoom 限制最大放大级别
   */
  fitBounds(
    corners: [[number, number], [number, number]],
    options?: { padding?: number; maxZoom?: number },
  ): void {
    // MapLibre 角点顺序是 [lng, lat]，转成 Leaflet 的 [lat, lng]。
    const [[west, south], [east, north]] = corners;
    // padding 未指定时按 0 处理。
    const padding = typeof options?.padding === "number" ? options.padding : 0;
    const fitOptions: Record<string, unknown> = {
      padding: [padding, padding],
    };
    // 仅在显式传入 maxZoom 时设置，避免覆盖 Leaflet 默认值。
    if (options?.maxZoom != null) {
      fitOptions.maxZoom = options.maxZoom;
    }
    this.raw.fitBounds(
      [
        [south, west],
        [north, east],
      ],
      fitOptions,
    );
  }

  /**
   * 校验投影设置。Leaflet 只支持 Web Mercator；
   * 非 mercator（如 globe）抛出明确错误。
   */
  setProjection(projection: unknown): void {
    // 兼容字符串与 {type:"..."} 两种入参形式。
    const name =
      typeof projection === "string"
        ? projection
        : String((projection as { type?: unknown })?.type ?? "mercator");
    // mercator 即 Leaflet 原生投影，直接放行。
    if (name === "mercator") {
      return;
    }
    throw new Error(
      `The Leaflet engine renders Web Mercator only; projection "${name}" is not supported.`,
    );
  }

  /** Leaflet 只渲染 Web Mercator，恒定返回 mercator。 */
  getProjection(): { type: "mercator" } {
    return { type: "mercator" };
  }

  /* ------------------------- 事件 ------------------------- */

  /** 订阅地图事件，直接透传给真实 Leaflet 地图。 */
  on(type: string, listener: (event?: unknown) => void): this {
    this.raw.on(type, listener);
    return this;
  }

  /**
   * 订阅一次性地图事件。MapLibre 的 "idle" 事件在 Leaflet 中不存在，
   * 用 whenReady 模拟（已就绪时立即触发）。
   */
  once(type: string, listener: (event?: unknown) => void): this {
    // Leaflet 没有 "idle" 事件；MapLibre 侧代码（waitForMapIdle）在每条
    // 命令前都会等待它。用 whenReady 模拟：地图已就绪时立即触发 ——
    // 否则宿主地图未加载完成期间发出的每条命令都要等满整个事件超时。
    if (type === "idle") {
      this.raw.whenReady(() => listener());
      return this;
    }
    this.raw.once(type, listener);
    return this;
  }

  /** 解除事件订阅（listener 缺省时解绑该事件的全部监听）。 */
  off(type: string, listener?: (event?: unknown) => void): this {
    this.raw.off(type, listener);
    return this;
  }

  /** 在真实地图上触发事件，用于向工具层回放 MapLibre 风格的事件。 */
  fire(type: string, data?: Record<string, unknown>): this {
    this.raw.fire(type, data);
    return this;
  }

  /* ------------------------- 样式与底图 ------------------------- */

  /**
   * 更换底图：把 style 解析为 XYZ 配置后，移除旧底图瓦片层并在专用
   * pane 中重建一个新瓦片层（真正替换而非叠加）。
   */
  setStyle(style: unknown): void {
    // 先解析：矢量 style / 无效输入在此直接抛错，不产生半更新状态。
    const resolved = resolveBasemapStyle(style);
    // 存在旧底图时真正替换而不是叠加。
    if (this.baseTileLayer) {
      this.raw.removeLayer(this.baseTileLayer);
      this.baseTileLayer = null;
    }
    // 底图放入独立 pane，保证位于所有 geoagent 图层之下。
    const pane = this.ensureBasePane();
    // maxZoom 设为 24，覆盖 Leaflet 瓦片层默认的 18 上限。
    const tileLayer = this.factory.tileLayer(resolved.url, {
      pane,
      attribution: resolved.attribution,
      maxZoom: 24,
      tileSize: 256,
    });
    this.raw.addLayer(tileLayer);
    this.baseTileLayer = tileLayer;
    // maplibre 在新样式可用后会异步触发 style.load；
    // 这里保持同样的契约，让 waitForMapEvent("style.load") 能正常返回。
    // 定时器以字段保存：重复 setStyle 先取消旧定时器，destroy 时一并取消，
    // 回调内检查 disposed 避免销毁后仍向地图 fire 事件。
    if (this.styleLoadTimer !== null) {
      window.clearTimeout(this.styleLoadTimer);
    }
    this.styleLoadTimer = window.setTimeout(() => {
      this.styleLoadTimer = null;
      if (!this.disposed) {
        this.raw.fire("style.load", {});
      }
    }, 0);
  }

  /**
   * 以 Style Spec 文档的形状回放当前注册表内容：
   * version 8、sources 深拷贝、layers 按 layerOrder 顺序输出。
   */
  getStyle(): {
    version: number;
    sources: Record<string, Record<string, unknown>>;
    layers: Array<Record<string, unknown>>;
  } {
    const sources: Record<string, Record<string, unknown>> = {};
    for (const [id, source] of this.sources) {
      // 深拷贝，避免调用方改动注册表内部状态。
      sources[id] = cloneJson(source.spec);
    }
    return {
      version: 8,
      sources,
      // 按 shim 维护的自底向上顺序输出图层 spec。
      layers: this.layerOrder.map((id) =>
        cloneJson(this.layers.get(id)?.spec ?? { id }),
      ),
    };
  }

  /* ------------------------- 数据源 ------------------------- */

  /** 新增数据源；id 重复时抛错（与 MapLibre 行为一致）。 */
  addSource(id: string, spec: Record<string, unknown>): void {
    if (this.sources.has(id)) {
      throw new Error(`Source already exists: ${id}`);
    }
    this.sources.set(id, new ShimSource(this, id, spec));
  }

  /** 按 id 查找 ShimSource 数据源。 */
  getSource(id: string): ShimSource | undefined {
    return this.sources.get(id);
  }

  /**
   * 删除数据源；仍有图层依赖它时抛错（与 MapLibre 行为一致），
   * 避免依赖方悬空。
   */
  removeSource(id: string): void {
    const source = this.sources.get(id);
    if (!source) {
      throw new Error(`Source not found: ${id}`);
    }
    // 找出所有 spec.source 指向该数据源的图层。
    const dependents = this.layerOrder.filter(
      (layerId) =>
        String(this.layers.get(layerId)?.spec.source ?? "") === id,
    );
    if (dependents.length > 0) {
      throw new Error(
        `Cannot remove source ${id}; active layers depend on it: ${dependents.join(", ")}`,
      );
    }
    this.sources.delete(id);
  }

  /**
   * 拉取远程 GeoJSON。
   * @throws 非 2xx 响应时抛出带状态码的错误
   */
  async fetchGeoJson(url: string): Promise<unknown> {
    const response = await fetch(url);
    // HTTP 失败直接抛错，由调用方决定告警或回退。
    if (!response.ok) {
      throw new Error(
        `Could not fetch GeoJSON (${response.status}) from ${url}`,
      );
    }
    return response.json();
  }

  /** 刷新所有依赖指定数据源的图层（数据更新后重建物化结果）。 */
  refreshLayersForSource(sourceId: string): void {
    for (const id of this.layerOrder) {
      const entry = this.layers.get(id);
      // 只处理 source 指向目标数据源的图层。
      if (!entry || String(entry.spec.source ?? "") !== sourceId) {
        continue;
      }
      this.refreshLayer(entry);
    }
  }

  /* ------------------------- 图层 ------------------------- */

  /**
   * 按 MapLibre 语义新增图层：校验 id/beforeId、创建专属 pane、
   * 物化为 Leaflet 图层并按 beforeId 插入渲染顺序。
   * @param spec MapLibre 风格的 layer 定义
   * @param beforeId 插入到该图层之前；缺省追加到最上层
   */
  addLayer(spec: Record<string, unknown>, beforeId?: string): void {
    // 与 MapLibre 一致：缺少 id 直接抛错。
    const id = String(spec.id ?? "");
    if (!id) {
      throw new Error("addLayer requires layer.id.");
    }
    // id 重复抛错，避免静默覆盖。
    if (this.layers.has(id)) {
      throw new Error(`Layer already exists: ${id}`);
    }
    // MapLibre 的 addLayer 对未知 beforeId 会抛错；这里同样抛错而不是
    // 静默追加，让代理在所有引擎上都能自我纠正。
    if (beforeId && !this.layerOrder.includes(beforeId)) {
      throw new Error(`Cannot add layer ${id}; beforeId not found: ${beforeId}`);
    }
    // 每个图层独占一个 pane，用 z-index 实现精确的图层顺序控制。
    const paneName = `geoagent-pane-${(this.paneSeq += 1)}`;
    this.raw.createPane(paneName);
    const entry: ShimLayerEntry = {
      spec: cloneJson(spec),
      leaflet: null,
      paneName,
    };
    try {
      this.materializeLayer(entry);
    } catch (error) {
      // 物化失败（如不支持的图层类型）时回收已创建的 pane，
      // 避免失败路径在 DOM 上留下孤儿容器。
      this.raw.removePane?.(paneName);
      throw error;
    }
    // 无 beforeId 时追加到末尾（最上层）。
    const insertIndex = beforeId
      ? this.layerOrder.indexOf(beforeId)
      : this.layerOrder.length;
    this.layerOrder.splice(insertIndex, 0, id);
    this.layers.set(id, entry);
    this.assignZIndexes();
    this.syncVisibility(entry);
  }

  /** 返回图层注册表中保存的 spec 引用；图层不存在时返回 undefined。 */
  getLayer(id: string): Record<string, unknown> | undefined {
    return this.layers.get(id)?.spec;
  }

  /** 删除图层：从地图移除物化结果、清理专属 pane 并更新注册表。 */
  removeLayer(id: string): void {
    const entry = this.layers.get(id);
    if (!entry) {
      throw new Error(`Layer not found: ${id}`);
    }
    // 物化结果可能尚未挂到地图上，用 hasLayer 先行判断。
    if (entry.leaflet && this.raw.hasLayer(entry.leaflet)) {
      this.raw.removeLayer(entry.leaflet);
    }
    // pane 也一并移除，避免 DOM 泄漏。
    if (entry.paneName) {
      this.raw.getPane(entry.paneName)?.remove();
    }
    this.layers.delete(id);
    this.layerOrder = this.layerOrder.filter((layerId) => layerId !== id);
  }

  /** 调整图层顺序：移出后按 beforeId 重新插入并重算各 pane 的 z-index。 */
  moveLayer(id: string, beforeId?: string): void {
    if (!this.layers.has(id)) {
      throw new Error(`Layer not found: ${id}`);
    }
    if (beforeId && !this.layers.has(beforeId)) {
      throw new Error(`Layer not found: ${beforeId}`);
    }
    this.layerOrder = this.layerOrder.filter((layerId) => layerId !== id);
    // 无 beforeId 时移动到最上层。
    const insertIndex = beforeId
      ? this.layerOrder.indexOf(beforeId)
      : this.layerOrder.length;
    this.layerOrder.splice(insertIndex, 0, id);
    this.assignZIndexes();
  }

  /**
   * 更新 paint 属性。raster 图层的 raster-opacity 直接走
   * TileLayer.setOpacity；其余属性重物化图层使样式生效。
   */
  setPaintProperty(id: string, property: string, value: unknown): void {
    const entry = this.requireEntry(id);
    // 防御拷贝：外部后续修改传入对象不应影响渲染状态（与 OL shim 一致）。
    const paint = isRecord(entry.spec.paint)
      ? { ...entry.spec.paint }
      : {};
    paint[property] = value;
    entry.spec.paint = paint;
    // 瓦片层透明度可原地生效，无需整层重建。
    if (
      entry.spec.type === "raster" &&
      property === "raster-opacity" &&
      entry.leaflet &&
      typeof (entry.leaflet as TileLayerLike).setOpacity === "function"
    ) {
      (entry.leaflet as TileLayerLike).setOpacity(Number(value));
      return;
    }
    this.refreshLayer(entry);
  }

  /**
   * 更新 layout 属性。visibility 只需增删地图挂载；
   * 其余属性重物化图层生效。
   */
  setLayoutProperty(id: string, property: string, value: unknown): void {
    const entry = this.requireEntry(id);
    // 防御拷贝：与 setPaintProperty 同理，外部对象不应影响渲染状态。
    const layout = isRecord(entry.spec.layout)
      ? { ...entry.spec.layout }
      : {};
    layout[property] = value;
    entry.spec.layout = layout;
    // 可见性切换走挂载/移除路径，成本低。
    if (property === "visibility") {
      this.syncVisibility(entry);
      return;
    }
    this.refreshLayer(entry);
  }

  /** 设置图层 filter；filter 为 null/undefined 时移除过滤条件。 */
  setFilter(id: string, filter: unknown): void {
    const entry = this.requireEntry(id);
    // null/undefined 表示清除 filter（对齐 MapLibre setFilter(null)）。
    if (filter == null) {
      delete entry.spec.filter;
    } else {
      // 防御拷贝：保存外部对象引用会让后续原地修改直接影响渲染状态
      // （与 OL shim 的 cloneJson(filter) 一致）。
      entry.spec.filter = cloneJson(filter);
    }
    this.refreshLayer(entry);
  }

  /* ------------------------- 查询 ------------------------- */

  /**
   * 查询数据源的全部要素（按需应用 filter）。
   * Leaflet 没有对应能力，这里直接在注册表数据上求值。
   */
  querySourceFeatures(
    sourceId: string,
    options?: { sourceLayer?: string; filter?: unknown },
  ): GeoJSON.Feature[] {
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new Error(`Source not found: ${sourceId}`);
    }
    // 非 geojson 数据源没有要素可查。
    if (source.type !== "geojson") {
      return [];
    }
    // 取当前缩放级别，供 filter 表达式中的 zoom 使用。
    const zoom = this.raw.getZoom();
    // 用 resolvedFeatures（而非原始数据），让 cluster 数据源返回聚类后的
    // 集合 —— 即带 point_count 的要素，与 MapLibre 及 OpenLayers shim
    // 提供给该工具的结果一致。
    return source.resolvedFeatures().filter((feature) => {
      // 无 filter 时全部命中。
      if (!options?.filter) {
        return true;
      }
      return expressionTruthy(
        evaluateExpression(options.filter, this.featureContext(feature, zoom)),
      );
    });
  }

  /**
   * 像素级命中测试：Leaflet 没有 WebGL 拾取，这里按 layerOrder 逐层遍历
   * geojson 数据源要素，先按 filter 过滤、再做容差命中测试。
   * @param point 容器像素坐标 [x, y]
   * @param options.layers 限定只在这些图层内查询
   * @returns 命中的要素（带 layer 元信息），最多 50 条
   */
  queryRenderedFeatures(
    point: [number, number],
    options?: { layers?: string[] },
  ): Array<Record<string, unknown>> {
    const [x, y] = point;
    const wanted = options?.layers;
    const zoom = this.raw.getZoom();
    const results: Array<Record<string, unknown>> = [];
    for (const id of this.layerOrder) {
      // 限制返回数量，防止大数据集拖垮交互。
      if (results.length >= 50) {
        break;
      }
      // 指定了 layers 白名单时跳过其余图层。
      if (wanted && wanted.length > 0 && !wanted.includes(id)) {
        continue;
      }
      const entry = this.layers.get(id);
      // 不可见图层（visibility:none 或超出 minzoom/maxzoom）不参与命中。
      if (!entry || !this.isVisibleNow(entry)) {
        continue;
      }
      const spec = entry.spec;
      // 只有矢量图层类型可做要素命中。
      if (!GEOJSON_LAYER_TYPES.includes(String(spec.type))) {
        continue;
      }
      const source = this.sources.get(String(spec.source ?? ""));
      // raster 图层没有可命中的要素。
      if (!source || source.type !== "geojson") {
        continue;
      }
      for (const feature of source.resolvedFeatures()) {
        // 先按图层 filter 过滤，再做像素命中。
        if (!this.featurePassesFilter(spec, feature, zoom)) {
          continue;
        }
        if (!this.featureHitsPixel(spec, feature, x, y, zoom)) {
          continue;
        }
        results.push({
          type: "Feature",
          geometry: feature.geometry ?? null,
          properties: feature.properties ?? {},
          id: feature.id ?? null,
          layer: {
            id,
            type: String(spec.type),
            source: String(spec.source ?? ""),
          },
        });
        // 达到上限后立即停止，避免继续遍历。
        if (results.length >= 50) {
          break;
        }
      }
    }
    return results;
  }

  /**
   * Leaflet 用 DOM 瓦片与矢量 overlay 合成渲染 —— 没有单一可读取的
   * WebGL canvas。尺寸查询仍可用（query_rendered_features 用它取默认
   * 点位）；toDataURL 直接抛错。
   */
  getCanvas(): {
    width: number;
    height: number;
    clientWidth: number;
    clientHeight: number;
    toDataURL(): string;
  } {
    const size = this.raw.getSize();
    return {
      width: size.x,
      height: size.y,
      clientWidth: size.x,
      clientHeight: size.y,
      toDataURL: (): string => {
        throw new Error(
          "screenshot_map is not supported by the Leaflet engine: Leaflet composites DOM tiles and vector overlays instead of a single canvas.",
        );
      },
    };
  }

  /** Leaflet 不支持 terrain（raster-dem），调用即抛错。 */
  setTerrain(_terrain: unknown): never {
    throw new Error(
      "Terrain (raster-dem) is not supported by the Leaflet engine.",
    );
  }

  /* 有意不提供 setSky：工具层检测到方法缺失后会报告
   * "Sky is not supported by this map engine." —— 与 mapbox-gl 一致。 */

  /* ------------------------- 标注与弹窗 ------------------------- */

  /**
   * 围绕 L.marker 封装 GeoAgentMarker 兼容的接口，标注使用泪滴形
   * divIcon 图标，使 addMarkerOverlay 在 Leaflet 上的行为与
   * maplibre/mapbox 引擎一致。
   */
  createMarker(color?: string): {
    setLngLat(lngLat: [number, number]): unknown;
    addTo(map: unknown): unknown;
    setPopup(popup: unknown): unknown;
    getElement(): HTMLElement;
    remove(): unknown;
  } {
    // 颜色经白名单校验后嵌入内联 SVG，防止注入。
    const safeColor = sanitizeCssColor(color || "#3388ff");
    // 泪滴形 pin：SVG 路径 + 中心白点，锚点在尖端。
    const icon = this.factory.divIcon({
      html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 36" width="26" height="36"><path d="M13 0C5.8 0 0 5.8 0 13c0 9.8 11.6 22.2 12.1 22.7.5.5 1.3.5 1.8 0C14.4 35.2 26 22.8 26 13 26 5.8 20.2 0 13 0z" fill="${safeColor}"/><circle cx="13" cy="13" r="5.5" fill="#ffffff"/></svg>`,
      className: "geoagent-leaflet-marker-icon",
      iconSize: [26, 36],
      iconAnchor: [13, 36],
      popupAnchor: [0, -34],
    });
    // 初始位置 [0,0]，真实坐标由 setLngLat 设置。
    const marker = this.factory.marker([0, 0], { icon });
    const raw = this.raw;
    // 未加入地图前 marker 没有 DOM 元素，用占位 div 兜底。
    let placeholder: HTMLElement | null = null;
    const self = {
      setLngLat(lngLat: [number, number]): unknown {
        // [lng, lat] 转为 Leaflet 的 [lat, lng]。
        marker.setLatLng([lngLat[1], lngLat[0]]);
        return self;
      },
      addTo(_map: unknown): unknown {
        marker.addTo(raw);
        return self;
      },
      setPopup(popup: unknown): unknown {
        // 从包装对象中提取真实 L.Popup；无法提取则忽略。
        const leafletPopup = extractLeafletPopup(popup);
        if (leafletPopup) {
          marker.bindPopup(leafletPopup);
        }
        return self;
      },
      getElement(): HTMLElement {
        const element = marker.getElement();
        // 已挂载时返回 marker 自身的 DOM 元素。
        if (element) {
          return element;
        }
        // 未挂载时惰性创建占位元素，保证返回值始终可用。
        if (!placeholder) {
          placeholder = document.createElement("div");
        }
        return placeholder;
      },
      remove(): unknown {
        marker.remove();
        return undefined;
      },
    };
    return self;
  }

  /** GeoAgentPopup 兼容的 L.popup 封装。 */
  createPopup(): {
    setText(text: string): unknown;
    readonly leafletPopup: PopupLike;
  } {
    const popup = this.factory.popup({ closeButton: true, autoPan: true });
    return {
      leafletPopup: popup,
      setText(text: string): unknown {
        // Leaflet 的 setContent 会把纯字符串当 HTML 处理，因此弹窗文本
        // （来自模型工具调用，受摄入地图数据影响）必须先转义再进入 innerHTML。
        popup.setContent(escapeHtml(text));
        return this;
      },
    };
  }

  /* ------------------------- 内部实现 ------------------------- */

  /** 按 id 取图层条目，不存在时抛错。 */
  private requireEntry(id: string): ShimLayerEntry {
    const entry = this.layers.get(id);
    if (!entry) {
      throw new Error(`Layer not found: ${id}`);
    }
    return entry;
  }

  /**
   * 确保底图专用 pane 存在并返回其名称；
   * pane 的 z-index 设为 150，使底图位于 geoagent 图层 pane（250 起）之下。
   */
  private ensureBasePane(): string {
    // 惰性创建：首次 setStyle 时才建 pane。
    if (!this.basePaneName) {
      this.basePaneName = "geoagent-base";
      const pane = this.raw.createPane(this.basePaneName);
      pane.style.zIndex = "150";
    }
    return this.basePaneName;
  }

  /**
   * 按渲染顺序为各图层的 pane 设置 z-index（250 起、每层 +2），
   * 用 DOM 层级实现 MapLibre 的图层顺序语义。
   */
  private assignZIndexes(): void {
    this.layerOrder.forEach((id, index) => {
      const entry = this.layers.get(id);
      // background 等未物化图层没有 pane，跳过。
      if (!entry?.paneName) {
        return;
      }
      const pane = this.raw.getPane(entry.paneName);
      if (pane) {
        pane.style.zIndex = String(250 + index * 2);
      }
    });
  }

  /**
   * zoomend 处理：聚类缓存全部失效、重算 cluster 数据源、
   * 并按新缩放级别同步各图层的可见性。
   */
  private handleZoomChange(): void {
    // 先整体失效聚类缓存。
    for (const source of this.sources.values()) {
      source.invalidateClusterCache();
    }
    // cluster 数据源重新聚类并刷新依赖图层。
    for (const source of this.sources.values()) {
      if (source.cluster) {
        this.refreshLayersForSource(source.id);
      }
    }
    // minzoom/maxzoom 门控的可见性随缩放变化更新。
    for (const id of this.layerOrder) {
      const entry = this.layers.get(id);
      if (entry) {
        this.syncVisibility(entry);
      }
    }
  }

  /**
   * 把一条图层 spec 物化为真实 Leaflet 图层并写入 entry.leaflet。
   * raster → TileLayer / imageOverlay；fill/line/circle/symbol →
   * L.GeoJSON（带逐要素 style/filter/pointToLayer 回调）；background
   * 不产生物化对象，其余不支持的类型抛错。
   */
  private materializeLayer(entry: ShimLayerEntry): void {
    const spec = entry.spec;
    const type = String(spec.type ?? "");
    // background 层由底图瓦片承担，Leaflet 侧无对应物化对象。
    if (type === "background") {
      entry.leaflet = null;
      return;
    }
    const sourceId = typeof spec.source === "string" ? spec.source : "";
    const source = this.sources.get(sourceId);
    if (type === "raster") {
      if (!source) {
        throw new Error(
          `Cannot add layer ${String(spec.id)}; source not found: ${sourceId}`,
        );
      }
      // raster 图层按数据源类型分流。
      if (source.type === "image") {
        const url = String(source.spec.url ?? "");
        const coordinates = source.spec.coordinates as
          | Array<[number, number]>
          | undefined;
        // image source 必须有 url 与四个角点坐标。
        if (!url || !Array.isArray(coordinates) || coordinates.length !== 4) {
          throw new Error(
            `Image source ${sourceId} needs a url and four [lon, lat] corner coordinates.`,
          );
        }
        // 四角坐标收敛为外接矩形（Leaflet imageOverlay 只接受 bounds）。
        entry.leaflet = this.factory.imageOverlay(
          url,
          this.coordinatesToBounds(coordinates),
          {
            pane: entry.paneName ?? undefined,
            opacity: this.staticNumber(spec.paint, "raster-opacity", 1),
            attribution: String(source.spec.attribution ?? ""),
          },
        );
        return;
      }
      // raster source → XYZ 瓦片层。
      if (source.type === "raster") {
        const tiles = source.spec.tiles;
        // 没有可用的 tiles URL 无法渲染。
        if (!Array.isArray(tiles) || typeof tiles[0] !== "string") {
          throw new Error(
            `Raster source ${sourceId} has no tiles URL the Leaflet engine can render.`,
          );
        }
        // 取第一个 tiles URL；tileSize 尊重 source 定义。
        entry.leaflet = this.factory.tileLayer(tiles[0], {
          pane: entry.paneName ?? undefined,
          opacity: this.staticNumber(spec.paint, "raster-opacity", 1),
          attribution: String(source.spec.attribution ?? ""),
          tileSize: Number(source.spec.tileSize ?? 256),
          maxZoom: 24,
        });
        return;
      }
      // 其他类型的 source 不能承载 raster 图层。
      throw new Error(
        `Raster layers on the Leaflet engine require a raster or image source (got "${source.type}" for ${sourceId}).`,
      );
    }
    // 矢量图层 → L.GeoJSON，样式/过滤/点位渲染都委托给逐要素回调。
    if (GEOJSON_LAYER_TYPES.includes(type)) {
      if (!source || source.type !== "geojson") {
        throw new Error(
          `${type} layers on the Leaflet engine require a geojson source${sourceId ? ` (source "${sourceId}" is ${source?.type ?? "missing"})` : ""}.`,
        );
      }
      const paneName = entry.paneName ?? undefined;
      // 以空数据初始化，随后用 addData 灌入（含聚类后的）要素。
      const geoLayer = this.factory.geoJSON(undefined, {
        pane: paneName,
        style: (feature?: GeoJSON.Feature): Record<string, unknown> =>
          this.pathStyleFor(spec, feature),
        filter: (feature?: GeoJSON.Feature): boolean =>
          this.featurePassesFilter(spec, feature, this.raw.getZoom()),
        pointToLayer: (
          feature: GeoJSON.Feature | undefined,
          latlng: LeafletLatLngLike,
        ): LeafletLayerLike =>
          this.pointLayerFor(spec, feature, latlng, paneName),
      } as unknown as Record<string, unknown>);
      // 灌入聚类解析后的要素（cluster 数据源在此生效）。
      geoLayer.addData(source.resolvedFeatures());
      entry.leaflet = geoLayer;
      return;
    }
    // 3D 挤出体是 Leaflet 明确不支持的能力，抛错而非静默忽略。
    if (type === "fill-extrusion") {
      throw new Error(
        "3D fill-extrusion layers (add_3d_buildings) are not supported by the Leaflet engine.",
      );
    }
    // 其余图层类型不支持。
    throw new Error(
      `Layer type "${type}" is not supported by the Leaflet engine.`,
    );
  }

  /**
   * 刷新一个图层：geojson 矢量层直接清空重灌数据；
   * 其他物化结果先移除再重新物化。
   */
  private refreshLayer(entry: ShimLayerEntry): void {
    const type = String(entry.spec.type ?? "");
    const source = this.sources.get(String(entry.spec.source ?? ""));
    // L.GeoJSON 层支持原地清空重灌，避免整层重建。
    if (
      GEOJSON_LAYER_TYPES.includes(type) &&
      source?.type === "geojson" &&
      entry.leaflet &&
      typeof (entry.leaflet as GeoJSONLayerLike).clearLayers === "function"
    ) {
      const geoLayer = entry.leaflet as GeoJSONLayerLike;
      geoLayer.clearLayers();
      geoLayer.addData(source.resolvedFeatures());
      this.syncVisibility(entry);
      return;
    }
    // 没有物化结果（如 background）无需处理。
    if (!entry.leaflet) {
      return;
    }
    // 重建前先从地图移除旧实例。
    if (this.raw.hasLayer(entry.leaflet)) {
      this.raw.removeLayer(entry.leaflet);
    }
    entry.leaflet = null;
    // 按最新 spec 重新物化（pane 复用）。
    this.materializeLayer(entry);
    this.syncVisibility(entry);
  }

  /**
   * 按当前可见性状态同步图层在地图上的挂载：
   * 可见且未挂载 → 挂载；不可见且已挂载 → 移除。
   */
  private syncVisibility(entry: ShimLayerEntry): void {
    if (!entry.leaflet) {
      return;
    }
    // 用挂载/移除代替 Leaflet 缺失的图层级可见开关。
    if (this.isVisibleNow(entry)) {
      if (!this.raw.hasLayer(entry.leaflet)) {
        this.raw.addLayer(entry.leaflet);
      }
    } else if (this.raw.hasLayer(entry.leaflet)) {
      this.raw.removeLayer(entry.leaflet);
    }
  }

  /**
   * 判断图层当前是否应渲染：visibility 不是 none，
   * 且当前缩放级别落在 [minzoom, maxzoom) 内。
   */
  private isVisibleNow(entry: ShimLayerEntry): boolean {
    const layout = isRecord(entry.spec.layout) ? entry.spec.layout : {};
    if (layout.visibility === "none") {
      return false;
    }
    const zoom = this.raw.getZoom();
    const minZoom =
      entry.spec.minzoom == null ? -Infinity : Number(entry.spec.minzoom);
    // maxzoom 是开区间（maxzoom 10 的图层在 zoom 10 时隐藏），
    // 与 MapLibre 及 OpenLayers shim 一致。
    const maxZoom =
      entry.spec.maxzoom == null ? Infinity : Number(entry.spec.maxzoom);
    return zoom >= minZoom && zoom < maxZoom;
  }

  /** 把四角经纬度坐标收敛为 [[南, 西], [北, 东]] 外接矩形（Leaflet bounds）。 */
  private coordinatesToBounds(
    coordinates: Array<[number, number]>,
  ): [[number, number], [number, number]] {
    // 分别取纬度/经度的极值构成外接矩形。
    const lats = coordinates.map((coordinate) => coordinate[1]);
    const lngs = coordinates.map((coordinate) => coordinate[0]);
    return [
      [Math.min(...lats), Math.min(...lngs)],
      [Math.max(...lats), Math.max(...lngs)],
    ];
  }

  /** 构造单要素的表达式求值上下文（zoom 缺省取当前级别）。 */
  private featureContext(
    feature: GeoJSON.Feature | undefined,
    zoom?: number,
  ): ExpressionContext {
    return featureContextFor(feature, zoom ?? this.raw.getZoom());
  }

  /** 要素是否通过图层的 filter；无 filter 时全部通过。 */
  private featurePassesFilter(
    spec: Record<string, unknown>,
    feature: GeoJSON.Feature | undefined,
    zoom?: number,
  ): boolean {
    // 没有要素谈不上通过。
    if (!feature) {
      return false;
    }
    // 未设置 filter 时全部放行。
    if (!spec.filter) {
      return true;
    }
    return expressionTruthy(
      evaluateExpression(spec.filter, this.featureContext(feature, zoom)),
    );
  }

  /**
   * 读取 paint 属性中的静态数值；缺失或非数值时返回 fallback。
   * （不做表达式求值，用于物化时只需要常量的场合。）
   */
  private staticNumber(
    paint: unknown,
    property: string,
    fallback: number,
  ): number {
    if (!isRecord(paint)) {
      return fallback;
    }
    const value = Number(paint[property]);
    return Number.isFinite(value) ? value : fallback;
  }

  /** 求值数值属性：支持常量与表达式，失败回退 fallback。 */
  private numberValue(
    value: unknown,
    context: ExpressionContext,
    fallback: number,
  ): number {
    return numberValueFrom(value, context, fallback);
  }

  /** 求值颜色属性：支持常量字符串与表达式，失败回退 fallback。 */
  private colorValue(
    value: unknown,
    context: ExpressionContext,
    fallback: string,
  ): string {
    return colorValueFrom(value, context, fallback);
  }

  /** 解析 text-field 文本：支持 {字段名} 模板与表达式两种形式。 */
  private textFieldText(field: unknown, context: ExpressionContext): string {
    return textFieldTextFrom(field, context);
  }

  /**
   * 把 fill/line/circle 图层的 paint 属性求值为 Leaflet path 样式
   * （fillColor/fillOpacity/color/weight/opacity 等）。
   * @param feature 参与数据驱动表达式求值的要素（可能为 undefined）
   */
  private pathStyleFor(
    spec: Record<string, unknown>,
    feature?: GeoJSON.Feature,
  ): Record<string, unknown> {
    const paint = isRecord(spec.paint) ? spec.paint : {};
    const context = this.featureContext(feature);
    const type = String(spec.type);
    // fill：面填充 + 可选描边（fill-outline-color）。
    if (type === "fill") {
      const style: Record<string, unknown> = {
        fill: true,
        fillColor: this.colorValue(paint["fill-color"], context, "#1c7ed6"),
        fillOpacity: this.numberValue(paint["fill-opacity"], context, 1),
      };
      // 设置了 fill-outline-color 才画描边，与 MapLibre 默认一致。
      if (paint["fill-outline-color"] != null) {
        style.stroke = true;
        style.color = this.colorValue(
          paint["fill-outline-color"],
          context,
          "#1c7ed6",
        );
        style.weight = 1;
      } else {
        style.stroke = false;
      }
      return style;
    }
    // line：只有描边语义，映射为 Leaflet 的 color/weight/opacity。
    if (type === "line") {
      return {
        stroke: true,
        fill: false,
        color: this.colorValue(paint["line-color"], context, "#1c7ed6"),
        weight: this.numberValue(paint["line-width"], context, 1),
        opacity: this.numberValue(paint["line-opacity"], context, 1),
      };
    }
    // circle：圆点填充 + 可选描边。
    if (type === "circle") {
      const strokeWidth = this.numberValue(
        paint["circle-stroke-width"],
        context,
        0,
      );
      return {
        fill: true,
        fillColor: this.colorValue(paint["circle-color"], context, "#1c7ed6"),
        fillOpacity: this.numberValue(paint["circle-opacity"], context, 1),
        stroke: strokeWidth > 0,
        color: this.colorValue(paint["circle-stroke-color"], context, "#ffffff"),
        weight: strokeWidth,
        opacity: this.numberValue(paint["circle-stroke-opacity"], context, 1),
      };
    }
    // 其他类型不产生 path 样式。
    return {};
  }

  /**
   * Point 要素的渲染回调：circle 图层 → circleMarker；
   * symbol 图层 → 带文字样式的 divIcon marker；
   * 其余类型渲染不可见的占位圆点以保持结构一致。
   */
  private pointLayerFor(
    spec: Record<string, unknown>,
    feature: GeoJSON.Feature | undefined,
    latlng: LeafletLatLngLike,
    paneName?: string,
  ): LeafletLayerLike {
    const paint = isRecord(spec.paint) ? spec.paint : {};
    const layout = isRecord(spec.layout) ? spec.layout : {};
    const context = this.featureContext(feature);
    // latlng 转回 [lat, lng]（Leaflet 顺序）。
    const position: [number, number] = [latlng.lat, latlng.lng];
    const type = String(spec.type);
    // circle：半径来自 circle-radius（支持表达式）。
    if (type === "circle") {
      return this.factory.circleMarker(position, {
        pane: paneName,
        radius: this.numberValue(paint["circle-radius"], context, 5),
        ...this.pathStyleFor(spec, feature),
      });
    }
    // symbol：文字标注用 divIcon 呈现，样式内联在 span 上。
    if (type === "symbol") {
      const text = this.textFieldText(layout["text-field"], context);
      const color = this.colorValue(paint["text-color"], context, "#ffffff");
      const size = this.numberValue(layout["text-size"], context, 12);
      // 文本颜色/字号经清洗后内联；iconSize 为 null 让元素自适应尺寸。
      const icon = this.factory.divIcon({
        html: `<span style="color:${sanitizeCssColor(color)};font-size:${Math.max(1, size)}px;font-weight:600;font-family:sans-serif;text-shadow:0 0 3px rgba(0,0,0,0.6);white-space:nowrap;">${escapeHtml(text)}</span>`,
        className: "geoagent-leaflet-label-icon",
        iconSize: null,
      });
      // 标注不参与交互（interactive/keyboard 关闭），避免遮挡地图点击。
      return this.factory.marker(position, {
        icon,
        pane: paneName,
        interactive: false,
        keyboard: false,
      });
    }
    // fill/line 图层通常会把 Point 要素过滤掉；若自定义 filter 放行了
    // Point，就渲染一个不可见占位圆点以保持行为一致。
    return this.factory.circleMarker(position, {
      pane: paneName,
      radius: 0,
      stroke: false,
      fill: false,
      interactive: false,
    });
  }

  /* ------------------------- 命中测试 ------------------------- */

  /** 单要素像素命中测试的入口：复用共享的 hitTestFeature。 */
  private featureHitsPixel(
    spec: Record<string, unknown>,
    feature: GeoJSON.Feature,
    x: number,
    y: number,
    zoom: number,
  ): boolean {
    return hitTestFeature(
      spec,
      feature,
      x,
      y,
      (coordinate) => this.toPixel(coordinate),
      this.featureContext(feature, zoom),
    );
  }

  /** 经纬度坐标转容器像素坐标（Leaflet 需要 [lat, lng] 顺序）。 */
  private toPixel(coordinate: [number, number]): LeafletPointLike {
    return this.raw.latLngToContainerPoint([coordinate[1], coordinate[0]]);
  }






}

/**
 * 点 (px, py) 到线段 (ax, ay)-(bx, by) 的最短距离，
 * 用于线状要素的命中容差判断。
 */
function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  // 投影参数 t：线段退化（长度为 0）时取 0。
  let t = lengthSquared === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  // t 钳制到 [0,1]，最近点落在端点上。
  t = Math.max(0, Math.min(1, t));
  const closestX = ax + t * dx;
  const closestY = ay + t * dy;
  return Math.hypot(px - closestX, py - closestY);
}

/**
 * 射线法判断像素点是否位于多边形环内（不含边界判断）。
 */
function pointInRing(
  x: number,
  y: number,
  ring: LeafletPointLike[],
): boolean {
  let inside = false;
  // 逐边做射线交点奇偶计数：与边相交一次即翻转内外状态。
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 构造单要素的表达式求值上下文。由 Leaflet 与 OpenLayers 两个引擎共享。
 */
export function featureContextFor(
  feature: GeoJSON.Feature | undefined,
  zoom: number,
): ExpressionContext {
  return {
    // 属性非对象时兜底为空表；geometryType 归约到基础几何类型。
    properties: (isRecord(feature?.properties)
      ? feature?.properties
      : {}) as Record<string, unknown>,
    geometryType: normalizeGeometryType(String(feature?.geometry?.type ?? "")),
    zoom,
    id: feature?.id,
  };
}

/**
 * 数值属性求值：常量直接返回；数组按表达式求值后转数值；
 * 求值失败或结果非有限数时返回 fallback。
 */
export function numberValueFrom(
  value: unknown,
  context: ExpressionContext,
  fallback: number,
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    const evaluated = evaluateExpression(value, context);
    // 表达式求值得到 null/undefined（如缺少兜底分支的 match/case）时
    // 必须回退 fallback，而不是经 Number(null) === 0 静默渲染出
    // 半径为 0 的不可见几何。
    if (evaluated != null) {
      const numeric = Number(evaluated);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }
  }
  return fallback;
}

/**
 * 颜色属性求值：非空字符串直接返回；数组按表达式求值，
 * 结果为非空字符串才采用，否则回退 fallback。
 */
export function colorValueFrom(
  value: unknown,
  context: ExpressionContext,
  fallback: string,
): string {
  if (typeof value === "string" && value) {
    return value;
  }
  if (Array.isArray(value)) {
    const evaluated = evaluateExpression(value, context);
    if (typeof evaluated === "string" && evaluated) {
      return evaluated;
    }
  }
  return fallback;
}

/**
 * 文本标注内容解析：
 * - 字符串按 MapLibre 模板语法 {字段名} 插值（缺失字段替换为空串）；
 * - 数组按表达式求值后转字符串；
 * - 其余返回空串。
 */
export function textFieldTextFrom(
  field: unknown,
  context: ExpressionContext,
): string {
  // 模板插值：{key} 替换为要素属性值（key 先 trim 再查找）。
  if (typeof field === "string") {
    return field.replace(/\{([^}]+)\}/g, (_match, key: string) => {
      const value = context.properties?.[key.trim()];
      return value == null ? "" : String(value);
    });
  }
  if (Array.isArray(field)) {
    const evaluated = evaluateExpression(field, context);
    return evaluated == null ? "" : String(evaluated);
  }
  return "";
}

/**
 * 经纬度坐标 → 容器像素坐标的投影函数签名（命中测试共享）。
 */
export type PixelProjector = (coordinate: [number, number]) => {
  x: number;
  y: number;
};

/**
 * 对单个 GeoJSON 要素做像素级命中测试，尊重图层类型的容差
 * （circle 半径、线宽）。由两个引擎的 query_rendered_features 共享。
 */
export function hitTestFeature(
  spec: Record<string, unknown>,
  feature: GeoJSON.Feature,
  x: number,
  y: number,
  toPixel: PixelProjector,
  context: ExpressionContext,
): boolean {
  const geometry = feature.geometry;
  // 无几何或 GeometryCollection 不参与命中。
  if (!geometry || geometry.type === "GeometryCollection") {
    return false;
  }
  const paint = isRecord(spec.paint) ? spec.paint : {};
  // Multi* 已被归约为基础类型，后续逐分支调用对应的命中函数。
  const type = normalizeGeometryType(geometry.type);
  // 点状容差：circle 按半径 +4px 余量；symbol 固定 14px；其他 10px。
  const pointTolerance =
    String(spec.type) === "circle"
      ? numberValueFrom(paint["circle-radius"], context, 5) + 4
      : String(spec.type) === "symbol"
        ? 14
        : 10;
  // 线状容差：半线宽再加 4px 余量。
  const lineTolerance =
    numberValueFrom(paint["line-width"], context, 1) / 2 + 4;

  // 点命中：与查询点的平方距离不超过点容差。
  const pointHits = (coordinate: [number, number]): boolean => {
    const pixel = toPixel(coordinate);
    const dx = pixel.x - x;
    const dy = pixel.y - y;
    return dx * dx + dy * dy <= pointTolerance * pointTolerance;
  };
  // 线命中：逐段计算点到线段距离。
  const lineHits = (coordinates: Array<[number, number]>): boolean => {
    // 少于两个点构不成线段。
    if (coordinates.length < 2) {
      return false;
    }
    for (let index = 0; index + 1 < coordinates.length; index += 1) {
      const a = toPixel(coordinates[index]);
      const b = toPixel(coordinates[index + 1]);
      if (segmentDistance(x, y, a.x, a.y, b.x, b.y) <= lineTolerance) {
        return true;
      }
    }
    return false;
  };
  // 面命中：line 图层视边界为线参与测试；其余按环包含判断。
  const polygonHits = (rings: Array<Array<[number, number]>>): boolean => {
    if (rings.length === 0) {
      return false;
    }
    // line 图层渲染 Polygon 时命中其边界（闭合环当作线段序列）。
    if (String(spec.type) === "line") {
      return rings.some((ring) => lineHits([...ring, ring[0]]));
    }
    // 先判外环包含。
    const outer = rings[0].map((coordinate) => toPixel(coordinate));
    if (!pointInRing(x, y, outer)) {
      return false;
    }
    // 落在任一内环（洞）中则不算命中。
    return !rings.slice(1).some((hole) =>
      pointInRing(
        x,
        y,
        hole.map((coordinate) => toPixel(coordinate)),
      ),
    );
  };

  switch (type) {
    case "Point":
      return pointHits(geometry.coordinates as [number, number]);
    case "MultiPoint":
      return (geometry.coordinates as Array<[number, number]>).some(pointHits);
    case "LineString":
      return lineHits(geometry.coordinates as Array<[number, number]>);
    case "MultiLineString":
      return (geometry.coordinates as Array<Array<[number, number]>>).some(
        lineHits,
      );
    case "Polygon":
      return polygonHits(
        geometry.coordinates as Array<Array<[number, number]>>,
      );
    case "MultiPolygon":
      return (
        geometry.coordinates as Array<Array<Array<[number, number]>>>
      ).some(polygonHits);
    default:
      return false;
  }
}

/**
 * 从 GeoAgentPopup 包装对象中提取真实 L.Popup：
 * 优先读 leafletPopup 字段，其次要求对象本身带 setContent。
 */
function extractLeafletPopup(popup: unknown): PopupLike | null {
  // 兼容两种形态：shim 包装对象（leafletPopup 字段）与裸 L.Popup。
  if (isRecord(popup)) {
    const wrapped = (popup as { leafletPopup?: unknown }).leafletPopup;
    if (isRecord(wrapped) && typeof wrapped.setContent === "function") {
      return wrapped as unknown as PopupLike;
    }
    if (typeof popup.setContent === "function") {
      return popup as unknown as PopupLike;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 公共辅助入口                                                                */
/* -------------------------------------------------------------------------- */

/**
 * LeafletMapShim 的工厂函数：把真实地图与 Leaflet 命名空间包装成 shim。
 */
export function createLeafletMapShim(
  map: LeafletMapLike,
  namespace: Record<string, unknown>,
): LeafletMapShim {
  return new LeafletMapShim(map, namespace);
}

/** 类型守卫：值是否为 LeafletMapShim 实例。 */
export function isLeafletMapShim(value: unknown): value is LeafletMapShim {
  return value instanceof LeafletMapShim;
}

/**
 * 控件挂载句柄：调用 remove() 卸载控件并清理 DOM。
 */
export interface LeafletControlAttachment {
  remove(): void;
}

/** 归一化后的控件角落位置（与 MapLibre 的 position 取值一致）。 */


/**
 * 把 GeoAgentControl 挂载到 Leaflet 地图上。
 *
 * Leaflet 没有可供外部控件使用的 map.addControl 槽位，因此这里把控件
 * 元素挂进对应角落的 .leaflet-control-container（找不到时退而在地图
 * 容器内绝对定位）。控件必须以 mapEngine { kind: "leaflet", namespace: L }
 * 创建。
 *
 *   const control = new GeoAgentControl({ mapEngine: { kind: "leaflet", namespace: L } });
 *   const attachment = addGeoAgentToLeafletMap(control, map, { position: "top-left" });
 *   // 之后：attachment.remove();
 */
export function addGeoAgentToLeafletMap(
  control: GeoAgentControl,
  map: LeafletMapLike,
  options?: { position?: string },
): LeafletControlAttachment {
  // 先做鸭子类型校验，防止误传其他引擎的地图实例。
  if (!isLeafletMap(map)) {
    throw new Error(
      "addGeoAgentToLeafletMap expects a Leaflet map instance created with L.map(...).",
    );
  }
  // 读取控件私有 options，校验引擎类型是否匹配。
  const internal = control as unknown as {
    options?: { position?: string; mapEngine?: { kind?: string } };
    onRemove(): void;
  };
  const engineKind = internal.options?.mapEngine?.kind;
  // kind 已设置且不匹配时直接报错。
  if (engineKind && engineKind !== "leaflet") {
    throw new Error(
      `GeoAgentControl was created with mapEngine.kind "${engineKind}"; Leaflet hosts need { kind: "leaflet", namespace: L }.`,
    );
  }
  const position = normalizeCorner(
    options?.position ?? internal.options?.position ?? "top-right",
  );
  if (internal.options && internal.options.position !== position) {
    // GeoAgentControl 展开面板的朝向由 options.position 决定；
    // 让它与实际挂载的角落保持一致。
    internal.options.position = position;
  }
  // 复用控件的 onAdd 构建 DOM（map 参数仅为签名兼容，不会调用其 MapLibre 方法）。
  const element = control.onAdd(map as unknown as MapLibreMap);
  // 挂上 Leaflet 控件类名，获得与原生控件一致的定位样式。
  element.classList.add("leaflet-control");
  const [vertical, horizontal] = position.split("-") as [string, string];
  const container = map.getContainer();
  // 优先挂进 Leaflet 自带的角落容器。
  const corner = container.querySelector<HTMLElement>(
    `.leaflet-control-container .leaflet-${vertical}.leaflet-${horizontal}`,
  );
  if (corner) {
    corner.appendChild(element);
  } else {
    // 没有 Leaflet 控件容器（非常规宿主）：退化为容器内绝对定位。
    element.style.position = "absolute";
    element.style.zIndex = "800";
    if (vertical === "top") {
      element.style.top = "10px";
    } else {
      element.style.bottom = "10px";
    }
    if (horizontal === "left") {
      element.style.left = "10px";
    } else {
      element.style.right = "10px";
    }
    // 地图容器不是定位上下文时改为 relative，保证绝对定位生效。
    if (window.getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    container.appendChild(element);
  }
  // 返回卸载句柄：先走控件自身的清理流程，再摘除 DOM。
  return {
    remove(): void {
      internal.onRemove.call(control);
      element.remove();
    },
  };
}
