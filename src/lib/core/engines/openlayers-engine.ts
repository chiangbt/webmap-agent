/**
 * GeoAgent 控件的 OpenLayers 宿主支持。
 *
 * GeoAgent 工具通过 MapLibre GL JS 的 API 表面驱动地图：
 * Style Spec 的 source/layer、setStyle、queryRenderedFeatures 等。
 * OpenLayers 的对象模型完全不同 —— Layer 搭配 Source、EPSG:3857 的
 * View，用样式函数而非 style 文档。
 *
 * OpenLayersMapShim 负责弥合这一差距。它维护一份类 Style Spec 的
 * source/layer 注册表，把它们物化成真实的 ol 图层（VectorLayer 配样式
 * 函数求值 MapLibre 表达式，raster 走 XYZ 的 TileLayer），并暴露工具
 * 会调用的 maplibregl.Map API 子集。OpenLayers 确实缺失的能力（globe
 * projection、terrain、sky、fill-extrusion/heatmap 图层、canvas 截图）
 * 会抛出明确的错误而不是静默失败 —— 与 README 为 mapbox-gl 和
 * Leaflet 宿主约定的契约一致。
 *
 * 本文件不 import "ol"；由宿主传入自己的命名空间：
 *
 *   import Map from "ol/Map";
 *   import { GeoAgentControl, addGeoAgentToOpenLayersMap } from "web-geoagent";
 *   new GeoAgentControl({ mapEngine: { kind: "openlayers", namespace } })
 *   addGeoAgentToOpenLayersMap(control, map); // OpenLayers 没有 addControl 槽位
 */

import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoAgentControl } from "../control/GeoAgentControl";
import type {
  GeoAgentMapSurface,
  GeoAgentStyleSnapshot,
} from "../tools/geoagent-tools";
import type { ExpressionContext, PixelProjector } from "./leaflet-engine";
import {
  cloneJson,
  emptyFeatureCollection,
  isRecord,
  normalizeCorner,
  parseCssColor,
  sanitizeCssColor,
} from "./shared";
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
/* 结构化的 OpenLayers 类型（shim 从不直接 import "ol" 本体）                 */
/* -------------------------------------------------------------------------- */

/**
 * ol 几何对象的最小鸭子类型接口（对应 ol/geom/Geometry）。
 */
export interface OpenLayersGeometryLike {
  getType(): string;
}

/**
 * ol 要素的最小鸭子类型接口（对应 ol/Feature）。
 */
export interface OpenLayersFeatureLike {
  getGeometry(): OpenLayersGeometryLike | undefined;
  getProperties(): Record<string, unknown>;
  getId(): string | number | undefined;
}

/**
 * ol 矢量数据源的最小鸭子类型接口（对应 ol/source/Vector）。
 */
export interface OpenLayersVectorSourceLike {
  clear(): void;
  addFeatures(features: unknown[]): void;
  getFeatures(): OpenLayersFeatureLike[];
}

/**
 * ol 图层的最小鸭子类型接口（对应 ol/layer/Base 的常用能力）。
 */
export interface OpenLayersLayerLike {
  getSource(): unknown;
  setSource(source: unknown): void;
  setVisible(visible: boolean): void;
  getVisible(): boolean;
  setOpacity(opacity: number): void;
  changed(): void;
}

/**
 * ol 图层集合的最小鸭子类型接口（对应 ol/Collection）。
 */
export interface OpenLayersCollectionLike<T> {
  getArray(): T[];
  getLength(): number;
  insertAt(index: number, item: T): void;
  remove(item: T): T | undefined;
}

/**
 * ol 覆盖物的最小鸭子类型接口（对应 ol/Overlay 的定位能力）。
 */
export interface OpenLayersOverlayLike {
  setPosition(coordinate: number[] | undefined): void;
  getPosition(): number[] | undefined;
}

/**
 * ol GeoJSON format 的最小鸭子类型接口（对应 ol/format/GeoJSON）。
 */
export interface OpenLayersGeoJSONFormatLike {
  readFeatures(
    source: unknown,
    options?: Record<string, unknown>,
  ): OpenLayersFeatureLike[];
}

/**
 * ol 视图的最小鸭子类型接口（对应 ol/View 的相机能力）。
 */
export interface OpenLayersViewLike {
  getCenter(): number[] | undefined;
  setCenter(center: number[]): void;
  getZoom(): number | undefined;
  setZoom(zoom: number): void;
  getRotation(): number;
  getProjection(): { getCode(): string };
  calculateExtent(size: number[]): number[];
  fit(extent: number[], options?: Record<string, unknown>): void;
  animate(options: Record<string, unknown>): void;
  animate(options: Record<string, unknown>, callback: (completed: boolean) => void): void;
  cancelAnimations?(): void;
}

/**
 * shim 依赖的 ol 地图实例最小接口（结构化子集）。
 * 只声明工具层实际调用的方法，使宿主传入的真实 ol/Map 可直接赋值兼容。
 */
export interface OpenLayersMapLike {
  getView(): OpenLayersViewLike | undefined;
  getLayers(): OpenLayersCollectionLike<OpenLayersLayerLike>;
  getViewport(): HTMLElement;
  getTargetElement(): HTMLElement | null | undefined;
  getSize(): number[] | undefined;
  addLayer(layer: OpenLayersLayerLike): void;
  removeLayer(layer: OpenLayersLayerLike): void;
  addOverlay(overlay: OpenLayersOverlayLike): void;
  removeOverlay(overlay: OpenLayersOverlayLike): void;
  getPixelFromCoordinate(
    coordinate: number[],
  ): number[] | null | undefined;
  on(type: string, listener: (event?: unknown) => void): unknown;
  un(type: string, listener: (event?: unknown) => void): unknown;
  dispatchEvent(event: unknown): unknown;
}

/**
 * shim 所需的 "ol" 包组成部分。宿主需一次性组装好：
 *
 *   const namespace = {
 *     Feature, Point, Overlay,                       // ol/Feature, ol/geom/Point, ol/Overlay
 *     VectorLayer, TileLayer,                        // ol/layer/*
 *     VectorSource, XYZ,                             // ol/source/*
 *     GeoJSON,                                       // ol/format/GeoJSON
 *     Style, Fill, Stroke, CircleStyle: Circle, Text,// ol/style/*
 *     fromLonLat, toLonLat, transformExtent,         // ol/proj
 *   };
 */
export interface OpenLayersNamespace {
  Feature: new (values?: unknown) => OpenLayersFeatureLike;
  Point: new (coordinates: number[]) => OpenLayersGeometryLike;
  Overlay: new (options: Record<string, unknown>) => OpenLayersOverlayLike;
  VectorLayer: new (options?: Record<string, unknown>) => OpenLayersLayerLike;
  TileLayer: new (options?: Record<string, unknown>) => OpenLayersLayerLike;
  VectorSource: new (
    options?: Record<string, unknown>,
  ) => OpenLayersVectorSourceLike;
  XYZ: new (options?: Record<string, unknown>) => unknown;
  GeoJSON: new (options?: Record<string, unknown>) => OpenLayersGeoJSONFormatLike;
  Style: new (options?: Record<string, unknown>) => unknown;
  Fill: new (options?: Record<string, unknown>) => unknown;
  Stroke: new (options?: Record<string, unknown>) => unknown;
  CircleStyle: new (options?: Record<string, unknown>) => unknown;
  Text: new (options?: Record<string, unknown>) => unknown;
  fromLonLat: (coordinate: number[]) => number[];
  toLonLat: (coordinate: number[]) => number[];
  transformExtent: (
    extent: number[],
    from: string,
    to: string,
  ) => number[];
}

