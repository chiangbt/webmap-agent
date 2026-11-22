/**
 * GeoAgent 控件的 ArcGIS Maps SDK for JavaScript 宿主适配层。
 *
 * GeoAgent 的工具通过 MapLibre GL JS 的 API 表面驱动地图：
 * Style Spec 的 source/layer、setStyle、queryRenderedFeatures 等。
 * 而 ArcGIS Maps SDK 的对象模型完全不同 —— Map（由 basemap 与业务图层组成）、
 * 带 center/zoom/extent 的 MapView，用 renderer + symbol 而非 style 文档
 * 来表达渲染。
 *
 * ArcGISMapShim 负责弥合这一差距。它维护一份类似 Style Spec 的
 * source/layer 注册表，把其中的条目物化为真正的 ArcGIS 图层（raster XYZ
 * 作为 WebTileLayer；GeoJSON 作为客户端 FeatureLayer，其 Graphic 携带
 * 逐要素 symbol，由共享的 MapLibre 表达式引擎求值），并暴露工具所调用的
 * maplibregl.Map API 子集。ArcGIS MapView 确实不具备的能力（globe 投影、
 * terrain、sky、fill-extrusion/heatmap/vector-tile/image source）会抛出
 * 显式错误而不是静默失败 —— 与其他引擎文档化的契约一致。ArcGIS 在 2D shim
 * 之外真正能做到的能力（通过 `view.takeScreenshot` 的画布截图）则暴露为
 * 真正的 `screenshot_map` 工具。
 *
 * 本文件不 import "@arcgis/*"；宿主传入自己的 namespace，内含 shim 需要构造
 * 的少数几个 esri 类。交给控件的 map 要么是 `MapView`/`SceneView`，要么是
 * `view` 属性已就绪的 `@arcgis/map-components` 元素（`<arcgis-map>` /
 * `<arcgis-scene>`）—— 宿主可以 await {@link waitForArcGISComponent} 来等它。
 *
 *   import { GeoAgentControl, addGeoAgentToArcGISMap } from "web-geoagent";
 *   new GeoAgentControl({ mapEngine: { kind: "arcgis", namespace } });
 *   addGeoAgentToArcGISMap(control, view); // ArcGIS 没有 addControl 槽位
 */

import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoAgentControl } from "../control/GeoAgentControl";
import type {
  GeoAgentMapSurface,
  GeoAgentStyleSnapshot,
} from "../tools/geoagent-tools";
import type { ExpressionContext, PixelProjector } from "./leaflet-engine";
import { normalizeCorner, sanitizeCssColor } from "./shared";
import {
  colorValueFrom,
  computeClusteredFeatures,
  evaluateExpression,
  expressionTruthy,
  featureContextFor,
  hitTestFeature,
  normalizeFeatureCollection,
  normalizeGeometryType,
  numberValueFrom,
  resolveBasemapStyle,
  textFieldTextFrom,
} from "./leaflet-engine";

/* -------------------------------------------------------------------------- */
/* ArcGIS 结构类型（shim 自身从不 import "@arcgis/*"）                         */
/* -------------------------------------------------------------------------- */

/**
 * ArcGIS watch/on 返回句柄的最小结构 —— 仅要求 remove()，用于注销监听。
 */
export interface ArcGISWatchHandle {
  remove(): void;
}

/**
 * ArcGIS 图层（WebTileLayer/FeatureLayer 等）的鸭子类型：
 * shim 只依赖 visible/opacity/title 三个属性。
 */
export interface ArcGISLayerLike {
  visible: boolean;
  opacity?: number;
  title?: string;
}

/**
 * esri.Collection 的鸭子类型：向地图集合增删图层走 add/remove；
 * items/length 仅作探测用，可能缺失。
 */
export interface ArcGISCollectionLike<T> {
  add(item: T, index?: number): unknown;
  remove(item: T): unknown;
  items?: T[];
  length?: number;
}

/**
 * ArcGIS WebMap（view.map）的鸭子类型：图层集合与可选的 basemap 标识。
 */
export interface ArcGISWebMapLike {
  layers: ArcGISCollectionLike<ArcGISLayerLike>;
  basemap?: unknown;
}

/**
 * ArcGIS Point 的鸭子类型：地理坐标（longitude/latitude）或投影坐标（x/y）
 * 二选一出现。
 */
export interface ArcGISPointLike {
  longitude?: number;
  latitude?: number;
  x?: number;
  y?: number;
}

/**
 * ArcGIS Extent 的鸭子类型：四至坐标与可选的空间参考。
 */
export interface ArcGISExtentLike {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  spatialReference?: {
    wkid?: number;
    isWebMercator?: boolean;
    isWGS84?: boolean;
  };
}

/**
 * ArcGIS SpatialReference 的鸭子类型：shim 用它判断 Web Mercator / WGS84。
 */
export interface ArcGISSpatialReferenceLike {
  isWebMercator?: boolean;
  isWGS84?: boolean;
  wkid?: number;
}

/**
 * view.takeScreenshot() 返回结果的鸭子类型：dataUrl 或带宽高的 data。
 */
export interface ArcGISScreenshotLike {
  dataUrl?: string;
  data?: { width?: number; height?: number };
}

/**
 * ArcGIS MapView/SceneView 的鸭子类型：shim 依赖的视图属性与方法的最小集合。
 * GeoAgent 工具把它当作 maplibregl.Map 的替身来驱动。MapView 与 SceneView
 * 的差异点（camera/scale/toScreen）均为可选成员，靠 isArcGISSceneView 区分。
 */
export interface ArcGISViewLike {
  container: HTMLElement;
  ready?: boolean;
  spatialReference?: ArcGISSpatialReferenceLike;
  center: ArcGISPointLike;
  zoom: number;
  rotation: number;
  extent: ArcGISExtentLike;
  size?: { width: number; height: number };
  map: ArcGISWebMapLike;
  goTo(target: unknown, options?: unknown): Promise<void> | void;
  when?(callback?: () => void, errback?: (error: unknown) => void): unknown;
  takeScreenshot?(options?: unknown): Promise<ArcGISScreenshotLike>;
  on(type: string, listener: (event?: unknown) => void): ArcGISWatchHandle;
  watch(
    property: string,
    listener: (newValue?: unknown, oldValue?: unknown) => void,
  ): ArcGISWatchHandle;
  /** 仅 SceneView 拥有：相机模型（position/heading/tilt）。 */
  camera?: {
    position?: { longitude?: number; latitude?: number; z?: number };
    heading?: number;
    tilt?: number;
  };
  /** 仅 SceneView 拥有：视图中心处的地图比例尺。 */
  scale?: number;
  /** 同步屏幕投影（MapView 与 SceneView 都暴露该方法）。 */
  toScreen?(point: unknown, options?: unknown): { x: number; y: number };
}

/**
 * `<arcgis-map>` / `<arcgis-scene>` 组件（@arcgis/map-components）的形状。
 * 注意：这些 web component 自身并没有 `when()` 方法 —— 元素继承的是现代
 * 原生的 `EventTarget.prototype.when(type)`，它要求传入必填的事件名，
 * 与视图是否就绪毫无关系。请用 {@link waitForArcGISComponent} 等待视图。
 */
export interface ArcGISComponentLike {
  view?: ArcGISViewLike | null;
  map?: ArcGISWebMapLike;
}

/**
 * 解析 `@arcgis/map-components` 元素背后的 MapView/SceneView：监听组件的
 * `arcgisViewReadyChange` 事件（并以定时轮询兜底），直到元素暴露 `.view`。
 * 视图已存在时立即 resolve。
 * @param component 待探测的组件元素
 * @param timeoutMs 超时毫秒数，超时后 reject 并给出诊断信息
 * @returns 就绪的 MapView/SceneView
 */
export function waitForArcGISComponent(
  component: ArcGISComponentLike,
  timeoutMs = 30000,
): Promise<ArcGISViewLike> {
  // 视图已就绪则跳过事件等待，直接 resolve。
  const immediate = component.view;
  if (isArcGISView(immediate)) {
    return Promise.resolve(immediate);
  }
  return new Promise<ArcGISViewLike>((resolve, reject) => {
    const element = component as unknown as HTMLElement;
    // 统一清理：事件监听、轮询定时器、超时定时器都要在结束时移除。
    const cleanup = (): void => {
      if (typeof element?.addEventListener === "function") {
        element.removeEventListener("arcgisViewReadyChange", onChange);
      }
      window.clearInterval(poll);
      window.clearTimeout(timer);
    };
    // 事件与轮询共用同一探测：view 一旦像 MapView 就清理并 resolve。
    const onChange = (): void => {
      if (isArcGISView(component.view)) {
        cleanup();
        resolve(component.view);
      }
    };
    // 事件可能错过（组件在挂接前就已就绪），每 150ms 轮询一次兜底。
    const poll = window.setInterval(onChange, 150);
    // 超时兜底：元素可能仍在加载（网络/鉴权），或根本不是该类组件。
    const timer = window.setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `The ArcGIS component did not expose its view within ${Math.round(timeoutMs / 1000)}s — the element may still be loading (network/authentication) or is not an @arcgis/map-components element.`,
        ),
      );
    }, timeoutMs);
    if (typeof element?.addEventListener === "function") {
      element.addEventListener("arcgisViewReadyChange", onChange);
    }
  });
}

/**
 * shim 需要构造的 ArcGIS Maps SDK 的那几个类。宿主组装一次：
 *
 *   import WebTileLayer from "@arcgis/core/layers/WebTileLayer";
 *   import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
 *   import Graphic from "@arcgis/core/Graphic";
 *   import SimpleFillSymbol from "@arcgis/core/symbols/SimpleFillSymbol";
 *   import SimpleLineSymbol from "@arcgis/core/symbols/SimpleLineSymbol";
 *   import SimpleMarkerSymbol from "@arcgis/core/symbols/SimpleMarkerSymbol";
 *   import TextSymbol from "@arcgis/core/symbols/TextSymbol";
 *   import PictureMarkerSymbol from "@arcgis/core/symbols/PictureMarkerSymbol";
 *
 *   const namespace = { WebTileLayer, FeatureLayer, Graphic, SimpleFillSymbol,
 *     SimpleLineSymbol, SimpleMarkerSymbol, TextSymbol, PictureMarkerSymbol };
 *
 * 几何与 extent 以 auto-cast 普通对象的形式交给 SDK，因此不需要几何类。
 */
export interface ArcGISNamespace {
  WebTileLayer: new (options?: Record<string, unknown>) => ArcGISLayerLike;
  FeatureLayer: new (options?: Record<string, unknown>) => ArcGISLayerLike;
  Graphic: new (options?: Record<string, unknown>) => unknown;
  SimpleFillSymbol: new (options?: Record<string, unknown>) => unknown;
  SimpleLineSymbol: new (options?: Record<string, unknown>) => unknown;
  SimpleMarkerSymbol: new (options?: Record<string, unknown>) => unknown;
  TextSymbol: new (options?: Record<string, unknown>) => unknown;
  PictureMarkerSymbol: new (options?: Record<string, unknown>) => unknown;
}

/** asArcGISNamespace 校验时要求 namespace 必须提供的 esri 类名清单。 */
const REQUIRED_ARCGIS_KEYS: Array<keyof ArcGISNamespace> = [
  "WebTileLayer",
  "FeatureLayer",
  "Graphic",
  "SimpleFillSymbol",
  "SimpleLineSymbol",
  "SimpleMarkerSymbol",
  "TextSymbol",
  "PictureMarkerSymbol",
];

/** 狭义对象判断：typeof 为 object、非 null 且非数组。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验宿主 namespace 是否带齐 shim 要构造的全部 esri 类，缺一则抛出
 * 列明缺失项的错误；校验通过后按 ArcGISNamespace 类型收窄返回。
 */
function asArcGISNamespace(
  namespace: Record<string, unknown>,
): ArcGISNamespace {
  // 找出所有未提供的类名，一次性报全，避免宿主逐个补。
  const missing = REQUIRED_ARCGIS_KEYS.filter(
    (key) => namespace[key] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `mapEngine { kind: "arcgis" } needs a namespace with the ArcGIS Maps SDK classes: missing ${missing.join(", ")}. See the README's ArcGIS section for the full namespace object.`,
    );
  }
  return namespace as unknown as ArcGISNamespace;
}

/** 鸭子类型判断：这个值看起来像 ArcGIS MapView/SceneView 吗？ */
export function isArcGISView(value: unknown): value is ArcGISViewLike {
  if (!isRecord(value)) {
    return false;
  }
  const candidate = value as unknown as ArcGISViewLike;
  // 关键特征缺一不可：goTo/watch/on 三个方法，加上 center 与 map.layers
  // 两个对象属性同时存在。
  return (
    typeof candidate.goTo === "function" &&
    isRecord(candidate.center) &&
    isRecord(candidate.map) &&
    isRecord(candidate.map.layers) &&
    typeof candidate.watch === "function" &&
    typeof candidate.on === "function"
  );
}

/**
 * ArcGIS SceneView（3D globe）检测：只有 SceneView 暴露 `camera`。
 * shim 按视图种类分别适配相机模型 —— MapView 驱动 center/zoom/rotation，
 * SceneView 驱动 center/scale/camera.heading/tilt。
 */
export function isArcGISSceneView(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord((value as { camera?: unknown }).camera) &&
    typeof (value as { goTo?: unknown }).goTo === "function"
  );
}

/** 鸭子类型判断：这个值看起来像 `<arcgis-map>` 组件吗？ */
export function isArcGISComponent(value: unknown): value is ArcGISComponentLike {
  return (
    isRecord(value) &&
    typeof (value as { when?: unknown }).when === "function" &&
    "view" in value
  );
}

/**
 * 解析宿主交给控件的值背后的 MapView：可以直接是 MapView/SceneView，
 * 也可以是 `@arcgis/map-components` 元素且其 `view` 已设置
 * （视图只有在 `await element.when()` 之后才存在）。
 */
export function resolveArcGISView(value: unknown): ArcGISViewLike {
  // 直接传入的就是视图本身。
  if (isArcGISView(value)) {
    return value;
  }
  // 组件元素：取其 .view；尚未就绪则明确报错而不是返回 undefined。
  if (isArcGISComponent(value)) {
    const view = value.view;
    if (!isArcGISView(view)) {
      throw new Error(
        "The ArcGIS component's view is not ready yet. Pass the element only after its view exists (e.g. await waitForArcGISComponent(element)) or await the arcgisViewReadyChange event first.",
      );
    }
    return view;
  }
  // 既不是视图也不是组件：给出宿主应有的正确用法。
  throw new Error(
    'ArcGIS hosts must pass an ArcGIS Maps SDK MapView (or an <arcgis-map> element with a ready .view) as the map, with mapEngine { kind: "arcgis", namespace }.',
  );
}

/* -------------------------------------------------------------------------- */
/* Web Mercator 与颜色辅助函数                                                 */
/* -------------------------------------------------------------------------- */

/** Web Mercator（EPSG:3857）球体半径（米）：经纬度 ↔ 墨卡托米制换算的基础。 */
const MERCATOR_RADIUS = 6378137;

/**
 * tile zoom 0 处的标准 Web Mercator 比例尺（ArcGIS SDK 采用的米/英寸约定），
 * 以及建立在它之上的 zoom↔scale 换算阶梯。用于通过 `scale` 属性驱动
 * SceneView 的 zoom。
 */
const BASE_MAP_SCALE = 591657527.591555;

/** tile zoom → ArcGIS 比例尺：BASE_MAP_SCALE 按 2^zoom 递减。 */
function zoomToScale(zoom: number): number {
  return BASE_MAP_SCALE / Math.pow(2, zoom);
}

/** 经度（度）→ Web Mercator X（米）。 */
function lonToMercatorX(lon: number): number {
  return (lon * Math.PI) / 180 * MERCATOR_RADIUS;
}

/** 纬度（度）→ Web Mercator Y（米）。 */
function latToMercatorY(lat: number): number {
  // Web Mercator 纬度有效范围 ±85.05112878°，先夹紧防止 tan 发散。
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return (
    MERCATOR_RADIUS *
    Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360))
  );
}

/** Web Mercator X（米）→ 经度（度）。 */
function mercatorXToLon(x: number): number {
  return (x / MERCATOR_RADIUS) * (180 / Math.PI);
}

/** Web Mercator Y（米）→ 纬度（度）。 */
function mercatorYToLat(y: number): number {
  return (2 * Math.atan(Math.exp(y / MERCATOR_RADIUS)) - Math.PI / 2) *
    (180 / Math.PI);
}

/** 深拷贝纯 JSON 数据（undefined/函数会丢失），用于 spec 快照。 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 构造空 GeoJSON FeatureCollection，作为 geojson source 的初始 data。 */
function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/** 把数值夹紧到 [0, 1]；非有限值（如 NaN）按 1（完全不透明）处理。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1, Math.max(0, value));
}

/** 解析后的 RGBA 颜色：r/g/b 为 0–255，a 为 0–1。 */
interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * 解析 CSS 颜色为 RGBA。支持 #RGB/#RGBA/#RRGGBB/#RRGGBBAA 的缩写与完整
 * hex，以及 rgb()/rgba()（兼容逗号/空格分隔、百分比通道与斜杠 alpha）。
 * 无法解析时返回 null。
 */
function parseCssColor(value: string): Rgba | null {
  const trimmed = value.trim();
  // 十六进制形态。
  const hex = /^#([0-9a-f]{3,8})$/i.exec(trimmed);
  if (hex) {
    const digits = hex[1];
    // 1 位缩写重复两次展开为 2 位再转十进制。
    const expand = (pair: string): number =>
      pair.length === 1 ? parseInt(pair.repeat(2), 16) : parseInt(pair, 16);
    // 3/4 位是缩写写法，逐位展开；第 4 位是 alpha。
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits.slice(0, 1)),
        g: expand(digits.slice(1, 2)),
        b: expand(digits.slice(2, 3)),
        a: digits.length === 4 ? expand(digits.slice(3, 4)) / 255 : 1,
      };
    }
    // 6/8 位是完整写法，按两位一组解析；第 4 组是 alpha。
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
  // rgb()/rgba() 形态：分隔符兼容逗号、空白与斜杠（"rgb(1 2 3 / 50%)"）。
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(trimmed);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter((part) => part.length > 0);
    // 百分比通道换算到 0–255；缺参返回 NaN，交给后面的统一非法判定。
    const number = (part: string | undefined): number => {
      if (part === undefined) {
        return NaN;
      }
      return part.endsWith("%")
        ? (parseFloat(part) / 100) * 255
        : parseFloat(part);
    };
    const r = number(parts[0]);
    const g = number(parts[1]);
    const b = number(parts[2]);
    // 未写 alpha 视为不透明。
    const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
    // 任一通道解析失败即整体判为不可解析。
    if ([r, g, b, a].some((value2) => !Number.isFinite(value2))) {
      return null;
    }
    return { r, g, b, a };
  }
  // 关键字颜色（"red" 等）不在支持范围内。
  return null;
}

/**
 * 给 CSS 颜色乘上额外不透明度系数（系数先经 clamp01）。
 * alpha 已是 1 或颜色不可解析时原样返回。
 */
function withOpacity(color: string, opacity: number): string {
  const alpha = clamp01(Number.isFinite(opacity) ? opacity : 1);
  if (alpha >= 1) {
    return color;
  }
  const parsed = parseCssColor(color);
  if (!parsed) {
    return color;
  }
  // 与原 alpha 相乘，保留 3 位小数避免浮点尾巴。
  const a = Math.round(parsed.a * alpha * 1000) / 1000;
  return `rgba(${Math.round(parsed.r)}, ${Math.round(parsed.g)}, ${Math.round(parsed.b)}, ${a})`;
}

/**
 * 映射到真实 ArcGIS basemap（直接设置到 `map.basemap`）、而不是 agent 托管
 * XYZ 图层的 `change_basemap` 名称集合。DEFAULT_BASEMAPS 里的若干 MapLibre
 * style 别名也会映射到最接近的 ArcGIS basemap。
 */
const ARCGIS_BASEMAPS = new Set([
  "satellite",
  "hybrid",
  "topo",
  "terrain",
  "oceans",
  "osm",
  "streets",
  "gray",
  "dark-gray",
  "light-gray",
  "national-park",
  "community",
  "human-geometry",
  "chart-buffer",
  "colored-labels",
  "midcentury",
  "modern",
  "newspaper",
  "nova",
  "pastel",
  "hillshade",
]);

/**
 * MapLibre 风格 basemap 别名 → ArcGIS basemap 名称。键一律小写，
 * 查找前会先 trim + toLowerCase。
 */
const ARCGIS_BASEMAP_ALIASES: Record<string, string> = {
  satellite: "satellite",
  google_satellite: "satellite",
  esri_world_imagery: "satellite",
  dark: "dark-gray",
  darkgray: "dark-gray",
  positron: "light-gray",
  light: "light-gray",
  voyager: "community",
  osm: "osm",
  openstreetmap: "osm",
  topo: "topo",
};

/* -------------------------------------------------------------------------- */
/* source / layer 注册表                                                       */
/* -------------------------------------------------------------------------- */

/** ArcGIS 引擎支持的 MapLibre 图层类型：GeoJSON 四类；raster 在 addLayer 中单独放行。 */
const GEOJSON_LAYER_TYPES = ["fill", "line", "circle", "symbol"];

/**
 * shim 注册表中的一条图层记录：保存原始 Style Spec（spec）与物化出的
 * esri 图层实例（esriLayer，WebTileLayer 或客户端 FeatureLayer）。
 */
interface ArcGisShimLayer {
  id: string;
  type: string;
  source: string;
  spec: Record<string, unknown>;
  visible: boolean;
  esriLayer: ArcGISLayerLike | null;
}

/**
 * shim 注册表中的一条 source 记录。构造时按类型立即校验（不支持的类型当场
 * 抛错）；geojson source 支持 URL 异步加载与 cluster 聚合（按 zoom 缓存）。
 */
class ArcGisShimSource {
  readonly id: string;
  readonly type: string;
  readonly cluster: boolean;
  readonly clusterRadius: number;
  readonly clusterMaxZoom: number;
  spec: Record<string, unknown>;
  data: GeoJSON.FeatureCollection = emptyFeatureCollection();
  // 聚合缓存：记录计算时的 zoom，zoom 未变时直接复用结果。
  private clusterCache: { zoom: number; features: GeoJSON.Feature[] } | null =
    null;
  // 所属 shim：读取当前 zoom / 屏幕投影来做聚合。
  private readonly shim: ArcGISMapShim;