/** asOpenLayersNamespace 校验宿主命名空间时必须存在的键清单。 */
const REQUIRED_OPENLAYERS_KEYS: Array<keyof OpenLayersNamespace> = [
  "Feature",
  "Point",
  "Overlay",
  "VectorLayer",
  "TileLayer",
  "VectorSource",
  "XYZ",
  "GeoJSON",
  "Style",
  "Fill",
  "Stroke",
  "CircleStyle",
  "Text",
  "fromLonLat",
  "toLonLat",
  "transformExtent",
];

/**
 * 把宿主传入的命名空间校验并收窄为 OpenLayersNamespace。
 * 逐个检查必需的 ol 类与工具函数是否存在，缺失时抛错并列出全部缺项。
 * @param namespace 宿主组装的 ol 类与工具函数集合
 * @returns 校验通过后的 OpenLayersNamespace
 */
function asOpenLayersNamespace(
  namespace: Record<string, unknown>,
): OpenLayersNamespace {
  // 收集所有缺失的键，一次性报全，方便宿主补齐。
  const missing = REQUIRED_OPENLAYERS_KEYS.filter(
    (key) => namespace[key] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `mapEngine { kind: "openlayers" } needs a namespace with the ol classes and helpers: missing ${missing.join(", ")}. See the OpenLayers example for the full namespace object.`,
    );
  }
  return namespace as unknown as OpenLayersNamespace;
}

/** 鸭子类型探测：该值是否像一个 ol/Map 实例。 */
export function isOpenLayersMap(value: unknown): value is OpenLayersMapLike {
  if (!isRecord(value)) {
    return false;
  }
  const candidate = value as unknown as OpenLayersMapLike;
  // 探测 ol Map 特有的方法组合（Leaflet/MapLibre 地图均不具备）。
  return (
    typeof candidate.getView === "function" &&
    typeof candidate.getLayers === "function" &&
    typeof candidate.getViewport === "function" &&
    typeof candidate.addOverlay === "function"
  );
}

/**
 * 把数值钳制到 [0, 1]；非有限数（NaN 等）按 1 处理（视作完全不透明）。
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1, Math.max(0, value));
}


/* -------------------------------------------------------------------------- */
/* 颜色工具（为 Fill/Stroke 颜色混合不透明度）                                */
/* -------------------------------------------------------------------------- */

/**
 * 把不透明度混合进 CSS 颜色：alpha 已为 1 或颜色无法解析时原样返回，
 * 否则输出 rgba(...) 形式（用于把 fill-opacity/line-opacity 并入颜色，
 * 因为 ol 的 Fill/Stroke 没有独立的不透明度属性）。
 */
function withOpacity(color: string, opacity: number): string {
  const alpha = clamp01(Number.isFinite(opacity) ? opacity : 1);
  // 完全不透明时无需改写。
  if (alpha >= 1) {
    return color;
  }
  const parsed = parseCssColor(color);
  // 解析失败保持原样，交由 CSS 自行兜底。
  if (!parsed) {
    return color;
  }
  // 原 alpha 与目标不透明度相乘，保留三位小数。
  const a = Math.round(parsed.a * alpha * 1000) / 1000;
  return `rgba(${Math.round(parsed.r)}, ${Math.round(parsed.g)}, ${Math.round(parsed.b)}, ${a})`;
}

/* -------------------------------------------------------------------------- */
/* Source / layer 注册表                                                       */
/* -------------------------------------------------------------------------- */

/** 依赖 GeoJSON 数据源的矢量图层类型清单，物化与命中测试都按此分支。 */
const GEOJSON_LAYER_TYPES = ["fill", "line", "circle", "symbol"];

/**
 * shim 注册表中一个 MapLibre 风格图层的条目：
 * spec 为原始样式定义，olLayer 为物化后的 ol 图层（未物化为 null），
 * visible 为 shim 侧维护的可见性状态。
 */
interface OlShimLayer {
  id: string;
  type: string;
  source: string;
  spec: Record<string, unknown>;
  visible: boolean;
  olLayer: OpenLayersLayerLike | null;
}

/**
 * shim 注册表中的一个 MapLibre 风格数据源。
 * geojson 类型持有 ol VectorSource，raster 类型持有 ol XYZ source；
 * 开启 cluster 的 geojson 数据源按当前缩放级别做网格聚类并缓存结果。
 */
class OlShimSource {
  readonly id: string;
  readonly type: string;
  readonly cluster: boolean;
  readonly clusterRadius: number;
  readonly clusterMaxZoom: number;
  spec: Record<string, unknown>;
  data: GeoJSON.FeatureCollection = emptyFeatureCollection();
  /** geojson 数据源持有的 ol VectorSource；其他类型为 null。 */
  readonly vectorSource: OpenLayersVectorSourceLike | null;
  /** raster 数据源持有的 ol XYZ source；其他类型为 null。 */
  readonly tileSource: unknown;
  /** 聚类结果缓存：仅在缩放级别未变时复用。 */
  private clusterCache: { zoom: number; features: GeoJSON.Feature[] } | null =
    null;
  /** 所属的 OpenLayersMapShim：读取缩放级别、投影点坐标并同步 ol 要素。 */
  private readonly shim: OpenLayersMapShim;

  constructor(shim: OpenLayersMapShim, id: string, spec: Record<string, unknown>) {
    this.shim = shim;
    this.id = id;
    this.spec = cloneJson(spec);
    this.type = String(spec.type ?? "unknown");
    // 仅 geojson 数据源支持 cluster 聚类选项。
    this.cluster = this.type === "geojson" && Boolean(spec.cluster);
    this.clusterRadius = Number(spec.clusterRadius ?? 50);
    this.clusterMaxZoom = Number(spec.clusterMaxZoom ?? 14);
    if (this.type === "geojson") {
      // geojson：先建空的 ol VectorSource，数据就绪后填充。
      this.vectorSource = new (shim.getNamespace().VectorSource)();
      this.tileSource = null;
      const data = spec.data;
      // data 是 URL：异步 fetch，成功后 setData；失败仅告警不中断。
      if (typeof data === "string") {
        void shim
          .fetchGeoJson(data)
          .then((loaded) => {
            // shim 已销毁时跳过：操作已脱离注册表的对象没有意义。
            if (!shim.isDisposed()) {
              this.setData(loaded);
            }
          })
          .catch((error: unknown) => {
            console.warn(
              `OpenLayers engine: could not load GeoJSON source "${id}":`,
              error,
            );
          });
      } else {
        // data 是内联对象：立即归一化并同步到 ol source。
        this.data = normalizeFeatureCollection(data);
        this.syncOlFeatures();
      }
    } else if (this.type === "raster") {
      this.vectorSource = null;
      const tiles = Array.isArray(spec.tiles) ? spec.tiles : [];
      // 取第一个 tiles URL 作为 XYZ 模板。
      const url = typeof tiles[0] === "string" ? tiles[0] : "";
      // 没有 tiles URL 的 raster source 无法渲染，直接抛错。
      if (!url) {
        throw new Error(
          `Raster source "${id}" needs a tiles URL template; the OpenLayers engine renders rasters as XYZ tile layers.`,
        );
      }
      // attribution 以数组形式传给 ol（其要求字符串数组）。
      this.tileSource = new (shim.getNamespace().XYZ)({
        url,
        attributions:
          typeof spec.attribution === "string" && spec.attribution
            ? [spec.attribution]
            : undefined,
      });
    } else if (this.type === "raster-dem") {
      // terrain 是 OpenLayers 不支持的能力，抛错而非静默忽略。
      throw new Error(
        "Terrain (raster-dem) is not supported by the OpenLayers engine.",
      );
    } else if (this.type === "vector") {
      // 矢量瓦片源同样不支持。
      throw new Error(
        `Vector tile sources are not supported by the OpenLayers engine (source "${id}"). 3D buildings and vector basemaps require maplibre-gl or mapbox-gl.`,
      );
    } else {
      // 其余 source 类型不支持。
      throw new Error(
        `"${this.type}" sources are not supported by the OpenLayers engine (source "${id}").`,
      );
    }
  }