  constructor(shim: ArcGISMapShim, id: string, spec: Record<string, unknown>) {
    this.shim = shim;
    this.id = id;
    // 深拷贝 spec，外部后续改动不影响注册表内的快照。
    this.spec = cloneJson(spec);
    this.type = String(spec.type ?? "unknown");
    // 仅 geojson source 支持 cluster 聚合。
    this.cluster = this.type === "geojson" && Boolean(spec.cluster);
    this.clusterRadius = Number(spec.clusterRadius ?? 50);
    this.clusterMaxZoom = Number(spec.clusterMaxZoom ?? 14);
    if (this.type === "geojson") {
      const data = spec.data;
      if (typeof data === "string") {
        // URL 形态：异步拉取，失败仅告警，不阻塞 source 的创建。
        void shim
          .fetchGeoJson(data)
          .then((loaded) => {
            this.setData(loaded);
            // 数据异步到达：重建依赖本 source 的已物化 FeatureLayer，
            // 否则图层会一直空白。
            this.shim.refreshLayersForSource(id);
          })
          .catch((error: unknown) => {
            console.warn(
              `ArcGIS engine: could not load GeoJSON source "${id}":`,
              error,
            );
          });
      } else {
        // 内联 FeatureCollection：规范化后立即生效。
        this.data = normalizeFeatureCollection(data);
      }
    } else if (this.type === "raster") {
      // raster 物化为 XYZ WebTileLayer，必须有 tiles URL 模板。
      const tiles = Array.isArray(spec.tiles) ? spec.tiles : [];
      if (typeof tiles[0] !== "string" || !tiles[0]) {
        throw new Error(
          `Raster source "${id}" needs a tiles URL template; the ArcGIS engine renders rasters as XYZ WebTileLayers.`,
        );
      }
    } else if (this.type === "raster-dem") {
      // 地形能力按视图区分话术：SceneView 的地形来自 ground ElevationLayers，
      // MapView 则完全没有地形，两种情况都显式失败。
      throw new Error(
        shim.isScene
          ? "SceneView terrain comes from the scene's ground ElevationLayers; raster-dem tile sources are not applicable to a scene."
          : "Terrain (raster-dem) is not supported by the ArcGIS engine's 2D MapView.",
      );
    } else if (this.type === "vector") {
      // 矢量瓦片源需要 style 文档引擎，本引擎没有对应物。
      throw new Error(
        `Vector tile sources are not supported by the ArcGIS engine (source "${id}"). Vector basemaps and 3D buildings require maplibre-gl or mapbox-gl.`,
      );
    } else if (this.type === "image") {
      // MapView 无法对地理配准的图片做四角形变贴地。
      throw new Error(
        `Image sources are not supported by the ArcGIS engine (source "${id}"): MapView cannot warp a georeferenced image quad.`,
      );
    } else {
      // 其余类型（包括未知类型）一律不支持。
      throw new Error(
        `"${this.type}" sources are not supported by the ArcGIS engine (source "${id}").`,
      );
    }
  }

  /** 整体替换 source 数据（规范化保存并回写 spec.data），并失效聚合缓存。 */
  setData(data: unknown): void {
    this.data = normalizeFeatureCollection(data);
    this.spec.data = data;
    this.clusterCache = null;
  }

  /** 视图 zoom/相机变化后调用：让聚合结果按新 zoom 重新计算。 */
  invalidateClusterCache(): void {
    this.clusterCache = null;
  }

  /**
   * 返回当前应渲染的要素：非聚合 source 直接给 data.features；聚合 source
   * 按 zoom 缓存聚合结果，zoom >= clusterMaxZoom 时退回原始要素不再聚合。
   */
  resolvedFeatures(): GeoJSON.Feature[] {
    if (!this.cluster) {
      return this.data.features;
    }
    const zoom = this.shim.getZoom();
    // 缓存命中条件：zoom 与上次计算时一致。
    if (this.clusterCache && this.clusterCache.zoom === zoom) {
      return this.clusterCache.features;
    }
    const features =
      zoom >= this.clusterMaxZoom
        ? this.data.features
        : computeClusteredFeatures(
            this.data.features,
            this.clusterRadius,
            // 聚合按屏幕像素距离计算，用 shim 的投影把经纬度换算成像素。
            (lat, lng) => this.shim.projectPoint(lat, lng),
          );
    this.clusterCache = { zoom, features };
    return features;
  }
}

/* -------------------------------------------------------------------------- */
/* shim 本体                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 一个 marker 的包装状态：DOM 元素、地理锚点（setLngLat 之前为 null）
 * 与可选的 popup 内容元素。
 */
interface MarkerWrapper {
  element: HTMLElement;
  lngLat: [number, number] | null;
  popupElement: HTMLElement | null;
  /** createMarker 时由返回的 self.remove 回填：destroy 时据此摘除 marker。 */
  remove?: () => void;
}

/**
 * ArcGIS 引擎 shim 本体：把 ArcGIS MapView/SceneView 适配成工具所需的
 * maplibregl.Map API 子集 —— source/layer 注册表、视图状态读写、
 * rendered 查询、marker/popup、截图与销毁清理。构造时即注册视图 watch
 * 与 click 监听，destroy 时统一注销。
 */
export class ArcGISMapShim implements GeoAgentMapSurface {
  // 被适配的 ArcGIS MapView/SceneView。
  private readonly view: ArcGISViewLike;
  // 宿主提供的 esri 类集合：构造 WebTileLayer/FeatureLayer/Graphic/symbol 用。
  private readonly ns: ArcGISNamespace;
  // addSource 注册的 source 记录。
  private readonly sources = new Map<string, ArcGisShimSource>();
  // addLayer 注册的图层记录（spec + esri 图层实例）。
  private readonly layers = new Map<string, ArcGisShimLayer>();
  // 图层顺序注册表：数组顺序即 esri layers 集合中的添加顺序（先加的在下）。
  private layerOrder: string[] = [];
  // setStyle 以 XYZ 方式挂上的 agent 托管底图（WebTileLayer），
  // 换回 esri basemap 时移除。
  private agentBaseLayer: ArcGISLayerLike | null = null;
  // 存活的 marker 包装集合，视图变化时统一重投影。
  private readonly markers = new Set<MarkerWrapper>();
  // 构造时注册的 camera/zoom/extent/rotation watch 句柄，destroy 时注销。
  private readonly watchHandles: ArcGISWatchHandle[] = [];
  // 地图 click 监听句柄：点击视图即收起 marker popup。
  private clickHandle: ArcGISWatchHandle | null = null;
  // on() 登记的外部事件订阅：off 时移除对应项，destroy 时统一注销。
  private readonly externalHandles: Array<{
    type: string;
    listener: (event?: unknown) => void;
    handle: ArcGISWatchHandle;
  }> = [];

  constructor(map: ArcGISViewLike, namespace: Record<string, unknown>) {
    this.view = map;
    this.ns = asArcGISNamespace(namespace);
    // 只接受 Web Mercator / WGS84 视图，其他空间参考提前失败。
    this.validateSpatialReference();
    // web component 宿主下容器位于 shadow root，需要注入样式副本。
    this.injectShadowStyles();
    if (this.isScene) {
      // SceneView 通过 camera 导航；watch 一个 camera 就能在一个处理器里
      // 同时覆盖 zoom（scale）、heading、tilt 与平移。
      this.watchHandles.push(
        map.watch("camera", () => {
          for (const source of this.sources.values()) {
            source.invalidateClusterCache();
          }
          this.syncVisibilityAll();
          this.syncMarkers();
        }),
      );
    } else {
      // MapView 分开监听：zoom 变化影响聚合缓存与 zoom 范围可见性；
      // extent/rotation 只影响 marker/popup 的屏幕位置。
      this.watchHandles.push(
        map.watch("zoom", () => {
          for (const source of this.sources.values()) {
            source.invalidateClusterCache();
          }
          this.syncVisibilityAll();
          this.syncMarkers();
        }),
      );
      this.watchHandles.push(
        map.watch("extent", () => this.syncMarkers()),
      );
      this.watchHandles.push(
        map.watch("rotation", () => this.syncMarkers()),
      );
    }
    // 点击地图任意处即收起已展示的 marker popup。
    this.clickHandle = map.on("click", () => this.hideMarkerPopups());
  }

  /**
   * marker/popup 元素挂在 `view.container` 里。在 `@arcgis/map-components`
   * 宿主下，该容器位于组件的 SHADOW ROOT 内，页面样式表
   * （geoagent-control.css）作用不到 —— popup 会渲染成无样式的裸文本。
   * 当容器位于 shadow root 中时，向该 root 注入一份自包含的 marker/popup
   * 规则；在 light DOM 中页面样式表本就生效，跳过注入。
   */
  private injectShadowStyles(): void {
    const container = this.view.container;
    // getRootNode 返回元素所属的 Document 或 ShadowRoot。
    const root = container?.getRootNode?.() as
      | ShadowRoot
      | Document
      | null
      | undefined;
    // light DOM（document）下页面样式表已覆盖，无需注入。
    if (!root || root === document) {
      return;
    }
    // 已注入过（同页多实例）则不重复注入。
    if (root.querySelector?.("style[data-geoagent-arcgis]")) {
      return;
    }
    const style = document.createElement("style");
    // data 属性既作防重复标记，也便于识别样式来源。
    style.dataset.geoagentArcgis = "";
    style.textContent = `
.geoagent-arcgis-marker-icon { background: transparent; border: none; }
.geoagent-arcgis-marker-icon svg { display: block; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35)); cursor: pointer; }
.geoagent-arcgis-popup-content {
  background: #ffffff;
  border-radius: 8px;
  padding: 8px 12px;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #1f2933;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.25);
  max-width: 260px;
  white-space: pre-wrap;
}
`;
    root.appendChild(style);
  }

  /** 返回被适配的原始 ArcGIS 视图，供需要直接操作 esri API 的宿主使用。 */
  getRawView(): ArcGISViewLike {
    return this.view;
  }

  /** 返回宿主传入的 esri 类 namespace。 */
  getNamespace(): ArcGISNamespace {
    return this.ns;
  }

  /** 被包装的视图是 SceneView（3D globe）还是 MapView。 */
  get isScene(): boolean {
    return isArcGISSceneView(this.view);
  }

  /** shim 只接受 Web Mercator 或 WGS84 的视图；其余空间参考如实报错。 */
  private validateSpatialReference(): void {
    const sr = this.view.spatialReference;
    if (!sr) {
      // 未暴露 spatialReference 时无从判断（mock/pre-frame 常见），放行。
      return;
    }
    // 布尔标记与 wkid 两种判定口径都要认（102100 是 3857 的旧别名）。
    const webMercator =
      sr.isWebMercator === true ||
      sr.wkid === 3857 ||
      sr.wkid === 102100;
    const wgs84 = sr.isWGS84 === true || sr.wkid === 4326;
    if (!webMercator && !wgs84) {
      throw new Error(
        `The ArcGIS engine reads Web Mercator (3857/102100) or WGS84 (4326) views; the view uses spatial reference ${sr.wkid ?? "unknown"}. Reproject the view or use a projected-basemap engine.`,
      );
    }
  }

  /** 拉取 GeoJSON URL；HTTP 非 2xx 时抛出带状态码的错误。 */
  async fetchGeoJson(url: string): Promise<unknown> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Could not fetch GeoJSON (${response.status}) from ${url}`,
      );
    }
    return response.json();
  }

  /* ------------------------------ 地图基础 -------------------------------- */

  /** 返回视图容器 DOM；marker/popup/控件都挂在这里。 */
  getContainer(): HTMLElement {
    return this.view.container;
  }

  /**
   * 当前中心点 { lng, lat }。优先读地理坐标 center.longitude/latitude；
   * center 为投影坐标（x/y）时退回用 extent 四至中点换算经纬度。
   */
  getCenter(): { lng: number; lat: number } {
    const center = this.view.center;
    if (
      typeof center?.longitude === "number" &&
      typeof center?.latitude === "number"
    ) {
      return { lng: center.longitude, lat: center.latitude };
    }
    // 投影坐标形式的 center（x/y 为视图空间参考下的坐标）。
    if (typeof center?.x === "number" && typeof center?.y === "number") {
      const bounds = this.extentLonLatBounds(this.view.extent);
      return { lng: (bounds.west + bounds.east) / 2, lat: (bounds.south + bounds.north) / 2 };
    }
    // 两种口径都拿不到（视图未就绪）时退化为原点。
    return { lng: 0, lat: 0 };
  }

  /**
   * 当前 zoom。MapView 直接读 view.zoom；SceneView 只有 scale，
   * 经标准 Web Mercator zoom↔scale 阶梯反推。
   */
  getZoom(): number {
    if (this.isScene) {
      // SceneView 暴露的是地图 scale 而非 tile zoom；用标准 Web Mercator
      // zoom↔scale 阶梯换算（zoom 0 = 591657527.59）。
      const scale = Number(this.view.scale ?? 0);
      return scale > 0 ? Math.log2(BASE_MAP_SCALE / scale) : 0;
    }
    const zoom = this.view.zoom;
    // zoom 缺失或非法时按 0 处理。
    return typeof zoom === "number" && Number.isFinite(zoom) ? zoom : 0;
  }

  /**
   * 视口尺寸 [width, height]。view.size 缺失或为 0 时退回容器的
   * clientWidth/clientHeight；两者都拿不到（jsdom、未布局）时给 512×512 兜底。
   */
  getSize(): [number, number] {
    const size = this.view.size;
    if (size && size.width > 0 && size.height > 0) {
      return [size.width, size.height];
    }
    const width = this.view.container?.clientWidth ?? 0;
    const height = this.view.container?.clientHeight ?? 0;
    // 零尺寸环境（jsdom、未布局）会让像素计算退化；退回一个正常方块，
    // 保证 hit-testing 仍可工作。
    return [width > 0 ? width : 512, height > 0 ? height : 512];
  }

  /**
   * MapLibre 的 bearing 是相对北方向顺时针的角度。SceneView 的 camera.heading
   * 是相机朝向的罗盘方向（顺时针），可直接映射；MapView 的 rotation 是
   * 逆时针定义，需要取负换算。
   */
  getBearing(): number {
    if (this.isScene) {
      // heading 归一化到 [0, 360)。
      const heading = Number(this.view.camera?.heading ?? 0);
      return ((heading % 360) + 360) % 360;
    }
    // rotation 逆时针 → MapLibre 顺时针：取 360 - rotation 再归一化。
    const rotation = Number(this.view.rotation ?? 0);
    return ((360 - rotation) % 360 + 360) % 360;
  }

  /**
   * MapLibre 的 pitch 是偏离天顶的角度；SceneView 的 camera.tilt 采用同一
   * 约定可直接映射。平面 MapView 没有 tilt，恒为 0。
   */
  getPitch(): number {
    if (this.isScene) {
      const tilt = Number(this.view.camera?.tilt ?? 0);
      return Number.isFinite(tilt) ? tilt : 0;
    }
    return 0;
  }

  /** 视图是否就绪（view.ready !== false 即视为已加载）。 */
  loaded(): boolean {
    return this.view.ready !== false;
  }

  /**
   * 把 ArcGIS Extent 换算成经纬度四至 { west, south, east, north }。
   * 空间参考优先取 extent 自带值，缺省退回 view.spatialReference；
   * Web Mercator 走换算，WGS84 直接使用，其余空间参考抛错。
   */
  private extentLonLatBounds(extent: ArcGISExtentLike): {
    west: number;
    south: number;
    east: number;
    north: number;
  } {
    const sr = extent.spatialReference ?? this.view.spatialReference;
    // 与 validateSpatialReference 相同的判定口径。
    const webMercator =
      sr?.isWebMercator === true || sr?.wkid === 3857 || sr?.wkid === 102100;
    const wgs84 = sr?.isWGS84 === true || sr?.wkid === 4326;
    let west = extent.xmin;
    let south = extent.ymin;
    let east = extent.xmax;
    let north = extent.ymax;
    if (webMercator) {
      // 墨卡托米制 → 经纬度。
      west = mercatorXToLon(extent.xmin);
      south = mercatorYToLat(extent.ymin);
      east = mercatorXToLon(extent.xmax);
      north = mercatorYToLat(extent.ymax);
    } else if (!wgs84) {
      // 既非墨卡托也非 WGS84：无法可靠换算，显式失败。
      throw new Error(
        `The ArcGIS engine reads Web Mercator or WGS84 extents; got spatial reference ${String(sr?.wkid ?? "unknown")}.`,
      );
    }
    return { west, south, east, north };
  }

  /** MapLibre 风格的 LngLatBounds 替身：提供 getWest()/getSouth()/… 方法。 */
  getBounds(): {
    getWest(): number;
    getSouth(): number;
    getEast(): number;
    getNorth(): number;
  } {
    const bounds = this.extentLonLatBounds(this.view.extent);
    return {
      getWest: () => bounds.west,
      getSouth: () => bounds.south,
      getEast: () => bounds.east,
      getNorth: () => bounds.north,
    };
  }

  /**
   * 当前视图的屏幕像素投影。视图暴露 `toScreen` 时（MapView 与 SceneView
   * 都有）优先用 SDK 的精确投影 —— 倾斜的 SceneView 必须用它，下面的
   * extent 线性插值在倾斜下会算错。否则退回基于 extent 四角的
   * "墨卡托线性插值"（pre-frame 的 MapView、mock、或 auto-cast 普通点对象
   * 被拒绝时）。回退路径不补偿视图旋转（与其他 shim 的限制一致）。
   */
  projectPoint(lat: number, lng: number): { x: number; y: number } {
    if (typeof this.view.toScreen === "function") {
      try {
        // 以 auto-cast 普通对象传入 WGS84 点，让 SDK 计算精确屏幕位置。
        const screen = this.view.toScreen({
          type: "point",
          longitude: lng,
          latitude: lat,
          spatialReference: { wkid: 4326 },
        }) as { x?: unknown; y?: unknown } | null | undefined;
        const x = Number(screen?.x);
        const y = Number(screen?.y);
        // toScreen 返回有限像素值才采用。
        if (Number.isFinite(x) && Number.isFinite(y)) {
          return { x, y };
        }
      } catch {
        // 普通对象 auto-cast 被拒绝 → 走下面的 extent 线性回退。
      }
    }
    // 回退：把墨卡托坐标在 extent 内做线性插值映射到像素。
    const [width, height] = this.getSize();
    const bounds = this.extentLonLatBounds(this.view.extent);
    const westX = lonToMercatorX(bounds.west);
    const eastX = lonToMercatorX(bounds.east);
    const southY = latToMercatorY(bounds.south);
    const northY = latToMercatorY(bounds.north);
    const x = lonToMercatorX(lng);
    const y = latToMercatorY(lat);
    const spanX = eastX - westX;
    const spanY = northY - southY;
    // 零跨度（退化 extent）时按 0 处理，避免除以 0。
    const px = spanX !== 0 ? ((x - westX) / spanX) * width : 0;
    const py = spanY !== 0 ? ((northY - y) / spanY) * height : 0;
    return { x: px, y: py };
  }

  /** 生成 [lng, lat] → 屏幕像素的投影闭包，供 hitTest 与 marker 定位复用。 */
  private screenProjector(): PixelProjector {
    return (coordinate) => this.projectPoint(coordinate[1], coordinate[0]);
  }

  /** 无动画跳转：center 用 auto-cast 普通对象设置；zoom 按视图种类分别写入。 */
  jumpTo(options: { center?: [number, number]; zoom?: number }): void {
    if (options.center) {
      this.view.center = { longitude: options.center[0], latitude: options.center[1] };
    }
    if (options.zoom !== undefined && options.zoom !== null) {
      if (this.isScene) {
        // SceneView 没有 zoom 属性，用等效 scale 表达。
        this.view.scale = zoomToScale(Number(options.zoom));
      } else {
        this.view.zoom = Number(options.zoom);
      }
    }
    // 中心/缩放变了，立即重投影 marker。
    this.syncMarkers();
  }

  /** 带动画飞行（约 1.2s），底层包装 view.goTo。 */
  flyTo(options: { center?: [number, number]; zoom?: number }): void {
    this.animateTo(options, { duration: 1200 });
  }

  /** 轻缓动画过渡（约 0.3s），底层包装 view.goTo。 */
  easeTo(options: { center?: [number, number]; zoom?: number }): void {
    this.animateTo(options, { duration: 300 });
  }

  /**
   * flyTo/easeTo 的公共实现：把 center/zoom 并入 goTo 目标对象后
   * fire-and-forget 调用，view 中途销毁导致的 reject 静默吞掉。
   */
  private animateTo(
    options: { center?: [number, number]; zoom?: number },
    animOptions: Record<string, unknown>,
  ): void {
    const target: Record<string, unknown> = { ...animOptions };
    if (options.center) {
      target.center = [options.center[0], options.center[1]];
    }
    if (options.zoom !== undefined && options.zoom !== null) {
      target.zoom = Number(options.zoom);
    }
    void Promise.resolve(this.view.goTo(target)).catch((error: unknown) => {
      // 视图中途销毁会让 goTo reject，属预期；其余失败至少告警，
      // 不向调用方静默掩盖动画未发生的事实。
      console.warn("ArcGIS engine: view.goTo failed:", error);
    });
  }

  /** 设置 zoom；SceneView 走 scale 换算，MapView 直接赋值。 */
  setZoom(zoom: number): void {
    if (this.isScene) {
      this.view.scale = zoomToScale(Number(zoom));
    } else {
      this.view.zoom = Number(zoom);
    }
    this.syncMarkers();
  }

  /**
   * 适配到给定的 [西南, 东北] 两角：构造 WGS84 extent 交给 goTo。
   * options 的 padding/maxZoom 在 ArcGIS 侧没有直接对应物，只能尽力而为。
   */
  fitBounds(
    corners: [[number, number], [number, number]],
    options?: { padding?: number; maxZoom?: number },
  ): void {
    const [[west, south], [east, north]] = corners;
    // WGS84 extent；SDK 会 auto-cast 并相对视图重投影。
    const extent = {
      xmin: west,
      ymin: south,
      xmax: east,
      ymax: north,
      spatialReference: { wkid: 4326 },
    };
    void Promise.resolve(this.view.goTo({ extent })).catch(() => {
      // 与 flyTo 相同的 fire-and-forget 契约。
    });
    // `padding`/`maxZoom` 在 ArcGIS 没有直接对应项；extent 适配是尽力而为
    // （已在引擎能力提示中注明）。
    void options;
  }

  /** 返回投影类型：SceneView 视为 globe，MapView 视为 mercator。 */
  getProjection(): { type: "mercator" } | { type: "globe" } {
    return this.isScene ? { type: "globe" } : { type: "mercator" };
  }

  /**
   * 校验投影设置：SceneView 只接受 "globe"（它本就渲染 globe）；MapView
   * 只接受 "mercator"。其余取值显式报错而非静默忽略。
   */
  setProjection(projection: unknown): void {
    // 兼容字符串与 { type } 对象两种传参形态。
    const type =
      typeof projection === "string"
        ? projection
        : isRecord(projection)
          ? String(projection.type ?? "")
          : "";
    if (this.isScene) {
      if (type === "globe") {
        // 全局 SceneView 本来就在渲染 globe，无需操作。
        return;
      }
      throw new Error(
        `The ArcGIS SceneView renders a 3D globe; projection "${type || "unknown"}" is not applicable. A flat map requires an ArcGIS MapView or a maplibre-gl map.`,
      );
    }
    if (type !== "mercator") {
      throw new Error(
        `The ArcGIS engine's MapView renders Web Mercator only; projection "${type || "unknown"}" is not supported. Globe rendering requires maplibre-gl, mapbox-gl, or an ArcGIS SceneView.`,
      );
    }
  }

  /* -------------------------------- 事件 ---------------------------------- */

  /** 透传 esri 视图的事件订阅，供上层工具挂接所需事件。 */
  on(type: string, listener: (event?: unknown) => void): this {
    // 保存句柄：off 时移除对应订阅，destroy 时统一注销外部监听者。
    const handle = this.view.on(type, listener);
    this.externalHandles.push({ type, listener, handle });
    return this;
  }

  /** 注销事件：移除 on() 登记的外部订阅（未登记的监听者忽略）。 */
  off(type: string, listener?: (event?: unknown) => void): this {
    for (let i = this.externalHandles.length - 1; i >= 0; i -= 1) {
      const item = this.externalHandles[i];
      if (item.type !== type) {
        continue;
      }
      // 未指定 listener 时移除该类型的全部外部订阅；指定时精确匹配。
      if (listener && item.listener !== listener) {
        continue;
      }
      item.handle.remove();
      this.externalHandles.splice(i, 1);
    }
    return this;
  }

  /**
   * 一次性事件。MapLibre 的两个关键事件在 esri 上不存在，需模拟：
   * "idle" 用 view.when()（已就绪时立即触发），"style.load" 挂入回调队列
   * 由 setStyle 冲刷；其余类型订阅一次、触发后立即移除句柄。
   */
  once(type: string, listener: (event?: unknown) => void): this {
    if (type === "idle") {
      // MapLibre 侧（waitForMapIdle）在每条命令前都等 "idle"；
      // ArcGIS 没有 idle 事件，用 when() 模拟（已就绪时立即触发）。
      if (typeof this.view.when === "function") {
        void Promise.resolve(this.view.when(() => listener())).catch(() => {
          // when() 报错（无 errback）时按已就绪处理，避免命令被卡死。
          listener();
        });
      } else {
        // 视图未暴露 when()（mock 场景）时直接视为就绪。
        listener();
      }
      return this;
    }
    if (type === "style.load") {
      // esri 视图从不触发 "style.load"；setStyle 在应用底图变更后
      // 于宏任务里冲刷这些回调。
      this.addStyleLoadCallback(listener);
      return this;
    }
    // 普通事件：触发一次后立刻移除句柄，保证只执行一次。
    const handle = this.view.on(type, () => {
      handle.remove();
      listener();
    });
    return this;
  }

  /** 派发事件：esri 视图不支持任意事件派发，这里不做事。 */
  fire(type: string, data?: Record<string, unknown>): this {
    // esri 视图没有任意事件的派发能力；setStyle 改用 setTimeout
    // 来 resolve "style.load" 的等待者。
    void type;
    void data;
    return this;
  }

  /* --------------------------- style 与 basemap ---------------------------- */

  /**
   * 把工具 basemap 注册表下发的 style 名/URL（DEFAULT_BASEMAPS 在 shim 看到
   * 之前就会把 "dark"/"positron"/… 解析掉）映射到它们所代表的 esri basemap。
   * 其余值交给 resolveBasemapStyle 处理为 agent 托管的 XYZ WebTileLayer。
   */
  private static basemapNameFor(style: unknown): string | undefined {
    if (typeof style === "string") {
      // 先查别名表（大小写不敏感），命中且是合法 esri basemap 才采用。
      const name = ARCGIS_BASEMAP_ALIASES[style.trim().toLowerCase()];
      if (name && ARCGIS_BASEMAPS.has(name)) {
        return name;
      }
    }
    if (typeof style !== "string") {
      return undefined;
    }
    // 再按已知 style URL 的特征串匹配到最接近的 esri basemap。
    const url = style.toLowerCase();
    if (url.includes("dark-matter")) {
      return "dark-gray";
    }
    if (url.includes("positron")) {
      return "light-gray";
    }
    if (url.includes("voyager")) {
      return "community";
    }
    if (url.includes("tile.openstreetmap.org") || url === "osm") {
      return "osm";
    }
    return undefined;
  }

  /**
   * 替换整个 style：命中 esri basemap 时直接切换 `map.basemap`；
   * 否则解析为 XYZ 模板并以 WebTileLayer 挂到图层集合最底层
   * （agent 托管底图）。两条路径最后都会冲刷 "style.load" 等待者。
   */
  setStyle(style: unknown): void {
    // 切换 esri basemap 是本引擎上"整体替换 style"的对应实现；工具的
    // basemap 注册表也可能把别名解析成上面的已知 style URL。
    const basemapName = ArcGISMapShim.basemapNameFor(style);
    if (basemapName) {
      this.view.map.basemap = basemapName;
      // esri basemap 接管底图后，agent 托管的 XYZ 底图不再需要。
      this.removeAgentBaseLayer();
      this.flushStyleLoadCallbacks();
      return;
    }
    const resolved = resolveBasemapStyle(style, "ArcGIS Maps SDK");
    // 旧的 agent 托管底图先摘除，避免叠两层。
    if (this.agentBaseLayer) {
      this.view.map.layers.remove(this.agentBaseLayer);
    }
    const tileLayer = new this.ns.WebTileLayer({
      urlTemplate: resolved.url,
      title: "geoagent-basemap",
    });
    tileLayer.opacity = 1;
    // 插到索引 0（最底层），保证业务图层盖在底图之上。
    this.view.map.layers.add(tileLayer, 0);
    this.agentBaseLayer = tileLayer;
    this.flushStyleLoadCallbacks();
  }

  /**
   * change_basemap 会等待 "style.load"；esri 视图永远不会触发它，所以
   * shim 在应用变更后于宏任务里 resolve 等待者（模仿 MapLibre 异步的
   * style.load 契约）。
   */
  private flushStyleLoadCallbacks(): void {
    window.setTimeout(() => {
      this.onStyleLoadCallbacks.forEach((cb) => cb());
      this.onStyleLoadCallbacks = [];
    }, 0);
  }

  /** 移除并清空 agent 托管的 XYZ 底图层（若存在）。 */
  private removeAgentBaseLayer(): void {
    if (this.agentBaseLayer) {
      this.view.map.layers.remove(this.agentBaseLayer);
      this.agentBaseLayer = null;
    }
  }

  // once("style.load") 的等待回调队列，由 setStyle 经 flushStyleLoadCallbacks 冲刷。
  private onStyleLoadCallbacks: Array<() => void> = [];

  /** once("style.load") 的挂接点：注册回调，setStyle 之后统一 resolve。 */
  private addStyleLoadCallback(callback: () => void): ArcGISWatchHandle {
    this.onStyleLoadCallbacks.push(callback);
    // 返回句柄，支持在冲刷前取消等待。
    return { remove: () => {
      const index = this.onStyleLoadCallbacks.indexOf(callback);
      if (index >= 0) {
        this.onStyleLoadCallbacks.splice(index, 1);
      }
    } };
  }

  /**
   * 还原一份 MapLibre 风格的 style 快照：version 8 加上当前 source/layer
   * 注册表的 spec 深拷贝，图层顺序与 layerOrder 一致。
   */
  getStyle(): GeoAgentStyleSnapshot {
    const sources: Record<string, Record<string, unknown>> = {};
    for (const [id, source] of this.sources) {
      sources[id] = cloneJson(source.spec);
    }
    const layers: Array<Record<string, unknown>> = [];
    for (const id of this.layerOrder) {
      const entry = this.layers.get(id);
      if (entry) {
        layers.push(cloneJson(entry.spec));
      }
    }
    // 注册表中的 spec 均按 Style-Spec 规格入库，此处还原类型视图。
    return { version: 8, sources, layers } as unknown as GeoAgentStyleSnapshot;
  }

  /**
   * ArcGIS 引擎不支持 raster-dem 地形：MapView 无地形通道，SceneView 的
   * 地形来自场景自带 ElevationLayers，瓦片格式不适用。调用即抛能力错误，
   * 与 Leaflet / OpenLayers shim 的行为一致。
   */
  setTerrain(_terrain: unknown): never {
    throw new Error(
      "Terrain (raster-dem) is not supported by the ArcGIS engine; use the scene's ground ElevationLayers or a maplibre-gl map.",
    );
  }

  /* --------------------------- source 与图层 ------------------------------- */

  /** 注册 source；id 重复时报错。类型校验由 ArcGisShimSource 构造器完成。 */
  addSource(id: string, spec: Record<string, unknown>): void {
    if (this.sources.has(id)) {
      throw new Error(`Source already exists: ${id}`);
    }
    this.sources.set(id, new ArcGisShimSource(this, id, spec));
  }

  /** 按 id 取 source 记录；不存在返回 undefined。 */
  getSource(id: string): ArcGisShimSource | undefined {
    return this.sources.get(id);
  }

  /** 删除 source；不存在或仍有图层依赖时报错（与 MapLibre 语义一致）。 */
  removeSource(id: string): void {
    const source = this.sources.get(id);
    if (!source) {
      throw new Error(`Source not found: ${id}`);
    }
    // 找出 spec.source 指向该 id 的活跃图层。
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
   * 注册并物化一个图层（fill/line/circle/symbol/raster）。依次校验
   * id、类型白名单、source 存在性与 beforeId，然后物化 esri 图层、
   * 按 zoom 范围设置初始可见性，插入 layerOrder 并重建集合顺序。
   */
  addLayer(spec: Record<string, unknown>, beforeId?: string): void {
    const id = String(spec.id ?? "");
    if (!id) {
      throw new Error("addLayer requires a layer id.");
    }
    if (this.layers.has(id)) {
      throw new Error(`Layer already exists: ${id}`);
    }
    const type = String(spec.type ?? "");
    // 类型白名单校验：fill-extrusion/heatmap/vector-tile 等明确告知去其他引擎。
    if (!GEOJSON_LAYER_TYPES.includes(type) && type !== "raster") {
      throw new Error(
        `The ArcGIS engine does not support "${type || "unknown"}" layers (layer "${id}"). Supported types: ${[...GEOJSON_LAYER_TYPES, "raster"].join(", ")}. Fill-extrusion, heatmap, and vector-tile layers require maplibre-gl or mapbox-gl.`,
      );
    }
    const sourceId = String(spec.source ?? "");
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new Error(`Cannot add layer ${id}; source not found: ${sourceId}`);
    }
    if (beforeId && !this.layerOrder.includes(beforeId)) {
      throw new Error(`Cannot add layer ${id}; beforeId not found: ${beforeId}`);
    }
    const layout = isRecord(spec.layout) ? spec.layout : {};
    const entry: ArcGisShimLayer = {
      id,
      type,
      source: sourceId,
      spec: cloneJson(spec),
      // layout.visibility === "none" 视为初始隐藏。
      visible: layout.visibility !== "none",
      esriLayer: null,
    };
    this.materializeLayer(entry);
    if (entry.esriLayer) {
      // 初始可见性 = 用户可见性 且 当前 zoom 在 minzoom/maxzoom 区间内。
      entry.esriLayer.visible = entry.visible && this.isEntryInZoomRange(entry);
    }
    this.layers.set(id, entry);
    // beforeId 语义与 MapLibre 一致：插到该图层之前；缺省追加到末尾（最上）。
    const insertIndex = beforeId
      ? this.layerOrder.indexOf(beforeId)
      : this.layerOrder.length;
    this.layerOrder.splice(insertIndex, 0, id);
    this.syncLayerOrder();
  }

  /** 按 id 返回图层 spec（注册表中的引用）；不存在返回 undefined。 */
  getLayer(id: string): Record<string, unknown> | undefined {
    return this.layers.get(id)?.spec;
  }

  /** 移除图层：先摘 esri 图层实例，再清注册表与顺序表。 */
  removeLayer(id: string): void {
    const entry = this.layers.get(id);
    if (!entry) {
      throw new Error(`Layer not found: ${id}`);
    }
    if (entry.esriLayer) {
      this.view.map.layers.remove(entry.esriLayer);
    }
    this.layers.delete(id);
    this.layerOrder = this.layerOrder.filter((layerId) => layerId !== id);
  }

  /**
   * 调整图层顺序（MapLibre 语义：移到 beforeId 之前，缺省移到最上）。
   * 只改 layerOrder，再由 syncLayerOrder 重建 esri 集合。
   */
  moveLayer(id: string, beforeId?: string): void {
    if (!this.layers.has(id)) {
      throw new Error(`Layer not found: ${id}`);
    }
    if (beforeId && !this.layers.has(beforeId)) {
      throw new Error(`Layer not found: ${beforeId}`);
    }
    this.layerOrder = this.layerOrder.filter((layerId) => layerId !== id);
    const insertIndex = beforeId
      ? this.layerOrder.indexOf(beforeId)
      : this.layerOrder.length;
    this.layerOrder.splice(insertIndex, 0, id);
    this.syncLayerOrder();
  }

  /** 重建 esri 图层集合，使注册表顺序（layerOrder）真正生效。 */
  private syncLayerOrder(): void {
    const collection = this.view.map.layers;
    // 先把 shim 管理的所有图层从集合中摘除。
    for (const entry of this.layers.values()) {
      if (entry.esriLayer) {
        collection.remove(entry.esriLayer);
      }
    }
    // agent 托管底图重新插回索引 0，保持最底层。
    if (this.agentBaseLayer) {
      collection.remove(this.agentBaseLayer);
      collection.add(this.agentBaseLayer, 0);
    }
    // 按 layerOrder 顺序重新加入（后加入的在上方）。
    for (const id of this.layerOrder) {
      const entry = this.layers.get(id);
      if (entry?.esriLayer) {
        collection.add(entry.esriLayer);
      }
    }
  }

  /**
   * 更新 paint 属性。raster 的 raster-opacity 直接映射到 esri 图层 opacity；
   * 其余属性在 ArcGIS 上烘进每个 Graphic 的 symbol，必须重建图层。
   */
  setPaintProperty(id: string, property: string, value: unknown): void {
    const entry = this.requireLayer(id);
    const paint = isRecord(entry.spec.paint) ? { ...entry.spec.paint } : {};
    paint[property] = value;
    entry.spec.paint = paint;
    if (entry.type === "raster" && property === "raster-opacity") {
      // WebTileLayer 支持实时 opacity，无需重建。
      if (entry.esriLayer) {
        entry.esriLayer.opacity = clamp01(Number(value));
      }
      return;
    }
    // ArcGIS 上 symbol 是逐 Graphic 烘焙的；refresh 会重新物化图层。
    this.refreshLayer(entry);
  }

  /**
   * 更新 layout 属性。visibility 直接改 esri 图层可见性（再与 zoom 范围
   * 取与）；其余 layout（如 text-field）影响逐要素 symbol，走重建。
   */
  setLayoutProperty(id: string, property: string, value: unknown): void {
    const entry = this.requireLayer(id);
    const layout = isRecord(entry.spec.layout) ? { ...entry.spec.layout } : {};
    layout[property] = value;
    entry.spec.layout = layout;
    if (property === "visibility") {
      entry.visible = value !== "none";
      // 有效可见性仍要与 zoom 范围相与。
      if (entry.esriLayer) {
        entry.esriLayer.visible = entry.visible && this.isEntryInZoomRange(entry);
      }
      return;
    }
    this.refreshLayer(entry);
  }

  /** 设置/清除图层 filter；filter 参与逐要素筛选，需重建图层生效。 */
  setFilter(id: string, filter: unknown): void {
    const entry = this.requireLayer(id);
    if (filter === null || filter === undefined) {
      delete entry.spec.filter;
    } else {
      entry.spec.filter = cloneJson(filter);
    }
    this.refreshLayer(entry);
  }

  /** 按 id 取图层记录；不存在则抛错。被各 set/move 方法复用。 */
  private requireLayer(id: string): ArcGisShimLayer {
    const entry = this.layers.get(id);
    if (!entry) {
      throw new Error(`Layer not found: ${id}`);
    }
    return entry;
  }

  /** 当前 zoom 是否落在图层 spec 的 [minzoom, maxzoom) 区间内。 */
  private isEntryInZoomRange(entry: ArcGisShimLayer): boolean {
    const zoom = this.getZoom();
    const spec = entry.spec;
    // 低于 minzoom 或达到 maxzoom（左闭右开）都判为范围外。
    if (typeof spec.minzoom === "number" && zoom < spec.minzoom) {
      return false;
    }
    if (typeof spec.maxzoom === "number" && zoom >= spec.maxzoom) {
      return false;
    }
    return true;
  }

  /** zoom 变化后统一刷新所有图层的有效可见性（用户可见性 ∧ zoom 范围）。 */
  private syncVisibilityAll(): void {
    for (const id of this.layerOrder) {
      const entry = this.layers.get(id);
      if (entry?.esriLayer) {
        entry.esriLayer.visible = entry.visible && this.isEntryInZoomRange(entry);
      }
    }
  }

  /* ------------------------------ 物化 ------------------------------------- */

  /**
   * 把注册表里的图层 spec 物化成真正的 esri 图层实例并写入 entry.esriLayer。
   * raster → WebTileLayer（取 source 的第一个 tiles 模板并套 raster-opacity）；
   * 其余类型要求 geojson source，走 buildFeatureLayer。
   */
  private materializeLayer(entry: ArcGisShimLayer): void {
    if (entry.type === "raster") {
      const source = this.sources.get(entry.source);
      const tiles = Array.isArray(source?.spec.tiles)
        ? (source?.spec.tiles as unknown[])
        : [];
      // 没有 tiles 模板就无法构造 WebTileLayer。
      if (typeof tiles[0] !== "string") {
        throw new Error(
          `Raster layer ${entry.id} needs a raster source with a tiles URL template.`,
        );
      }
      const paint = isRecord(entry.spec.paint) ? entry.spec.paint : {};
      const layer = new this.ns.WebTileLayer({
        urlTemplate: tiles[0],
        title: entry.id,
      });
      // raster-opacity 映射为 esri 图层透明度。
      layer.opacity = clamp01(Number(paint["raster-opacity"] ?? 1));
      entry.esriLayer = layer;
      return;
    }
    const source = this.sources.get(entry.source);
    if (!source || source.type !== "geojson") {
      // 除 raster 外的所有图层类型都依赖 geojson source。
      throw new Error(
        `${entry.type} layers on the ArcGIS engine require a geojson source (source "${entry.source}" is ${source?.type ?? "missing"}).`,
      );
    }
    entry.esriLayer = this.buildFeatureLayer(entry, source);
  }

  /**
   * 重建图层实例（paint/layout/filter 变更后调用）。raster 只带 opacity
   * 无需重建；geojson 图层先移除旧实例、重新物化并挂回集合，最后用
   * syncLayerOrder 恢复注册顺序。
   */
  /**
   * source 数据变化后重建依赖它的已物化图层（URL GeoJSON 异步到达时调用）。
   * 仅矢量图层依赖 source 数据；raster 图层无需重建。
   */
  refreshLayersForSource(sourceId: string): void {
    for (const entry of this.layers.values()) {
      if (entry.source === sourceId) {
        this.refreshLayer(entry);
      }
    }
  }

  private refreshLayer(entry: ArcGisShimLayer): void {
    if (entry.type === "raster") {
      // raster 图层的 paint 只有 opacity（已直接映射），无需重建。
      return;
    }
    const source = this.sources.get(entry.source);
    if (!source) {
      return;
    }
    const previous = entry.esriLayer;
    // 旧位置仅作占位（顺序恢复靠 syncLayerOrder），未参与后续逻辑。
    const index = this.layerOrder.indexOf(entry.id);
    if (previous) {
      this.view.map.layers.remove(previous);
    }
    this.materializeLayer(entry);
    if (entry.esriLayer) {
      // 重建后按用户可见性与 zoom 范围重新计算可见性。
      entry.esriLayer.visible = entry.visible && this.isEntryInZoomRange(entry);
      this.view.map.layers.add(entry.esriLayer);
      if (previous) {
        // 重建会把图层放到最上层；用 syncLayerOrder 恢复注册顺序。
        this.syncLayerOrder();
      }
    }
    void index;
  }

  /**
   * 客户端 FeatureLayer 字段声明的字段名清洗器：非法字符替换为下划线、
   * 数字开头加前缀，并与已用名去重（追加序号）。
   */
  private static esriFieldName(name: string, used: Set<string>): string {
    // esri 字段名只允许字母/数字/下划线，其余替换为下划线。
    let field = name.replace(/[^a-zA-Z0-9_]/g, "_");
    // 字段名不能以数字开头。
    if (/^[0-9]/.test(field)) {
      field = `f_${field}`;
    }
    // 空名兜底。
    if (!field) {
      field = "field";
    }
    // 与已用名冲突时追加序号（name_2、name_3…）。
    let unique = field;
    let index = 2;
    while (used.has(unique)) {
      unique = `${field}_${index}`;
      index += 1;
    }
    used.add(unique);
    return unique;
  }

  /**
   * 把 geojson source 的（可能聚合后的）要素物化为客户端 FeatureLayer：
   * 以多数几何类型过滤要素并套 filter，构建字段表（属性名清洗 + 类型推断），
   * 为每个要素生成携带逐要素 symbol 的 Graphic，并以 simple renderer 兜底。
   */
  private buildFeatureLayer(
    entry: ArcGisShimLayer,
    source: ArcGisShimSource,
  ): ArcGISLayerLike {
    // 聚合 source 取当前 zoom 下的实际渲染要素。
    const features = source.resolvedFeatures();
    const zoom = this.getZoom();
    const spec = entry.spec;
    // 客户端 FeatureLayer 只接受单一几何类型；取多数几何类型并丢弃其他
    // 类型的要素（与 MapLibre 按几何类型过滤渲染的图层一致）。
    const geometryType = geometryTypeForFeatures(features);
    const usable = features.filter(
      (feature) =>
        geojsonToEsriGeometryType(feature.geometry?.type) === geometryType &&
        this.featurePassesFilter(spec, feature, zoom),
    );
    // 原始属性名 → 清洗后 esri 字段名的映射。
    const fieldMap = new Map<string, string>();
    // 已占用字段名集合，预置主键 __geoagent_oid。
    const used = new Set<string>(["__geoagent_oid"]);
    for (const feature of usable) {
      // 每个要素最多收录前 100 个属性作为字段，防止字段爆炸。
      for (const key of Object.keys(feature.properties ?? {}).slice(0, 100)) {
        if (!fieldMap.has(key)) {
          fieldMap.set(key, ArcGISMapShim.esriFieldName(key, used));
        }
      }
    }
    const fields = [
      { name: "__geoagent_oid", type: "oid" },
      // 用第一个非空样本推断字段类型：number → double，否则 string。
      ...Array.from(fieldMap.entries()).map(([name, field]) => ({
        name: field,
        type:
          typeof (usable.find((feature) => feature.properties?.[name] != null)
            ?.properties?.[name]) === "number"
            ? "double"
            : "string",
      })),
    ];
    const graphics = usable.map((feature, index) => {
      const attributes: Record<string, unknown> = { __geoagent_oid: index };
      for (const [key, value] of Object.entries(feature.properties ?? {})) {
        const field = fieldMap.get(key);
        if (field) {
          // 原始值（number/string/boolean）直接入属性；其余序列化为 JSON。
          attributes[field] =
            typeof value === "number" || typeof value === "string" ||
            typeof value === "boolean"
              ? value
              : JSON.stringify(value);
        }
      }
      return new this.ns.Graphic({
        geometry: geojsonToEsriGeometry(feature.geometry),
        attributes,
        // 逐要素 symbol 承载 data-driven paint（按该要素求值表达式）。
        symbol: this.symbolFor(spec, feature, zoom),
      });
    });
    // simple renderer 兜底覆盖偶尔缺 symbol 的 Graphic；逐要素 symbol
    // 永远优先。
    const paint = isRecord(spec.paint) ? spec.paint : {};
    const context = featureContextFor(undefined, zoom);
    const rendererSymbol =
      entry.type === "fill"
        ? this.fillSymbolFor(paint, context)
        : entry.type === "line"
          ? this.lineSymbolFor(paint, context)
          : entry.type === "circle"
            ? this.circleSymbolFor(paint, context)
            : undefined;
    return new this.ns.FeatureLayer({
      source: graphics,
      objectIdField: "__geoagent_oid",
      fields,
      geometryType,
      spatialReference: { wkid: 4326 },
      title: entry.id,
      renderer: rendererSymbol
        ? { type: "simple", symbol: rendererSymbol }
        : undefined,
    });
  }

  /** 判断要素是否通过图层 filter（MapLibre 表达式求值）；无 filter 恒通过。 */
  private featurePassesFilter(
    spec: Record<string, unknown>,
    feature: GeoJSON.Feature,
    zoom: number,
  ): boolean {
    if (!spec.filter) {
      return true;
    }
    return expressionTruthy(
      evaluateExpression(spec.filter, featureContextFor(feature, zoom)),
    );
  }

  /**
   * fill 图层的 paint → SimpleFillSymbol（fill-color/fill-opacity/
   * fill-outline-color）。
   */
  private fillSymbolFor(
    paint: Record<string, unknown>,
    context: ExpressionContext,
  ): unknown {
    // MapLibre 的 fill 只有设置了 fill-outline-color 才有轮廓，且
    // fill-opacity 作用于整个图层（包括该轮廓）。
    const fillOpacity = numberValueFrom(paint["fill-opacity"], context, 1);
    const outlineColor = paint["fill-outline-color"];
    return new this.ns.SimpleFillSymbol({
      color: withOpacity(
        colorValueFrom(paint["fill-color"], context, "#1c7ed6"),
        fillOpacity,
      ),
      // 未设置轮廓色时 outline 显式置 null，避免 esri 画默认描边。
      outline:
        outlineColor != null
          ? new this.ns.SimpleLineSymbol({
              color: withOpacity(
                colorValueFrom(outlineColor, context, "#1c7ed6"),
                fillOpacity,
              ),
              width: 1,
              style: "solid",
            })
          : null,
    });
  }

  /** line 图层的 paint → SimpleLineSymbol（line-color/line-opacity/line-width）。 */
  private lineSymbolFor(
    paint: Record<string, unknown>,
    context: ExpressionContext,
  ): unknown {
    return new this.ns.SimpleLineSymbol({
      color: withOpacity(
        colorValueFrom(paint["line-color"], context, "#1c7ed6"),
        numberValueFrom(paint["line-opacity"], context, 1),
      ),
      // 线宽下限 0.5，避免 esri 渲染出不可见的 0 宽线。
      width: Math.max(0.5, numberValueFrom(paint["line-width"], context, 1)),
      style: "solid",
    });
  }

  /**
   * circle 图层的 paint → SimpleMarkerSymbol。注意 MapLibre 的 circle-radius
   * 是像素半径，esri 的 marker size 是直径，因此乘 2；circle-stroke-width
   * 大于 0 时附加 outline。
   */
  private circleSymbolFor(
    paint: Record<string, unknown>,
    context: ExpressionContext,
  ): unknown {
    const strokeWidth = numberValueFrom(paint["circle-stroke-width"], context, 0);
    return new this.ns.SimpleMarkerSymbol({
      color: withOpacity(
        colorValueFrom(paint["circle-color"], context, "#1c7ed6"),
        numberValueFrom(paint["circle-opacity"], context, 1),
      ),
      // 半径 × 2 换算成直径，直径下限 1。
      size: Math.max(1, numberValueFrom(paint["circle-radius"], context, 5) * 2),
      outline:
        strokeWidth > 0
          ? new this.ns.SimpleLineSymbol({
              color: withOpacity(
                colorValueFrom(
                  paint["circle-stroke-color"],
                  context,
                  "#ffffff",
                ),
                numberValueFrom(paint["circle-stroke-opacity"], context, 1),
              ),
              width: strokeWidth,
              style: "solid",
            })
          : null,
    });
  }

  /**
   * symbol 图层的单要素 paint/layout → TextSymbol：text-field 求值文案、
   * text-size/text-color，固定深色 halo（描边）保证任意底图上可读。
   */
  private textSymbolFor(
    spec: Record<string, unknown>,
    feature: GeoJSON.Feature,
    zoom: number,
  ): unknown {
    const paint = isRecord(spec.paint) ? spec.paint : {};
    const layout = isRecord(spec.layout) ? spec.layout : {};
    const context = featureContextFor(feature, zoom);
    const text = textFieldTextFrom(layout["text-field"], context);
    // 字号下限 4，避免过小不可见。
    const size = Math.max(4, numberValueFrom(layout["text-size"], context, 12));
    return new this.ns.TextSymbol({
      text,
      color: colorValueFrom(paint["text-color"], context, "#ffffff"),
      haloColor: "rgba(0, 0, 0, 0.85)",
      haloSize: 1.5,
      font: { size, family: "sans-serif", weight: "bold" },
    });
  }

  /** 按图层类型把单要素 spec 分发到对应 symbol 工厂；未知类型返回 undefined。 */
  private symbolFor(
    spec: Record<string, unknown>,
    feature: GeoJSON.Feature,
    zoom: number,
  ): unknown {
    const paint = isRecord(spec.paint) ? spec.paint : {};
    const context = featureContextFor(feature, zoom);
    switch (String(spec.type ?? "")) {
      case "fill":
        return this.fillSymbolFor(paint, context);
      case "line":
        return this.lineSymbolFor(paint, context);
      case "circle":
        return this.circleSymbolFor(paint, context);
      case "symbol":
        return this.textSymbolFor(spec, feature, zoom);
      default:
        return undefined;
    }
  }

  /* -------------------------------- 查询 ---------------------------------- */

  /**
   * 为 query_rendered_features 的默认中心点计算提供最小 canvas 表面。
   * 直接截取 canvas 在本引擎没有意义（工具改用 takeScreenshot），
   * 因此 toDataURL 抛出如实的能力错误。
   */
  getCanvas(): {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    toDataURL(): string;
  } {
    const [width, height] = this.getSize();
    return {
      clientWidth: width,
      clientHeight: height,
      width,
      height,
      toDataURL(): never {
        throw new Error(
          "Direct canvas capture is not supported by the ArcGIS engine; use screenshot_map (view.takeScreenshot), which composites the view client-side.",
        );
      },
    };
  }

  /**
   * 查询 source 的当前要素（含聚合结果）。仅 geojson source 有数据，
   * raster 等返回空数组；options.filter 以 MapLibre 表达式逐要素求值。
   */
  querySourceFeatures(
    sourceId: string,
    options?: { sourceLayer?: string; filter?: unknown },
  ): GeoJSON.Feature[] {
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new Error(`Source not found: ${sourceId}`);
    }
    if (source.type !== "geojson") {
      // raster 等 source 没有要素可查。
      return [];
    }
    const zoom = this.getZoom();
    return source.resolvedFeatures().filter((feature) => {
      if (!options?.filter) {
        return true;
      }
      return expressionTruthy(
        evaluateExpression(options.filter, featureContextFor(feature, zoom)),
      );
    });
  }

  /**
   * 屏幕点命中查询：按 layerOrder 顺序遍历各图层，对"可见、在 zoom 范围内、
   * （指定了 layers 时）在目标集合内"的 geojson 图层逐要素做屏幕 hit-test，
   * 命中即收集，上限 50 条。
   */
  queryRenderedFeatures(
    point: [number, number],
    options?: { layers?: string[] },
  ): Array<Record<string, unknown>> {
    const [x, y] = point;
    const wanted = options?.layers;
    const zoom = this.getZoom();
    const toPixel = this.screenProjector();
    const results: Array<Record<string, unknown>> = [];
    for (const id of this.layerOrder) {
      // 结果上限 50，防止大图集拖垮响应。
      if (results.length >= 50) {
        break;
      }
      const entry = this.layers.get(id);
      // 跳过隐藏图层与 zoom 范围外的图层。
      if (!entry || !entry.visible || !this.isEntryInZoomRange(entry)) {
        continue;
      }
      // options.layers 指定了目标图层集合时按其过滤。
      if (wanted && wanted.length > 0 && !wanted.includes(id)) {
        continue;
      }
      // raster 图层没有可查询的要素。
      if (!GEOJSON_LAYER_TYPES.includes(String(entry.spec.type))) {
        continue;
      }
      const source = this.sources.get(String(entry.spec.source ?? ""));
      if (!source || source.type !== "geojson") {
        continue;
      }
      for (const feature of source.resolvedFeatures()) {
        if (!this.featurePassesFilter(entry.spec, feature, zoom)) {
          continue;
        }
        // 逐要素做屏幕空间 hit-test（点/线/面/symbol 各有判定）。
        if (
          hitTestFeature(entry.spec, feature, x, y, toPixel,
            featureContextFor(feature, zoom))
        ) {
          results.push(feature as unknown as Record<string, unknown>);
        }
      }
    }
    return results;
  }

  /* -------------------------------- 截图 ---------------------------------- */

  /**
   * `screenshot_map`：MapView 通过 takeScreenshot 真正支持截图
   * （在客户端合成 basemap + 各图层）。
   */
  async takeScreenshot(): Promise<{
    data_url: string;
    width: number;
    height: number;
  }> {
    if (typeof this.view.takeScreenshot !== "function") {
      // 视图未暴露 takeScreenshot 时如实报错。
      throw new Error(
        "screenshot_map requires a MapView with takeScreenshot(); this view does not expose it.",
      );
    }
    // 以 PNG 格式请求截图（客户端合成底图与图层）。
    const screenshot = await this.view.takeScreenshot({ format: "png" });
    const dataUrl = screenshot?.dataUrl;
    if (!dataUrl) {
      throw new Error("The ArcGIS view did not return a screenshot data URL.");
    }
    return {
      data_url: dataUrl,
      width: screenshot?.data?.width ?? 0,
      height: screenshot?.data?.height ?? 0,
    };
  }

  /* --------------------------- marker 与 popup ----------------------------- */

  /**
   * 围绕视图容器内一个定位 DOM 元素实现的 GeoAgentMarker 兼容包装
   * （ArcGIS 没有 marker 原生件）。位置通过构造时注册的 watch 句柄
   * 跟随视图变化。
   */
  createMarker(color?: string): {
    setLngLat(lngLat: [number, number]): unknown;
    addTo(map: unknown): unknown;
    setPopup(popup: unknown): unknown;
    getElement(): HTMLElement;
    remove(): unknown;
  } {
    // 颜色先清洗，防止注入内联 SVG。
    const safeColor = sanitizeCssColor(color || "#3388ff");
    const element = document.createElement("div");
    element.className = "geoagent-arcgis-marker-icon";
    // 内联 SVG 画一个带白色圆心的水滴形 marker。
    element.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 36" width="26" height="36"><path d="M13 0C5.8 0 0 5.8 0 13c0 9.8 11.6 22.2 12.1 22.7.5.5 1.3.5 1.8 0C14.4 35.2 26 22.8 26 13 26 5.8 20.2 0 13 0z" fill="${safeColor}"/><circle cx="13" cy="13" r="5.5" fill="#ffffff"/></svg>`;
    const container = this.view.container;
    const wrapper: MarkerWrapper = {
      element,
      lngLat: null,
      popupElement: null,
    };
    this.markers.add(wrapper);
    const self = {
      setLngLat: (lngLat: [number, number]): unknown => {
        wrapper.lngLat = [lngLat[0], lngLat[1]];
        // 锚点变了，立即重投影。
        this.syncMarkers();
        return self;
      },
      addTo: (_map: unknown): unknown => {
        // 绝对定位并把锚点对到图标底端（26×36 图标的尖端偏移）。
        element.style.position = "absolute";
        element.style.transform = "translate(-13px, -36px)";
        element.style.zIndex = "30";
        element.style.pointerEvents = "auto";
        element.style.cursor = "pointer";
        container.appendChild(element);
        this.syncMarkers();
        return self;
      },
      setPopup: (popup: unknown): unknown => {
        // popup 内容只接受 shim 的 createPopup 产物。
        const content = extractArcGISPopupElement(popup);
        if (!content) {
          return self;
        }
        wrapper.popupElement = content;
        // 点击 marker 展示 popup；stopPropagation 避免触发视图 click
        // 而立即收起。
        element.addEventListener("click", (event) => {
          event.stopPropagation();
          if (!wrapper.lngLat) {
            return;
          }
          this.showMarkerPopup(wrapper);
        });
        return self;
      },
      getElement: (): HTMLElement => element,
      remove: (): unknown => {
        // 摘除 popup 与元素本体，并从注册表注销。
        if (wrapper.popupElement?.parentNode) {
          wrapper.popupElement.parentNode.removeChild(wrapper.popupElement);
        }
        if (element.parentNode) {
          element.parentNode.removeChild(element);
        }
        this.markers.delete(wrapper);
        return undefined;
      },
    };
    // 回填 remove 引用：shim destroy 时据此清理所有存活 marker
    // （wrapper 本身没有可调用的 remove 方法，不回填会导致清理空操作）。
    wrapper.remove = () => {
      self.remove();
    };
    return self;
  }

  /**
   * 展示 marker 的 popup：挂进视图容器并按锚点定位（锚点上方 44px，
   * 水平居中、底部对齐水滴尖端）。
   */
  private showMarkerPopup(wrapper: MarkerWrapper): void {
    if (!wrapper.lngLat || !wrapper.popupElement) {
      return;
    }
    const popup = wrapper.popupElement;
    // 样式类在 shadow root 场景依赖注入的样式副本。
    popup.classList.add("geoagent-arcgis-popup-content");
    popup.style.position = "absolute";
    popup.style.zIndex = "31";
    popup.style.pointerEvents = "auto";
    this.view.container.appendChild(popup);
    const toPixel = this.screenProjector();
    const px = toPixel(wrapper.lngLat);
    popup.style.left = `${px.x}px`;
    // top 再上移 44px，让气泡出现在水滴尖端上方。
    popup.style.top = `${Math.max(0, px.y - 44)}px`;
    popup.style.transform = "translate(-50%, -100%)";
  }

  /** 把所有已展示的 marker popup 从 DOM 摘除（wrapper 仍保留可再次展示）。 */
  private hideMarkerPopups(): void {
    for (const wrapper of this.markers) {
      if (wrapper.popupElement?.parentNode) {
        wrapper.popupElement.parentNode.removeChild(wrapper.popupElement);
      }
    }
  }

  /**
   * 把每个 marker 重投影到当前屏幕位置（视图 zoom/extent/rotation/camera
   * 变化时由构造函数的 watch 触发）；已展示的 popup 跟随移动。
   */
  private syncMarkers(): void {
    if (this.markers.size === 0) {
      // 无 marker 时跳过投影计算。
      return;
    }
    const toPixel = this.screenProjector();
    for (const wrapper of this.markers) {
      if (!wrapper.lngLat) {
        // 尚未 setLngLat 的 marker 没有锚点可投影。
        continue;
      }
      const px = toPixel(wrapper.lngLat);
      wrapper.element.style.left = `${px.x}px`;
      wrapper.element.style.top = `${px.y}px`;
      // 只跟随已挂载且定位过的 popup。
      if (
        wrapper.popupElement?.parentNode &&
        wrapper.popupElement.style.position === "absolute"
      ) {
        wrapper.popupElement.style.left = `${px.x}px`;
        wrapper.popupElement.style.top = `${Math.max(0, px.y - 44)}px`;
      }
    }
  }

  /** 围绕 popup 内容元素实现的 GeoAgentPopup 兼容包装。 */
  createPopup(): {
    setText(text: string): unknown;
    __geoAgentArcGISPopupElement: HTMLElement;
  } {
    const element = document.createElement("div");
    element.className = "geoagent-arcgis-popup-content";
    const self = {
      setText(text: string): unknown {
        // 用 textContent —— 模型提供的 popup 文本绝不能被当作 HTML 渲染。
        element.textContent = text;
        return self;
      },
      __geoAgentArcGISPopupElement: element,
    };
    return self;
  }

  /* -------------------------------- 清理 ---------------------------------- */

  /**
   * 注销 shim 的 watch/on 监听。由工具层在 dispose 时调用；若不调用，
   * 重复挂接同一视图会每次泄漏一组监听器，且残留 handler 会持续
   * 同步已脱离的图层。
   */
  destroy(): void {
    // 逐个移除 camera/zoom/extent/rotation watch。
    for (const handle of this.watchHandles) {
      handle.remove();
    }
    this.watchHandles.length = 0;
    if (this.clickHandle) {
      // 移除 click 监听。
      this.clickHandle.remove();
      this.clickHandle = null;
    }
    // 注销 on() 登记的全部外部订阅，避免监听者随 shim 泄漏。
    for (const item of this.externalHandles) {
      item.handle.remove();
    }
    this.externalHandles.length = 0;
    for (const wrapper of Array.from(this.markers)) {
      // 经 createMarker 回填的 remove() 摘除 DOM 元素并从注册表注销。
      wrapper.remove?.();
    }
    this.markers.clear();
  }
}