  /** 更新数据源数据并同步到 ol VectorSource。 */
  setData(data: unknown): void {
    this.data = normalizeFeatureCollection(data);
    this.spec.data = data;
    // 数据已变化，聚类缓存随之失效。
    this.clusterCache = null;
    this.syncOlFeatures();
  }

  /** 主动使聚类缓存失效（moveend 时由 shim 调用）。 */
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
            (lat, lng) => this.shim.projectPoint(lat, lng),
          );
    this.clusterCache = { zoom, features };
    return features;
  }

  /**
   * 把 resolvedFeatures 解析为 ol Feature 并整体替换
   * ol VectorSource 中的要素（先 clear 再 addFeatures）。
   */
  syncOlFeatures(): void {
    if (!this.vectorSource) {
      return;
    }
    // 整体替换：先清空再灌入，避免残留旧要素。
    this.vectorSource.clear();
    const collection: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: this.resolvedFeatures(),
    };
    // GeoJSON 是 EPSG:4326，读取时转换到 ol 默认的 EPSG:3857。
    const olFeatures = this.shim
      .getFormat()
      .readFeatures(collection, { featureProjection: "EPSG:3857" });
    this.vectorSource.addFeatures(olFeatures);
  }
}

/* -------------------------------------------------------------------------- */
/* 引擎 shim 本体                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 在真实 ol/Map 之上呈现 GeoAgent 工具所需的 MapLibre Map API 表面。
 * 与 LeafletMapShim 镜像，契约说明见该类。
 */
export class OpenLayersMapShim implements GeoAgentMapSurface {
  /** 被包装的真实 ol 地图实例。 */
  private readonly raw: OpenLayersMapLike;
  /** 宿主传入并校验后的 ol 命名空间（类与投影工具函数）。 */
  private readonly ns: OpenLayersNamespace;
  /** ol GeoJSON format 实例，用于 GeoJSON 与 ol Feature 互转。 */
  private readonly format: OpenLayersGeoJSONFormatLike;
  /** 数据源注册表：id -> OlShimSource。 */
  private readonly sources = new Map<string, OlShimSource>();
  /** 图层注册表：id -> OlShimLayer。 */
  private readonly layers = new Map<string, OlShimLayer>();
  /** 图层渲染顺序（自底向上），对应 MapLibre style.layers 的顺序。 */
  private layerOrder: string[] = [];
  /** 宿主自己的底图层（change_basemap 时替换其 source 而非无限叠加）。 */
  private baseLayer: OpenLayersLayerLike | null = null;
  /** moveend 时重算聚类的监听；以字段保存以便 destroy() 精确解绑。 */
  private readonly clusterHandler: (event?: unknown) => void;
  /** shim 是否已销毁：销毁后 URL GeoJSON 的异步回调不再写回数据。 */
  private disposed = false;

  constructor(map: OpenLayersMapLike, namespace: Record<string, unknown>) {
    this.raw = map;
    this.ns = asOpenLayersNamespace(namespace);
    this.format = new this.ns.GeoJSON();
    const array = this.raw.getLayers().getArray();
    // 约定：最底层的既有图层即宿主自己的底图；change_basemap 时
    // 替换它的 source，而不是无限叠加瓦片层。
    this.baseLayer = array.length > 0 ? array[0] : null;
    // 平移/缩放结束后重算所有 cluster 数据源并同步 ol 要素。
    this.clusterHandler = () => {
      for (const source of this.sources.values()) {
        if (source.cluster) {
          source.invalidateClusterCache();
          source.syncOlFeatures();
        }
      }
    };
    // 绑定 moveend：ol 没有缩放专属事件，moveend 同时覆盖平移与缩放。
    this.raw.on("moveend", this.clusterHandler);
  }

  /** 返回被包装的真实 ol 地图实例。 */
  getRawMap(): OpenLayersMapLike {
    return this.raw;
  }

  /** 返回校验后的 ol 命名空间（供 OlShimSource 等访问 ol 类）。 */
  getNamespace(): OpenLayersNamespace {
    return this.ns;
  }

  /** 返回共享的 ol GeoJSON format 实例。 */
  getFormat(): OpenLayersGeoJSONFormatLike {
    return this.format;
  }

  /**
   * 拉取远程 GeoJSON 并归一化为 FeatureCollection。
   * @throws 非 2xx 响应时抛出带状态码的错误
   */
  async fetchGeoJson(url: string): Promise<GeoJSON.FeatureCollection> {
    const response = await fetch(url);
    // HTTP 失败直接抛错，由调用方决定告警或回退。
    if (!response.ok) {
      throw new Error(`Failed to fetch GeoJSON from ${url}: ${response.status}`);
    }
    return normalizeFeatureCollection(await response.json());
  }

  /* ----------------------------- 地图基础 -------------------------------- */

  /** 返回地图视口（viewport）元素作为容器。 */
  getContainer(): HTMLElement {
    return this.raw.getViewport();
  }

  /** 取 ol View；地图未配置 view 时抛错。 */
  private requireView(): OpenLayersViewLike {
    const view = this.raw.getView();
    if (!view) {
      throw new Error("The OpenLayers map has no view attached.");
    }
    return view;
  }

  /**
   * 就绪判定：ol 地图只要挂了 View 即视为可用
   * （ol 没有 maplibre 那样的异步"加载完成"事件）。
   */
  loaded(): boolean {
    return Boolean(this.raw.getView());
  }

  /** MapLibre 兼容的 LngLat 形态：带 `.lng` / `.lat` 属性。 */
  getCenter(): { lng: number; lat: number } {
    const center = this.raw.getView()?.getCenter();
    // 尚未设置中心时回退 (0, 0)。
    if (!center) {
      return { lng: 0, lat: 0 };
    }
    // ol 内部是 EPSG:3857 平面坐标，转回经纬度。
    const lonLat = this.ns.toLonLat(center);
    return { lng: lonLat[0], lat: lonLat[1] };
  }

  /** 返回当前缩放级别；未定义/非有限数时回退 0。 */
  getZoom(): number {
    const zoom = this.raw.getView()?.getZoom();
    return typeof zoom === "number" && Number.isFinite(zoom) ? zoom : 0;
  }

  /**
   * ol/View 的 rotation 是顺时针弧度，与 MapLibre 的 bearing
   * （顺时针角度）约定一致，仅单位不同。
   */
  getBearing(): number {
    const view = this.raw.getView();
    if (!view) {
      return 0;
    }
    return (view.getRotation() * 180) / Math.PI;
  }

  /** ol 无俯仰相机，俯仰角恒为 0。 */
  getPitch(): number {
    // OpenLayers 没有俯仰相机。
    return 0;
  }

  /** MapLibre 兼容的 LngLatBounds 形态：提供 getWest()/getSouth()/... 方法。 */
  getBounds(): {
    getWest(): number;
    getSouth(): number;
    getEast(): number;
    getNorth(): number;
  } {
    const view = this.requireView();
    const size = this.effectiveSize();
    // 视口范围从 EPSG:3857 转为 EPSG:4326（经纬度）。
    const extent = this.ns.transformExtent(
      view.calculateExtent(size),
      "EPSG:3857",
      "EPSG:4326",
    );
    // 以闭包形式提供 MapLibre 风格的四方向取值方法。
    return {
      getWest: () => extent[0],
      getSouth: () => extent[1],
      getEast: () => extent[2],
      getNorth: () => extent[3],
    };
  }

  /**
   * 计算有效的视口尺寸：ol getSize 不可用或为零时
   * 回退到 viewport 的 client 尺寸，再不行用 512 兜底。
   */
  private effectiveSize(): [number, number] {
    const size = this.raw.getSize();
    if (size && size[0] > 0 && size[1] > 0) {
      return [size[0], size[1]];
    }
    const viewport = this.raw.getViewport();
    const width = viewport?.clientWidth ?? 0;
    const height = viewport?.clientHeight ?? 0;
    // jsdom 等零尺寸环境会让 View.fit/calculateExtent 退化；
    // 回退到一个合理的正方形尺寸，保证相机计算可用。
    return [width > 0 ? width : 512, height > 0 ? height : 512];
  }

  /** 返回有效视口尺寸 [宽, 高]。 */
  getSize(): [number, number] {
    return this.effectiveSize();
  }

  /**
   * 把经纬度投影为当前视口内的像素坐标。
   * ol 返回 null（首帧渲染前/jsdom）时回退到纯 Web Mercator 数学计算。
   */
  projectPoint(lat: number, lng: number): { x: number; y: number } {
    const pixel = this.raw.getPixelFromCoordinate(
      this.ns.fromLonLat([lng, lat]),
    );
    if (pixel && Number.isFinite(pixel[0]) && Number.isFinite(pixel[1])) {
      return { x: pixel[0], y: pixel[1] };
    }
    // 首帧渲染前（或 jsdom 环境）ol 会返回 null；
    // 回退为基于当前 view 的纯 Web Mercator 数学计算。
    return this.mercatorProject(lat, lng);
  }

  /**
   * 纯数学的 Web Mercator 投影：以当前 view 的中心与缩放级别为基准，
   * 计算经纬度对应的容器像素坐标（ol 无法给出像素时的兜底）。
   */
  private mercatorProject(lat: number, lng: number): { x: number; y: number } {
    const view = this.raw.getView();
    const zoom = view?.getZoom();
    const center = view?.getCenter();
    const size = this.effectiveSize();
    // 缩放级别非法时按 0 处理。
    const z = typeof zoom === "number" && Number.isFinite(zoom) ? zoom : 0;
    // 该级别下的世界总宽（像素）。
    const worldSize = 256 * Math.pow(2, z);
    // 经度线性映射到世界像素 X。
    const toWorldX = (lon: number) => ((lon + 180) / 360) * worldSize;
    // 纬度经 Mercator 公式映射到世界像素 Y（钳制到 ±85.05112878 极限纬度）。
    const toWorldY = (latDeg: number) => {
      const clamped = Math.max(-85.05112878, Math.min(85.05112878, latDeg));
      const sinLat = Math.sin((clamped * Math.PI) / 180);
      return (
        (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) *
        worldSize
      );
    };
    let centerX = worldSize / 2;
    let centerY = worldSize / 2;
    // 以 view 中心的世界像素坐标为原点，平移到容器中心。
    if (center) {
      const lonLat = this.ns.toLonLat(center);
      centerX = toWorldX(lonLat[0]);
      centerY = toWorldY(lonLat[1]);
    }
    return {
      x: toWorldX(lng) - centerX + size[0] / 2,
      y: toWorldY(lat) - centerY + size[1] / 2,
    };
  }

  /**
   * 无动画设置中心/缩放级别；未提供的参数保持不变。
   * center 为 [lng, lat]，经 fromLonLat 转到 EPSG:3857。
   */
  jumpTo(options: { center?: [number, number]; zoom?: number }): void {
    const view = this.requireView();
    // 中心与缩放互相独立，仅更新传入的项。
    if (options.center) {
      view.setCenter(this.ns.fromLonLat(options.center));
    }
    // undefined/null 都视为未提供（zoom 0 是合法值，不能只判 falsy）。
    if (options.zoom !== undefined && options.zoom !== null) {
      view.setZoom(Number(options.zoom));
    }
  }

  /** 1.2 秒动画飞行到目标中心/缩放级别（ol View.animate）。 */
  flyTo(options: { center?: [number, number]; zoom?: number }): Promise<void> {
    return this.animateCamera(options, 1200);
  }

  stop(): void {
    this.requireView().cancelAnimations?.();
  }

  /** 0.3 秒缓动到目标中心/缩放级别，对应 MapLibre 的 easeTo。 */
  easeTo(options: { center?: [number, number]; zoom?: number }): Promise<void> {
    return this.animateCamera(options, 300);
  }

  private animateCamera(
    options: { center?: [number, number]; zoom?: number },
    duration: number,
  ): Promise<void> {
    const animation: Record<string, unknown> = { duration };
    if (options.center) {
      animation.center = this.ns.fromLonLat(options.center);
    }
    if (options.zoom !== undefined && options.zoom !== null) {
      animation.zoom = Number(options.zoom);
    }
    return new Promise((resolve, reject) => {
      this.requireView().animate(animation, (completed) => {
        if (completed) resolve();
        else reject(new Error("OpenLayers camera movement was interrupted."));
      });
    });
  }

  /** 直接设置缩放级别。 */
  setZoom(zoom: number): void {
    this.requireView().setZoom(Number(zoom));
  }

  /**
   * 把视野适配到经纬度范围（转 EPSG:3857 后交 View.fit）。
   * @param corners [[west, south], [east, north]]
   * @param options padding（默认 48）、maxZoom（默认 24）、duration（默认 0）
   */
  fitBounds(
    corners: [[number, number], [number, number]],
    options?: { padding?: number; maxZoom?: number; duration?: number },
  ): void {
    // [w, s, e, n] 从 EPSG:4326 转到 EPSG:3857。
    const [[west, south], [east, north]] = corners;
    const extent = this.ns.transformExtent(
      [west, south, east, north],
      "EPSG:4326",
      "EPSG:3857",
    );
    // padding 四边同值；maxZoom/duration 提供与 MapLibre 对齐的默认值。
    const padding = Number(options?.padding ?? 48);
    const duration = options?.duration ?? 0;
    this.requireView().fit(extent, {
      padding: [padding, padding, padding, padding],
      maxZoom: Number(options?.maxZoom ?? 24),
      size: this.effectiveSize(),
      ...(duration > 0 ? { duration } : {}),
    });
  }

  /** ol 默认使用 Web Mercator（EPSG:3857），恒定返回 mercator。 */
  getProjection(): { type: "mercator" } {
    return { type: "mercator" };
  }

  /**
   * 校验投影设置：仅接受 mercator（含字符串与 {type} 两种形式），
   * 其余（如 globe）抛出明确错误。
   */
  setProjection(projection: unknown): void {
    const type =
      typeof projection === "string"
        ? projection
        : isRecord(projection)
          ? String(projection.type ?? "")
          : "";
    // 非法投影直接报错，并指明 globe 需要 maplibre-gl/mapbox-gl。
    if (type !== "mercator") {
      throw new Error(
        `The OpenLayers engine only supports the "mercator" projection (received "${type || "unknown"}"). WebGL globe rendering requires maplibre-gl or mapbox-gl.`,
      );
    }
  }

  /* -------------------------------- 事件 --------------------------------- */

  /** 订阅地图事件，透传给真实 ol 地图。 */
  on(type: string, listener: (event?: unknown) => void): this {
    this.raw.on(type, listener);
    return this;
  }

  /** 解除事件订阅（ol 的 un）。listener 缺省时不做任何事。 */
  off(type: string, listener?: (event?: unknown) => void): this {
    if (listener) {
      this.raw.un(type, listener);
    }
    return this;
  }