/**
 * 取要素集合的"主"几何类型：返回第一个能映射到 esri 几何类型的要素类型；
 * 全都无法映射时退回 "point"。
 */
function geometryTypeForFeatures(features: GeoJSON.Feature[]): string {
  for (const feature of features) {
    const type = geojsonToEsriGeometryType(feature.geometry?.type);
    if (type) {
      return type;
    }
  }
  return "point";
}

/**
 * GeoJSON 几何类型 → esri geometryType（point/polyline/polygon）；
 * 无法映射的类型（如 GeometryCollection）返回空串。
 */
function geojsonToEsriGeometryType(type: string | undefined): string {
  const normalized = normalizeGeometryType(String(type ?? ""));
  switch (normalized) {
    case "Point":
      return "point";
    case "LineString":
      return "polyline";
    case "Polygon":
      return "polygon";
    default:
      return "";
  }
}

/**
 * GeoJSON 几何 → ArcGIS SDK 可接受的 auto-cast 普通对象（WGS84 经纬度）。
 * Multi* 变体合并为对应的 paths/rings 数组。
 */
function geojsonToEsriGeometry(geometry: GeoJSON.Geometry | null | undefined):
  | Record<string, unknown>
  | null {
  if (!geometry) {
    return null;
  }
  // 显式声明 WGS84 空间参考。
  const sr = { wkid: 4326 };
  switch (geometry.type) {
    case "Point":
    case "MultiPoint": {
      const coords =
        geometry.type === "Point"
          ? [geometry.coordinates]
          : geometry.coordinates;
      // esri point 只能表达单点，取第一个有效坐标。
      const first = coords.find(
        (coord) =>
          Array.isArray(coord) &&
          Number.isFinite(coord[0]) &&
          Number.isFinite(coord[1]),
      );
      if (!first) {
        // 没有任何有效坐标时丢弃该几何。
        return null;
      }
      return { type: "point", longitude: first[0], latitude: first[1] };
    }
    case "LineString":
    case "MultiLineString": {
      // LineString 包一层 paths；MultiLineString 本身就是 paths 形态。
      const paths =
        geometry.type === "LineString"
          ? [geometry.coordinates]
          : geometry.coordinates;
      return { type: "polyline", paths, spatialReference: sr };
    }
    case "Polygon":
    case "MultiPolygon": {
      // Polygon 的 rings 直接使用；MultiPolygon 把各面的环拉平进同一数组。
      const rings =
        geometry.type === "Polygon"
          ? geometry.coordinates
          : geometry.coordinates.flat();
      return { type: "polygon", rings, spatialReference: sr };
    }
    default:
      return null;
  }
}

/** 从 popup 包装对象中取出内容元素；非 shim 的 createPopup 产物返回 null。 */
function extractArcGISPopupElement(popup: unknown): HTMLElement | null {
  if (
    isRecord(popup) &&
    (popup as { __geoAgentArcGISPopupElement?: unknown })
      .__geoAgentArcGISPopupElement instanceof HTMLElement
  ) {
    return (popup as { __geoAgentArcGISPopupElement: HTMLElement })
      .__geoAgentArcGISPopupElement;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 工厂函数与控件挂载                                                          */
/* -------------------------------------------------------------------------- */

/** 工厂函数：用视图与 esri namespace 构造 ArcGISMapShim。 */
export function createArcGISMapShim(
  map: ArcGISViewLike,
  namespace: Record<string, unknown>,
): ArcGISMapShim {
  return new ArcGISMapShim(map, namespace);
}

/** 判断某值是否为本模块创建的 ArcGISMapShim 实例。 */
export function isArcGISMapShim(value: unknown): value is ArcGISMapShim {
  return value instanceof ArcGISMapShim;
}

/** 挂载句柄：remove() 把控件从视图上摘除。 */
export interface ArcGISControlAttachment {
  remove(): void;
}

/** 控件可挂载的四角位置。 */


/**
 * 把 GeoAgentControl 挂到 ArcGIS MapView（或已就绪的 `<arcgis-map>` 元素）上。
 * ArcGIS 没有 map.addControl 槽位容纳外部控件，因此这里把控件元素挂进
 * 视图容器并绝对定位到指定角落。控件必须以
 * mapEngine { kind: "arcgis", namespace } 创建。
 *
 *   const control = new GeoAgentControl({ mapEngine: { kind: "arcgis", namespace } });
 *   const attachment = addGeoAgentToArcGISMap(control, view, { position: "top-left" });
 *   // 之后：attachment.remove();
 */
export function addGeoAgentToArcGISMap(
  control: GeoAgentControl,
  map: unknown,
  options?: { position?: string },
): ArcGISControlAttachment {
  // 支持直接传 MapView，或 view 已就绪的组件元素。
  const view = resolveArcGISView(map);
  // 访问控件的内部字段：options 与 onRemove 不在公开类型上。
  const internal = control as unknown as {
    options?: { position?: string; mapEngine?: { kind?: string } };
    onRemove(): void;
  };
  const engineKind = internal.options?.mapEngine?.kind;
  if (engineKind && engineKind !== "arcgis") {
    // 控件引擎种类不匹配时直接拒绝挂载。
    throw new Error(
      `GeoAgentControl was created with mapEngine.kind "${engineKind}"; ArcGIS hosts need { kind: "arcgis", namespace }.`,
    );
  }
  // 位置优先级：调用方 options.position → 控件自身 options → 默认右上角。
  const position = normalizeCorner(
    options?.position ?? internal.options?.position ?? "top-right",
  );
  if (internal.options && internal.options.position !== position) {
    // GeoAgentControl 依据 options.position 决定展开面板的位置；
    // 让它与实际挂载的角落保持一致。
    internal.options.position = position;
  }
  // 面板被追加进视图容器并绝对定位；确保容器是定位上下文。
  const container = view.container;
  if (container && window.getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }
  // 把 shim 化的视图当作 MapLibre map 传给控件的 onAdd。
  const element = control.onAdd(view as unknown as MapLibreMap);
  element.classList.add("geoagent-arcgis-control");
  // 拆成垂直/水平两段设置四边样式。
  const [vertical, horizontal] = position.split("-") as [string, string];
  element.style.position = "absolute";
  element.style.zIndex = "10";
  element.style.pointerEvents = "auto";
  // 10px 边距；清空对侧属性避免残留旧值。
  if (vertical === "top") {
    element.style.top = "10px";
    element.style.bottom = "";
  } else {
    element.style.bottom = "10px";
    element.style.top = "";
  }
  if (horizontal === "left") {
    element.style.left = "10px";
    element.style.right = "";
  } else {
    element.style.right = "10px";
    element.style.left = "";
  }
  container.appendChild(element);
  return {
    remove(): void {
      // 先走控件自身的 onRemove 清理逻辑，再摘除 DOM 元素。
      internal.onRemove.call(control);
      element.remove();
    },
  };
}