  /** 订阅一次性事件：以"先解绑再调用"的 wrapper 手工实现 once 语义。 */
  once(type: string, listener: (event?: unknown) => void): this {
    // wrapper 触发时先解绑自身，再转发给真实监听器。
    const wrapper = (event?: unknown): void => {
      this.raw.un(type, wrapper);
      listener(event);
    };
    this.raw.on(type, wrapper);
    return this;
  }

  /** 在 ol 地图上派发事件：data 存在时合并为事件对象，否则只传事件名。 */
  fire(type: string, data?: Record<string, unknown>): this {
    this.raw.dispatchEvent(data ? { type, ...data } : type);
    return this;
  }

  /* ------------------------------ 样式 ----------------------------------- */

  /**
   * change_basemap：替换底图瓦片层的 XYZ source。带矢量 source 的
   * MapLibre style 文档会被 resolveBasemapStyle 以可操作的提示拒绝；
   * raster style、XYZ 模板与内置底图别名都会解析出瓦片 URL。
   */
  setStyle(style: unknown): void {
    const resolved = resolveBasemapStyle(style, "OpenLayers");
    // 以解析出的瓦片 URL 构造新 XYZ source。
    const source = new this.ns.XYZ({
      url: resolved.url,
      attributions: resolved.attribution ? [resolved.attribution] : undefined,
    });
    if (this.baseLayer) {
      // 有底图层：原地换 source（ol 支持动态替换 source）。
      this.baseLayer.setSource(source);
    } else {
      // 没有底图层：新建 TileLayer 插到最底层。
      this.baseLayer = new this.ns.TileLayer({ source });
      this.raw.getLayers().insertAt(0, this.baseLayer);
    }
    // change_basemap 会等待 "style.load"；这里镜像 MapLibre 的异步触发。
    setTimeout(() => {
      this.fire("style.load");
    }, 0);
  }

  /**
   * 以 Style Spec 文档形状回放当前注册表内容
   * （version 8 + sources + 按 layerOrder 排列的 layers）。
   */
  getStyle(): GeoAgentStyleSnapshot {
    const sources: Record<string, Record<string, unknown>> = {};
    for (const [id, source] of this.sources) {
      // 深拷贝，避免调用方改动内部状态。
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

  /* ------------------------- 数据源与图层 --------------------------------- */

  /** 新增数据源；id 重复时抛错（与 MapLibre 行为一致）。 */
  addSource(id: string, spec: Record<string, unknown>): void {
    if (this.sources.has(id)) {
      throw new Error(`Source already exists: ${id}`);
    }
    this.sources.set(id, new OlShimSource(this, id, spec));
  }

  /** 按 id 查找 OlShimSource 数据源。 */
  getSource(id: string): OlShimSource | undefined {
    return this.sources.get(id);
  }

  /**
   * 删除数据源；仍有图层依赖它时抛错，
   * 与 MapLibre 及 Leaflet shim 的行为一致。
   */
  removeSource(id: string): void {
    const source = this.sources.get(id);
    if (!source) {
      throw new Error(`Source not found: ${id}`);
    }
    // 与 MapLibre 及 Leaflet shim 一致：仍有图层依赖该数据源时拒绝删除，
    // 避免依赖方基于已脱离的 source 继续渲染。
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
   * 按 MapLibre 语义新增图层：校验 id/类型/beforeId，构造对应的
   * ol 图层（raster → TileLayer，矢量 → 带样式函数的 VectorLayer），
   * 并同步 ol 的图层集合顺序。
   */
  addLayer(spec: Record<string, unknown>, beforeId?: string): void {
    // 与 MapLibre 一致：缺少 id 直接抛错。
    const id = String(spec.id ?? "");
    if (!id) {
      throw new Error("addLayer requires a layer id.");
    }
    // id 重复抛错，避免静默覆盖。
    if (this.layers.has(id)) {
      throw new Error(`Layer already exists: ${id}`);
    }
    const type = String(spec.type ?? "");
    // 先限定支持的图层类型，不支持的直接报错并列出可选项。
    if (!GEOJSON_LAYER_TYPES.includes(type) && type !== "raster") {
      throw new Error(
        `The OpenLayers engine does not support "${type || "unknown"}" layers (layer "${id}"). Supported types: ${[...GEOJSON_LAYER_TYPES, "raster"].join(", ")}.`,
      );
    }
    // 图层必须挂在一个已注册的数据源上。
    const sourceId = String(spec.source ?? "");
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new Error(`Cannot add layer ${id}; source not found: ${sourceId}`);
    }
    // MapLibre 的 addLayer 对未知 beforeId 会抛错；这里同样抛错而不是
    // 静默追加，让代理在所有引擎上都能自我纠正。
    if (beforeId && !this.layerOrder.includes(beforeId)) {
      throw new Error(`Cannot add layer ${id}; beforeId not found: ${beforeId}`);
    }
    const layout = isRecord(spec.layout) ? spec.layout : {};
    // visibility 为 "none" 时注册为不可见。
    const entry: OlShimLayer = {
      id,
      type,
      source: sourceId,
      spec: cloneJson(spec),
      visible: layout.visibility !== "none",
      olLayer: null,
    };
    if (type === "raster") {
      // raster 图层必须挂在 raster 数据源上。
      if (!source.tileSource) {
        throw new Error(
          `Cannot add raster layer ${id}; source ${sourceId} is not a raster tile source.`,
        );
      }
      const paint = isRecord(spec.paint) ? spec.paint : {};
      // raster：复用数据源的 XYZ source，透明度来自 raster-opacity。
      entry.olLayer = new this.ns.TileLayer({
        source: source.tileSource,
        opacity: clamp01(Number(paint["raster-opacity"] ?? 1)),
      });
    } else {
      // 矢量图层必须挂在 geojson 数据源上。
      if (!source.vectorSource) {
        throw new Error(
          `Cannot add ${type} layer ${id}; source ${sourceId} is not a GeoJSON source.`,
        );
      }
      // 矢量：VectorLayer 挂 VectorSource，样式由 styleFor 逐要素求值。
      entry.olLayer = new this.ns.VectorLayer({
        source: source.vectorSource,
        style: (feature: OpenLayersFeatureLike) => this.styleFor(entry, feature),
      });
    }
    // 初始可见性立即同步到 ol。
    entry.olLayer.setVisible(entry.visible);
    this.layers.set(id, entry);
    // beforeId 已在上一步校验过存在，这里按其位置插入。
    if (beforeId && this.layerOrder.includes(beforeId)) {
      this.layerOrder.splice(this.layerOrder.indexOf(beforeId), 0, id);
    } else {
      this.layerOrder.push(id);
    }
    this.syncLayerOrder();
  }

  /** 重建 ol 图层集合，使注册表顺序与 MapLibre 顺序一致。 */
  private syncLayerOrder(): void {
    const collection = this.raw.getLayers();
    // 先把全部 shim 图层从 ol 集合中摘除。
    for (const entry of this.layers.values()) {
      if (entry.olLayer) {
        collection.remove(entry.olLayer);
      }
    }
    // 按 layerOrder 依序追加到集合尾部（ol 中越靠后越靠上）。
    for (const id of this.layerOrder) {
      const entry = this.layers.get(id);
      if (entry?.olLayer) {
        collection.insertAt(collection.getLength(), entry.olLayer);
      }
    }
  }

  /** 返回图层注册表中保存的 spec 引用；图层不存在时返回 undefined。 */
  getLayer(id: string): Record<string, unknown> | undefined {
    return this.layers.get(id)?.spec;
  }

  /** 删除图层：从 ol 集合移除并更新注册表。 */
  removeLayer(id: string): void {
    const entry = this.layers.get(id);
    if (!entry) {
      throw new Error(`Layer not found: ${id}`);
    }
    if (entry.olLayer) {
      this.raw.getLayers().remove(entry.olLayer);
    }
    this.layers.delete(id);
    this.layerOrder = this.layerOrder.filter((layerId) => layerId !== id);
  }

  /** 调整图层顺序并重建 ol 集合（beforeId 缺省时移到最上层）。 */
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
    this.syncLayerOrder();
  }

  /**
   * 更新 paint 属性。raster 的 raster-opacity 直接改 ol 图层透明度；
   * 其余通过 changed() 触发 ol 用最新 spec 重绘矢量要素。
   */
  setPaintProperty(id: string, property: string, value: unknown): void {
    const entry = this.requireLayer(id);
    // 拷贝一份 paint 再写回，避免原地改动共享对象。
    const paint = isRecord(entry.spec.paint) ? { ...entry.spec.paint } : {};
    paint[property] = value;
    entry.spec.paint = paint;
    // 瓦片透明度可原地生效；矢量样式靠 changed() 触发重绘。
    if (entry.type === "raster" && property === "raster-opacity") {
      entry.olLayer?.setOpacity(clamp01(Number(value)));
    } else {
      entry.olLayer?.changed();
    }
  }

  /**
   * 更新 layout 属性。visibility 直接同步 ol 图层可见性；
   * 其余通过 changed() 触发重绘。
   */
  setLayoutProperty(id: string, property: string, value: unknown): void {
    const entry = this.requireLayer(id);
    const layout = isRecord(entry.spec.layout) ? { ...entry.spec.layout } : {};
    layout[property] = value;
    entry.spec.layout = layout;
    // "none" 之外的一切取值都视为可见。
    if (property === "visibility") {
      entry.visible = value !== "none";
      entry.olLayer?.setVisible(entry.visible);
    } else {
      entry.olLayer?.changed();
    }
  }

  /** 设置图层 filter（深拷贝保存）；null/undefined 表示清除。 */
  setFilter(id: string, filter: unknown): void {
    const entry = this.requireLayer(id);
    // 清除 filter；否则深拷贝保存，避免外部改动影响渲染。
    if (filter === null || filter === undefined) {
      delete entry.spec.filter;
    } else {
      entry.spec.filter = cloneJson(filter);
    }
    // filter 变化需触发 ol 重绘。
    entry.olLayer?.changed();
  }

  /** 按 id 取图层条目，不存在时抛错。 */
  private requireLayer(id: string): OlShimLayer {
    const entry = this.layers.get(id);
    if (!entry) {
      throw new Error(`Layer not found: ${id}`);
    }
    return entry;
  }

  /* ------------------------------ 样式求值 -------------------------------- */

  /**
   * 单个注册表图层的 ol 样式函数：求值图层的 MapLibre filter 与
   * paint（数据驱动表达式经共享求值器处理），产出 ol Style。
   */
  private styleFor(entry: OlShimLayer, feature: OpenLayersFeatureLike): unknown {
    const spec = entry.spec;
    const zoom = this.getZoom();
    const geometry = feature.getGeometry();
    // ol Feature 的属性里混有 geometry 引用，剔除后再交给表达式求值。
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(feature.getProperties() ?? {})) {
      if (key !== "geometry") {
        properties[key] = value;
      }
    }
    const context: ExpressionContext = {
      properties,
      geometryType: geometry ? normalizeGeometryType(geometry.getType()) : "",
      zoom,
      id: feature.getId(),
    };
    // filter 未通过的要素返回 undefined（ol 约定 undefined 即不渲染）。
    if (
      spec.filter !== undefined &&
      spec.filter !== null &&
      !expressionTruthy(evaluateExpression(spec.filter, context))
    ) {
      return undefined;
    }
    // minzoom/maxzoom 在样式函数层模拟（返回 undefined 即隐藏）。
    if (typeof spec.minzoom === "number" && zoom < spec.minzoom) {
      return undefined;
    }
    if (typeof spec.maxzoom === "number" && zoom >= spec.maxzoom) {
      return undefined;
    }
    const paint = isRecord(spec.paint) ? spec.paint : {};
    const layout = isRecord(spec.layout) ? spec.layout : {};
    const ns = this.ns;
    // 按图层类型构造对应的 ol 样式对象。
    switch (entry.type) {
      case "fill": {
        // MapLibre 的 fill 只有设置了 fill-outline-color 才有描边，且
        // fill-opacity 作用于包含描边的整个图层 —— 两点都对齐，
        // 而不是总画一条深色 35% 细线。
        const fillOpacity = numberValueFrom(paint["fill-opacity"], context, 1);
        const outlineColor = paint["fill-outline-color"];
        return new ns.Style({
          fill: new ns.Fill({
            color: withOpacity(
              colorValueFrom(paint["fill-color"], context, "#1c7ed6"),
              fillOpacity,
            ),
          }),
          stroke:
            outlineColor != null
              ? new ns.Stroke({
                  color: withOpacity(
                    colorValueFrom(outlineColor, context, "#1c7ed6"),
                    fillOpacity,
                  ),
                  width: 1,
                })
              : undefined,
        });
      }
      case "line":
        return new ns.Style({
          stroke: new ns.Stroke({
            color: withOpacity(
              colorValueFrom(paint["line-color"], context, "#1c7ed6"),
              numberValueFrom(paint["line-opacity"], context, 1),
            ),
            // 线宽下限 0.5，避免 0 宽线完全消失。
            width: Math.max(0.5, numberValueFrom(paint["line-width"], context, 1)),
          }),
        });
      case "circle": {
        // 圆点半径/填充 + 可选描边，全部经表达式求值。
        const strokeWidth = numberValueFrom(
          paint["circle-stroke-width"],
          context,
          0,
        );
        return new ns.Style({
          image: new ns.CircleStyle({
            // 半径下限 0.5，避免 0 半径圆不可见。
            radius: Math.max(
              0.5,
              numberValueFrom(paint["circle-radius"], context, 5),
            ),
            fill: new ns.Fill({
              color: withOpacity(
                colorValueFrom(paint["circle-color"], context, "#1c7ed6"),
                numberValueFrom(paint["circle-opacity"], context, 1),
              ),
            }),
            stroke:
              strokeWidth > 0
                ? new ns.Stroke({
                    color: withOpacity(
                      colorValueFrom(
                        paint["circle-stroke-color"],
                        context,
                        "#ffffff",
                      ),
                      numberValueFrom(
                        paint["circle-stroke-opacity"],
                        context,
                        1,
                      ),
                    ),
                    width: strokeWidth,
                  })
                : undefined,
          }),
        });
      }
      case "symbol": {
        const text = textFieldTextFrom(layout["text-field"], context);
        // 空文本不渲染（返回 undefined）。
        if (!text) {
          return undefined;
        }
        // 字号下限 4px，保证可读。
        const size = Math.max(4, numberValueFrom(layout["text-size"], context, 16));
        return new ns.Style({
          text: new ns.Text({
            text,
            font: `${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`,
            fill: new ns.Fill({
              // 与 Leaflet shim 相同的默认：白色文字配深色描边（halo），
              // 在浅色与深色瓦片上都保持可读。
              color: colorValueFrom(paint["text-color"], context, "#ffffff"),
            }),
            stroke: new ns.Stroke({
              color: "rgba(0, 0, 0, 0.85)",
              width: 3,
            }),
            // overflow 允许文字超出要素边界绘制（对齐 MapLibre 标注行为）。
            overflow: true,
          }),
        });
      }
      default:
        return undefined;
    }
  }

  /* ------------------------------ 查询 ----------------------------------- */

  /**
   * 查询数据源的全部要素（可按 filter 过滤）。聚类数据源返回
   * 聚类后的要素（含 point_count 属性），与 MapLibre 行为一致。
   */
  querySourceFeatures(
    sourceId: string,
    options: { sourceLayer?: string; filter?: unknown } = {},
  ): Array<{
    type: "Feature";
    geometry: GeoJSON.Geometry | null;
    properties: Record<string, unknown>;
    id?: string | number;
  }> {
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new Error(`Source not found: ${sourceId}`);
    }
    const zoom = this.getZoom();
    const results: Array<{
      type: "Feature";
      geometry: GeoJSON.Geometry | null;
      properties: Record<string, unknown>;
      id?: string | number;
    }> = [];
    for (const feature of source.resolvedFeatures()) {
      // 未提供 filter 时全部返回。
      if (
        options.filter !== undefined &&
        options.filter !== null &&
        !expressionTruthy(
          evaluateExpression(options.filter, featureContextFor(feature, zoom)),
        )
      ) {
        continue;
      }
      results.push({
        type: "Feature",
        geometry: feature.geometry ?? null,
        properties: (isRecord(feature.properties)
          ? feature.properties
          : {}) as Record<string, unknown>,
        id: feature.id as string | number | undefined,
      });
    }
    return results;
  }

  /**
   * 基于注册表的像素命中测试（复用共享的 hitTestFeature），
   * 因为 ol 的 forEachFeatureAtPixel 依赖无头环境永远不会产生的
   * 已渲染帧。
   */
  queryRenderedFeatures(
    point: [number, number],
    options: { layers?: string[]; filter?: unknown } = {},
  ): Array<{
    type: "Feature";
    geometry: GeoJSON.Geometry | null;
    properties: Record<string, unknown>;
    id: string | number | undefined;
    layer: { id: string; type: string; source: string };
  }> {
    const [x, y] = point;
    const zoom = this.getZoom();
    // 经纬度 → 像素的投影函数（注意入参是 [lng, lat] 顺序）。
    const toPixel: PixelProjector = (coordinate) =>
      this.projectPoint(coordinate[1], coordinate[0]);
    // layers 白名单转 Set，避免逐层线性查找。
    const requested =
      Array.isArray(options.layers) && options.layers.length > 0
        ? new Set(options.layers)
        : null;
    const results: Array<{
      type: "Feature";
      geometry: GeoJSON.Geometry | null;
      properties: Record<string, unknown>;
      id: string | number | undefined;
      layer: { id: string; type: string; source: string };
    }> = [];
    for (const id of this.layerOrder) {
      const entry = this.layers.get(id);
      // 不可见或非矢量图层不参与命中。
      if (!entry || !entry.visible || !GEOJSON_LAYER_TYPES.includes(entry.type)) {
        continue;
      }
      // 尊重图层的缩放范围（与 MapLibre 及 Leaflet shim 一致）：
      // 被 minzoom/maxzoom 门控的图层未渲染，也就不应参与命中测试。
      if (
        (typeof entry.spec.minzoom === "number" && zoom < entry.spec.minzoom) ||
        (typeof entry.spec.maxzoom === "number" && zoom >= entry.spec.maxzoom)
      ) {
        continue;
      }
      // 不在白名单内的图层跳过。
      if (requested && !requested.has(id)) {
        continue;
      }
      const source = this.sources.get(entry.source);
      // 数据源已被删除的悬空图层跳过。
      if (!source) {
        continue;
      }
      // 限制返回数量，防止大数据集拖垮交互（与 Leaflet shim 一致）。
      if (results.length >= 50) {
        break;
      }
      for (const feature of source.resolvedFeatures()) {
        const context = featureContextFor(feature, zoom);
        // 先按图层 filter 过滤，再做像素命中。
        if (
          entry.spec.filter !== undefined &&
          entry.spec.filter !== null &&
          !expressionTruthy(evaluateExpression(entry.spec.filter, context))
        ) {
          continue;
        }
        if (!hitTestFeature(entry.spec, feature, x, y, toPixel, context)) {
          continue;
        }
        results.push({
          type: "Feature",
          geometry: feature.geometry ?? null,
          properties: (isRecord(feature.properties)
            ? feature.properties
            : {}) as Record<string, unknown>,
          // 与 Leaflet shim 的返回形状对齐：带上要素 id（可能为 undefined）。
          id: feature.id,
          layer: { id: entry.id, type: entry.type, source: entry.source },
        });
        if (results.length >= 50) {
          break;
        }
      }
    }
    return results;
  }

  /* ------------------------- 不支持的能力 --------------------------------- */

  /**
   * 返回尺寸信息（截图工具用它取默认点位）；toDataURL 直接抛错，
   * 指引用户改用 DOM 截图方案。
   */
  getCanvas(): {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    toDataURL(): string;
  } {
    const [width, height] = this.effectiveSize();
    return {
      clientWidth: width,
      clientHeight: height,
      width,
      height,
      toDataURL(): never {
        // ol 由多层 canvas/DOM 合成，无法整体读回为图片。
        throw new Error(
          "Map screenshots are not supported by the OpenLayers engine. Capture map.getViewport() with a DOM screenshot library (e.g. html2canvas) instead.",
        );
      },
    };
  }

  /** OpenLayers 不支持 terrain（raster-dem），调用即抛错。 */
  setTerrain(_terrain: unknown): never {
    throw new Error(
      "Terrain (raster-dem) is not supported by the OpenLayers engine.",
    );
  }

  // 有意不提供 setSky：工具层检测到方法缺失后会报告
  // "Sky is not supported by this map engine." —— 与 mapbox-gl 一致。

  /* --------------------------- 标注与弹窗 --------------------------------- */

  /**
   * 围绕持有泪滴形 pin 元素的 ol Overlay 封装 GeoAgentMarker 兼容接口，
   * 使 addMarkerOverlay 与其他引擎行为一致。
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
    const element = document.createElement("div");
    element.className = "geoagent-openlayers-marker-icon";
    // 泪滴形 pin：SVG 路径 + 中心白点。
    element.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 36" width="26" height="36"><path d="M13 0C5.8 0 0 5.8 0 13c0 9.8 11.6 22.2 12.1 22.7.5.5 1.3.5 1.8 0C14.4 35.2 26 22.8 26 13 26 5.8 20.2 0 13 0z" fill="${safeColor}"/><circle cx="13" cy="13" r="5.5" fill="#ffffff"/></svg>`;
    const ns = this.ns;
    const raw = this.raw;
    // 定位在锚点底部居中并上移 2px，使 pin 尖端指向坐标点。
    const overlay = new ns.Overlay({
      element,
      positioning: "bottom-center",
      offset: [0, -2],
      stopEvent: true,
      insertFirst: false,
    });
    // 记录当前经纬度，弹窗打开时要用它定位。
    let position: [number, number] | null = null;
    let popupOverlay: OpenLayersOverlayLike | null = null;
    let closeHandler: ((event?: unknown) => void) | null = null;
    // 关闭弹窗并解绑一次性点击监听，避免残留。
    const closePopup = (): void => {
      if (popupOverlay) {
        raw.removeOverlay(popupOverlay);
      }
      if (closeHandler) {
        raw.un("click", closeHandler);
        closeHandler = null;
      }
    };
    const self = {
      setLngLat(lngLat: [number, number]): unknown {
        position = [lngLat[0], lngLat[1]];
        // [lng, lat] 经 fromLonLat 转到 EPSG:3857 后设置 Overlay 位置。
        overlay.setPosition(ns.fromLonLat([lngLat[0], lngLat[1]]));
        return self;
      },
      addTo(map: unknown): unknown {
        // 允许传入 shim 或裸 ol 地图，统一取真实地图实例。
        const host = isOpenLayersMapShim(map)
          ? map.getRawMap()
          : (map as OpenLayersMapLike);
        host.addOverlay(overlay);
        return self;
      },
      setPopup(popup: unknown): unknown {
        // 提取弹窗内容元素；无法提取则跳过绑定。
        const content = extractOpenLayersPopupElement(popup);
        if (!content) {
          return self;
        }
        // 弹窗 Overlay 惰性创建，点击 pin 时才真正挂到地图。
        popupOverlay = new ns.Overlay({
          element: content,
          positioning: "bottom-center",
          offset: [0, -38],
          stopEvent: true,
          insertFirst: false,
          className: "geoagent-openlayers-popup",
        });
        // 点击 pin：定位弹窗并挂载；首次点击时订阅地图点击用于关闭。
        element.addEventListener("click", () => {
          // 未设置坐标或未绑定弹窗时忽略点击。
          if (!position || !popupOverlay) {
            return;
          }
          popupOverlay.setPosition(ns.fromLonLat(position));
          raw.addOverlay(popupOverlay);
          // 地图任意点击即关闭弹窗；handler 只订阅一次。
          if (!closeHandler) {
            closeHandler = () => closePopup();
            raw.on("click", closeHandler);
          }
        });
        return self;
      },
      getElement(): HTMLElement {
        return element;
      },
      remove(): unknown {
        // 先清理弹窗与监听，再移除 pin 本体。
        closePopup();
        raw.removeOverlay(overlay);
        return undefined;
      },
    };
    return self;
  }

  /** 围绕弹窗内容元素封装 GeoAgentPopup 兼容接口。 */
  createPopup(): {
    setText(text: string): unknown;
    __geoAgentOpenLayersPopupElement: HTMLElement;
  } {
    const element = document.createElement("div");
    element.className = "geoagent-openlayers-popup-content";
    const self = {
      setText(text: string): unknown {
        // 用 textContent 写入，天然免疫 HTML 注入。
        element.textContent = text;
        return self;
      },
      __geoAgentOpenLayersPopupElement: element,
    };
    return self;
  }

  /* ------------------------------ 销毁清理 -------------------------------- */

  /**
   * 解绑 shim 在地图上注册的监听器。由工具层在销毁时调用；
   * 不解绑的话，对同一张地图重复挂载会每次泄漏一个 handler，
   * 且残留 handler 会在每次平移时反复同步已脱离的 source。
   */
  destroy(): void {
    this.disposed = true;
    this.raw.un("moveend", this.clusterHandler);
  }

  /** shim 是否已销毁；异步回调（URL GeoJSON）据此跳过写回。 */
  isDisposed(): boolean {
    return this.disposed;
  }
}

/**
 * 从 GeoAgentPopup 包装对象中提取弹窗内容元素；
 * 非 HTMLElement 时返回 null。
 */
function extractOpenLayersPopupElement(popup: unknown): HTMLElement | null {
  if (
    isRecord(popup) &&
    (popup as { __geoAgentOpenLayersPopupElement?: unknown })
      .__geoAgentOpenLayersPopupElement instanceof HTMLElement
  ) {
    return (popup as { __geoAgentOpenLayersPopupElement: HTMLElement })
      .__geoAgentOpenLayersPopupElement;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 工厂函数 + 控件挂载                                                         */
/* -------------------------------------------------------------------------- */

/**
 * OpenLayersMapShim 的工厂函数：把真实地图与 ol 命名空间包装成 shim。
 */
export function createOpenLayersMapShim(
  map: OpenLayersMapLike,
  namespace: Record<string, unknown>,
): OpenLayersMapShim {
  return new OpenLayersMapShim(map, namespace);
}

/** 类型守卫：值是否为 OpenLayersMapShim 实例。 */
export function isOpenLayersMapShim(value: unknown): value is OpenLayersMapShim {
  return value instanceof OpenLayersMapShim;
}

/**
 * 控件挂载句柄：调用 remove() 卸载控件并清理 DOM。
 */
export interface OpenLayersControlAttachment {
  remove(): void;
}

/** 归一化后的控件角落位置（与 MapLibre 的 position 取值一致）。 */


/**
 * 把 GeoAgentControl 挂载到 OpenLayers 地图上。
 *
 * OpenLayers 没有可供外部控件使用的 map.addControl 槽位，因此这里把控件
 * 元素挂进视口的 .ol-overlaycontainer-stopevent（ol 自带控件的驻留地），
 * 并按请求的角落绝对定位。控件必须以
 * mapEngine { kind: "openlayers", namespace } 创建。
 *
 *   const control = new GeoAgentControl({ mapEngine: { kind: "openlayers", namespace } });
 *   const attachment = addGeoAgentToOpenLayersMap(control, map, { position: "top-left" });
 *   // 之后：attachment.remove();
 */
export function addGeoAgentToOpenLayersMap(
  control: GeoAgentControl,
  map: OpenLayersMapLike,
  options?: { position?: string },
): OpenLayersControlAttachment {
  // 先做鸭子类型校验，防止误传其他引擎的地图实例。
  if (!isOpenLayersMap(map)) {
    throw new Error(
      "addGeoAgentToOpenLayersMap expects an OpenLayers map instance created with new Map(...).",
    );
  }
  // 读取控件私有 options，校验引擎类型是否匹配。
  const internal = control as unknown as {
    options?: { position?: string; mapEngine?: { kind?: string } };
    onRemove(): void;
  };
  const engineKind = internal.options?.mapEngine?.kind;
  // kind 已设置且不匹配时直接报错。
  if (engineKind && engineKind !== "openlayers") {
    throw new Error(
      `GeoAgentControl was created with mapEngine.kind "${engineKind}"; OpenLayers hosts need { kind: "openlayers", namespace }.`,
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
  // 面板将追加到地图容器（target 元素）中并绝对定位；
  // 确保该容器是定位上下文。
  const target = map.getTargetElement?.();
  if (target && window.getComputedStyle(target).position === "static") {
    target.style.position = "relative";
  }
  // 复用控件的 onAdd 构建 DOM（map 参数仅为签名兼容，不会调用其 MapLibre 方法）。
  const element = control.onAdd(map as unknown as MapLibreMap);
  // 专属类名便于样式定制与识别。
  element.classList.add("geoagent-openlayers-control");
  const [vertical, horizontal] = position.split("-") as [string, string];
  const viewport = map.getViewport();
  // 优先挂进 ol 的"事件拦截层"，使控件内的交互不触发地图手势。
  const host =
    viewport.querySelector<HTMLElement>(".ol-overlaycontainer-stopevent") ??
    viewport;
  // 绝对定位到请求的角落（z-index 10 与 ol 控件层级一致）。
  element.style.position = "absolute";
  element.style.zIndex = "10";
  element.style.pointerEvents = "auto";
  // 上下定位互斥：设置一侧并清空另一侧。
  if (vertical === "top") {
    element.style.top = "10px";
    element.style.bottom = "";
  } else {
    element.style.bottom = "10px";
    element.style.top = "";
  }
  // 左右定位互斥：设置一侧并清空另一侧。
  if (horizontal === "left") {
    element.style.left = "10px";
    element.style.right = "";
  } else {
    element.style.right = "10px";
    element.style.left = "";
  }
  host.appendChild(element);
  // 返回卸载句柄：先走控件自身的清理流程，再摘除 DOM。
  return {
    remove(): void {
      internal.onRemove.call(control);
      element.remove();
    },
  };
}
