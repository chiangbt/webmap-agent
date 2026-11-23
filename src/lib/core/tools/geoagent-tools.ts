import { fetchBoundedText } from '../../utils/request';
import { validateGeoJson, type GeoJsonLimits } from '../../utils/geojson';
/**
 * GeoAgentTools — agent 工具层的引擎无关基类。
 *
 * 基类持有各地图引擎共享的全部内容：overlay 注册表、Style-Spec 物化记账、
 * GeoJSON / cluster / choropleth 构建器、Earth Engine 命令，以及 `runCommand`
 * 入口。它通过每个子类提供的 MapLibre 形状 "surface"（命令面板）驱动地图：
 *
 * - `MapLibreAgentTools`   → 原生 maplibre-gl / mapbox-gl 地图本身
 * - `LeafletAgentTools`    → `LeafletMapShim`（见 leaflet-engine.ts）
 * - `OpenLayersAgentTools` → `OpenLayersMapShim`（见 openlayers-engine.ts）
 *
 * 引擎差异以子类覆写的方式存在，而非运行时 kind 判断：`engineTools()`
 * （模型额外可见的 Strands 工具）、`executeEngineCommand()`（MapLibre 上执行
 * WebGL 专属命令；2D 引擎上抛出明确的能力错误）、`createEngineMarker/Popup`、
 * 脚本工具绑定，以及 namespace 解析。
 *
 * 本文件不做任何 `maplibre-gl` 的静态值导入；默认引擎的 namespace 由
 * `MapLibreAgentTools.loadNamespace()` 惰性加载。
 */
import type { JSONValue, Tool } from "@strands-agents/sdk";
import type {
  AddLayerObject,
  FilterSpecification,
  LayerSpecification,
  SourceSpecification,
  StyleSpecification,
} from "maplibre-gl";
import {
  buildGeeVisParams,
  EarthEngineService,
  parseBbox,
  type EarthEngineOptions,
} from "../earth-engine/earth-engine";
import {
  buildGeeSnippetTool,
  buildGeeToolDefinitions,
  buildMapToolDefinitions,
  buildScriptTool,
  type ToolDefContext,
} from "./tool-defs";
import { searchPlaceChain, type PlaceSearchOptions } from "../geocoding/place-search";

/** 通用 JSON 对象类型：键为 string、值为任意 unknown 的宽松记录。 */
export type JsonObject = Record<string, unknown>;
/** 地理包围盒（bbox），按 [west, south, east, north]（西、南、东、北）顺序存放。 */
export type BBox = [number, number, number, number];

/** 一个 GeoJSON 图层的规格定义：由 geojsonLayerDefs 按 geometry 类型生成，逐个物化为 style layer。 */
interface GeoJsonLayerDefinition {
  /** 完整的 layer id（含后缀，如 `xxx-fill`）。 */
  id: string;
  /** 相对基础 id 的后缀（`-fill` / `-line` / `-point`），用于改名时的去重判断。 */
  suffix: string;
  /** Style-Spec 图层类型：面用 fill、线用 line、点用 circle。 */
  type: "fill" | "line" | "circle";
  /** MapLibre filter 表达式，按 geometry-type 过滤。 */
  filter: unknown[];
  /** 该图层的 paint 属性集合。 */
  paint: JsonObject;
}

/**
 * 工具驱动的 marker 表面（统一接口）。`maplibre-gl` 与 `mapbox-gl` 的
 * `Marker` 都满足它，因此任一引擎的类都能构造出可用的 marker。
 */
export interface GeoAgentMarker {
  setLngLat(lngLat: [number, number]): GeoAgentMarker;
  addTo(map: unknown): GeoAgentMarker;
  setPopup(popup: unknown): GeoAgentMarker;
  getElement(): HTMLElement;
  remove(): unknown;
}

/** marker 工具驱动的 popup 表面；同样由两种 Style-Spec 引擎共享。 */
export interface GeoAgentPopup {
  setText(text: string): GeoAgentPopup;
}

/**
 * getStyle 返回的 style 快照：工具层读取其中的图层清单与 source 规格做
 * 依赖检查与清单展示。真实 maplibre-gl 地图的 StyleSpecification 天然满足；
 * shim 引擎按注册表回放同一形状（入库的 spec 本就来自 Style-Spec）。
 */
export interface GeoAgentStyleSnapshot {
  version?: number;
  sources?: Record<string, SourceSpecification>;
  layers?: LayerSpecification[];
}

/**
 * querySourceFeatures / queryRenderedFeatures 返回的最小要素形状。
 * 真实地图的 MapGeoJSONFeature 与 shim 自建的要素字面量都满足它。
 */
export interface GeoAgentSurfaceFeature {
  type?: "Feature";
  geometry?: GeoJSON.Geometry | null;
  properties?: JsonObject | null;
  id?: number | string | null;
  layer?: { id: string; type: string; source?: string | null };
}

/**
 * getCanvas 返回的最小形状：query_rendered_features 用它取默认点位；
 * toDataURL 只有能合成单一画布的引擎（MapLibre/Mapbox/ArcGIS）提供，
 * DOM 合成类引擎（Leaflet/OpenLayers）可以缺省或抛错。
 */
export interface GeoAgentSurfaceCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  toDataURL?(type?: string): string;
}

/**
 * 工具层驱动的地图命令表面：GeoAgentTools 实际调用的 map API 全集。
 *
 * 这是 GeoAgentTools 基类与各引擎实现之间的显式契约 —— 真实
 * maplibre-gl / mapbox-gl 地图结构上天然满足；Leaflet / OpenLayers /
 * ArcGIS 由各自 shim 显式 `implements`。此后 shim 缺方法或工具层新增
 * 调用，都会成为编译错误，而不是运行到某条命令才暴露。
 *
 * 参数类型说明：spec/filter 类入参用 `XxxSpecification | Record<string,
 * unknown>` 联合 —— 真实地图与 shim 各自按联合中自己那一侧匹配（方法
 * 参数双变），两侧的既有签名都无需改动。`getProjection` 的返回用
 * unknown 承接：maplibre v5 的 projection type 是表达式联合而非字符串。
 */
export interface GeoAgentMapSurface {
  /* -------------------------- 相机与状态 -------------------------- */
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getBearing(): number;
  getPitch(): number;
  getBounds(): {
    getWest(): number;
    getSouth(): number;
    getEast(): number;
    getNorth(): number;
  };
  getProjection(): { type?: unknown; name?: unknown } | undefined;
  jumpTo(options: { center?: [number, number]; zoom?: number }): unknown;
  easeTo(options: { center?: [number, number]; zoom?: number }): unknown;
  flyTo(options: { center?: [number, number]; zoom?: number }): unknown;
  setZoom(zoom: number): unknown;
  isMoving?(): boolean;
  stop?(): void;
  fitBounds(
    bounds: [[number, number], [number, number]],
    options?: { padding?: number; maxZoom?: number },
  ): unknown;
  loaded(): boolean;

  /* ------------------------ style / source / layer ---------------- */
  getStyle(): GeoAgentStyleSnapshot;
  setStyle(style: string | StyleSpecification): void;
  addSource(id: string, spec: SourceSpecification | Record<string, unknown>): void;
  getSource(id: string): unknown;
  removeSource(id: string): void;
  addLayer(layer: AddLayerObject | Record<string, unknown>, beforeId?: string): void;
  /** 仅用于存在性判断与按需的类型读取；真实地图返回 StyleLayer，shim 返回注册表 spec。 */
  getLayer(id: string): unknown;
  removeLayer(id: string): void;
  moveLayer(id: string, beforeId?: string): void;
  setPaintProperty(id: string, property: string, value: unknown): void;
  setLayoutProperty(id: string, property: string, value: unknown): void;
  setFilter(id: string, filter: FilterSpecification | null): void;

  /* ------------------------------ 查询 ---------------------------- */
  querySourceFeatures(
    sourceId: string,
    options?: { sourceLayer?: string; filter?: FilterSpecification },
  ): GeoAgentSurfaceFeature[];
  queryRenderedFeatures(
    point: [number, number],
    options?: { layers?: string[] },
  ): GeoAgentSurfaceFeature[];
  getCanvas(): GeoAgentSurfaceCanvas;

  /* ---------------------- 事件与渲染生命周期 ---------------------- */
  once(type: string, listener: (event?: unknown) => void): void;
  on?(type: string, listener: (event?: unknown) => void): void;
  off?(type: string, listener: (event?: unknown) => void): void;
  triggerRepaint?(): void;

  /* ---------------- WebGL 专属能力（2D shim 抛能力错误） ---------- */
  setTerrain(terrain: { source: string; exaggeration?: number } | null): void;
  setSky?(sky: unknown): void;
  setProjection?(projection: unknown): void;
}

/**
 * 宿主地图来自哪个地图库。
 *
 * 几乎所有工具都停留在 `maplibre-gl` 与 `mapbox-gl` 共享的 Style Spec 表面上，
 * 但有四处不行：marker 工具要构造引擎自己的 `Marker` 与 `Popup`（MapLibre 的
 * 实现会读取 `map._camera.transform`，在 mapbox-gl 地图上会抛错）、
 * `set_projection` 与 `get_map_state` 要说引擎自己的 projection 形状
 * （MapLibre 是 `{ type }`，Mapbox 是名称字符串 / `{ name }`），以及
 * `run_maplibre_script` 要把引擎自己的 namespace 交给用户代码。
 * 明确声明一次引擎，正是为了让这四处行为正确。
 *
 * 默认为 `maplibre-gl`。用 Mapbox GL JS 渲染的宿主应传
 * `{ kind: "mapbox", namespace: mapboxgl }`。
 */
/** Style-Spec 工具驱动的 namespace 形状。 */
export interface GeoAgentStyleSpecNamespace {
  /** Marker 构造器，`add_marker` 工具用它创建引擎自己的 marker。 */
  Marker: new (options?: { color?: string }) => GeoAgentMarker;
  /** Popup 构造器，`add_marker` 工具用它创建引擎自己的 popup。 */
  Popup: new (options?: Record<string, unknown>) => GeoAgentPopup;
  [key: string]: unknown;
}

/** Style-Spec 系引擎声明：maplibre-gl（默认）或 mapbox-gl。 */
export interface GeoAgentStyleSpecEngine {
  /** {@link namespace} 属于哪个 Style-Spec 库。 */
  kind: "maplibre" | "mapbox";
  /**
   * 库自身的 namespace。工具会构造其中的 `Marker` 与 `Popup`；整个对象会被
   * `run_maplibre_script` 交给用户编写的代码，因此必须是完整的真实
   * namespace，不能是子集。
   *
   * 对 `kind: "maplibre"` 可省略：省略时本包在首次工具调用时惰性导入自己的
   * `maplibre-gl` 依赖，这样 Leaflet 与 OpenLayers 宿主永远不会加载它们用不到
   * 的 WebGL 库。对 `kind: "mapbox"` 运行时必须提供 —— 本包从不导入 mapbox-gl。
   */
  namespace?: GeoAgentStyleSpecNamespace;
}

/** Leaflet 引擎声明。 */
export interface GeoAgentLeafletEngine {
  kind: "leaflet";
  /**
   * Leaflet 工厂对象（`import L from "leaflet"` 得到的 `L`）。工具通过一个
   * 兼容 shim（见 leaflet-engine.ts）运行，它把 Style-Spec sources/layers
   * 物化成 Leaflet 图层；`run_maplibre_script` 会把真实的 Leaflet map 与这个
   * namespace 交给用户代码。
   */
  namespace: Record<string, unknown>;
}

/** OpenLayers 引擎声明。 */
export interface GeoAgentOpenLayersEngine {
  kind: "openlayers";
  /**
   * 一个包含 shim 所需 ol 类/工具函数的对象（Feature, Point, Overlay,
   * VectorLayer, TileLayer, VectorSource, XYZ, GeoJSON, Style, Fill, Stroke,
   * CircleStyle, Text, fromLonLat, toLonLat, transformExtent）。工具通过一个
   * 兼容 shim（见 openlayers-engine.ts）运行，它把 Style-Spec sources/layers
   * 物化成 OpenLayers 图层；`run_maplibre_script` 会把真实的 ol Map 与这个
   * namespace 交给用户代码。
   */
  namespace: Record<string, unknown>;
}

/** ArcGIS Maps SDK 引擎声明。 */
export interface GeoAgentArcGISEngine {
  kind: "arcgis";
  /**
   * 宿主传入的是哪种 ArcGIS view：`"map"`（MapView，平面 2D —— 默认）或
   * `"scene"`（SceneView，3D 地球）。shim 按 kind 调整相机模型（scene 上
   * zoom 走 scale、bearing 走 camera.heading、pitch 走 camera.tilt）；
   * system prompt 会描述正确的几何模型。
   */
  viewKind?: "map" | "scene";
  /**
   * 一个包含 shim 要构造的 ArcGIS Maps SDK 类的对象（WebTileLayer,
   * FeatureLayer, Graphic, SimpleFillSymbol, SimpleLineSymbol,
   * SimpleMarkerSymbol, TextSymbol, PictureMarkerSymbol）。工具通过一个
   * 兼容 shim（见 arcgis-engine.ts）运行，它把 Style-Spec sources/layers
   * 物化成 ArcGIS 图层；`run_maplibre_script` 会把真实的 view 与这个
   * namespace 交给用户代码。
   */
  namespace: Record<string, unknown>;
}

/** 所有受支持地图引擎声明的联合类型：由各子类的 resolveEngine 校验。 */
export type GeoAgentMapEngine =
  GeoAgentStyleSpecEngine | GeoAgentLeafletEngine | GeoAgentOpenLayersEngine | GeoAgentArcGISEngine;

/** 一个由 agent 管理的地图叠加项（overlay）；各引擎共享的记账记录。 */
export interface Overlay {
  /** overlay 类别：geojson 数据、raster 瓦片、底图、marker、原生 source/layer、GEE 影像。 */
  kind: "geojson" | "raster" | "basemap" | "marker" | "native" | "gee";
  /** overlay 名称，同时作为注册表 key 与 `remove_layer` 等工具的查找名。 */
  name: string;
  /** 该 overlay 拥有的全部 source id。 */
  sourceIds: string[];
  /** 该 overlay 拥有的全部 layer id。 */
  layerIds: string[];
  /** marker 类 overlay 持有的 marker 实例（其余 kind 无此字段）。 */
  marker?: GeoAgentMarker;
  /** geojson 类 overlay 的原始 GeoJSON 数据（样式切换后重放用）。 */
  data?: GeoJSON.GeoJSON;
  /** raster / geojson（URL 来源）类 overlay 的数据或瓦片地址。 */
  url?: string;
  /** 用户传入的样式参数（GeoJSON 样式或 opacity 等记录）。 */
  style?: JsonObject;
  /** 瓦片图层的 attribution 文本。 */
  attribution?: string;
  /** native 类 overlay 记录的 source 规格，样式切换后按此重放。 */
  sourceSpecs?: Record<string, SourceSpecification>;
  /** native 类 overlay 记录的 layer 规格（含插入位置 beforeId）。 */
  layerSpecs?: Array<{ layer: LayerSpecification; beforeId?: string }>;
  /** terrain 配置：DEM source 与夸张系数，移除 overlay 时需一并清除。 */
  terrain?: { source: string; exaggeration?: number };
  /** sky 配置，移除 overlay 时需一并清除。 */
  sky?: JsonObject;
  /** gee 类 overlay 对应的 Earth Engine 图层名，用于注销 GEE 服务侧记录。 */
  geeLayerName?: string;
}

/**
 * 默认底图清单：change_basemap 工具可用的 style id → 样式 URL 或内联
 * StyleSpecification 映射。值为 string 时视作 MapLibre style URL（`"osm"`
 * 除外，它是 MapLibre 内置的 osm 样式别名）；宿主可通过 options.basemaps
 * 覆盖或追加。
 */
export const DEFAULT_BASEMAPS: Record<string, string | StyleSpecification> = {
  liberty: "https://tiles.openfreemap.org/styles/liberty",
  positron: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  voyager: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
  demotiles: "https://demotiles.maplibre.org/style.json",
  openstreetmap: "osm",
  osm: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: [
          "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        attribution: "OpenStreetMap contributors",
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  },
};

/**
 * add_basemap 工具支持的内置 raster 底图提供商：key → 显示名 / XYZ 瓦片
 * URL 模板 / attribution。这些底图以叠加层方式添加在用户图层之下，不替换
 * 当前 style。
 */
const RASTER_BASEMAPS: Record<string, { name: string; url: string; attribution: string }> = {
  google_satellite: {
    name: "Google Satellite",
    url: "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
    attribution: "Google",
  },
  google_hybrid: {
    name: "Google Hybrid",
    url: "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
    attribution: "Google",
  },
  esri_world_imagery: {
    name: "Esri World Imagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  },
};

/** 等待 map 事件（style.load / idle / render）的超时上限（毫秒），超时后按失败处理。 */
const MAP_EVENT_TIMEOUT_MS = 8000;

/**
 * 从工具入参中取一个数值参数（number 或可转换的字符串），不合法时抛错。
 *
 * @param args - 工具入参对象
 * @param key - 参数名
 * @returns 转换后的有限数值
 * @throws 当值缺失、无法转为数字或为 NaN/Infinity 时抛出 Error
 */
export function numberArg(args: JsonObject, key: string): number {
  // 只接受 number 与 string 两种原始类型；对象/布尔等一律视为非法入参。
  const value = args[key];
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`Expected numeric argument: ${key}`);
  }
  // 空串/空白串经 Number 会静默变成 0（Number("") === 0），必须显式拒绝。
  if (typeof value === "string" && value.trim() === "") {
    throw new Error(`Expected numeric argument: ${key}`);
  }
  const numberValue = Number(value);
  // NaN / Infinity 会污染地图相机与几何计算，必须显式拒绝。
  if (!Number.isFinite(numberValue)) {
    throw new Error(`Expected finite numeric argument: ${key}`);
  }
  return numberValue;
}

/**
 * 把未知值转成有限数值；转换失败（NaN/Infinity/非数值字符串）时返回兜底
 * 值。Math.min/max 会放行 NaN，所以每个来自模型入参的数值样式值都必须先
 * 经此防御。
 */
export function finiteOr(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/** 把未知值夹取到 [0, 1]；转换失败时返回 fallback。 */
export function clampUnit(value: unknown, fallback: number): number {
  return Math.max(0, Math.min(1, finiteOr(value, fallback)));
}

/**
 * 从工具入参中取一个字符串参数，非字符串时返回兜底值（默认空串）。
 *
 * @param args - 工具入参对象
 * @param key - 参数名
 * @param fallback - 值缺失或类型不符时的默认值
 * @returns 字符串值或 fallback
 */
export function stringArg(args: JsonObject, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

/**
 * 从工具入参中取一个对象参数；缺失、非对象或数组时返回空对象 `{}`。
 *
 * @param args - 工具入参对象
 * @param key - 参数名
 * @returns 合法的普通对象，否则为 `{}`
 */
export function objectArg(args: JsonObject, key: string): JsonObject {
  const value = args[key];
  // 排除 null、数组等非普通对象形态，避免把数组当 style/spec 用。
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

/**
 * 把任意值规整为可作 id 使用的 slug：小写、非法字符替换为连字符、去首尾
 * 连字符、截断到 60 字符；结果为空时回退为 "layer"。用于由图层名派生
 * source/layer id，保证 id 合法且可复现。
 *
 * @param value - 任意输入值
 * @returns 规整后的 slug 字符串
 */
export function slug(value: unknown): string {
  return (
    String(value || "layer")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "layer"
  );
}

/**
 * 用单个 [lon, lat] 坐标扩展包围盒；坐标非法或缺失时原样返回。
 *
 * @param bounds - 当前包围盒（可为 null 表示尚未初始化）
 * @param coordinate - 形如 [lon, lat] 的坐标（宽松校验）
 * @returns 扩展后的包围盒；首个有效坐标会初始化为点包围盒
 */
export function extendBounds(bounds: BBox | null, coordinate: unknown): BBox | null {
  if (!Array.isArray(coordinate) || coordinate.length < 2) {
    return bounds;
  }
  const lon = Number(coordinate[0]);
  const lat = Number(coordinate[1]);
  // 非有限数值（NaN 等）不参与扩展，避免污染包围盒。
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return bounds;
  }
  if (!bounds) {
    // 第一个有效坐标：初始化为退化为一个点的包围盒。
    return [lon, lat, lon, lat];
  }
  bounds[0] = Math.min(bounds[0], lon);
  bounds[1] = Math.min(bounds[1], lat);
  bounds[2] = Math.max(bounds[2], lon);
  bounds[3] = Math.max(bounds[3], lat);
  return bounds;
}

/**
 * 递归遍历任意 GeoJSON geometry 的坐标结构，把每个点并入包围盒。
 *
 * @param bounds - 当前包围盒（可为 null）
 * @param geometry - 待遍历的 geometry（可为 null）
 * @returns 覆盖该 geometry 全部坐标的包围盒
 */
export function extendGeometryBounds(
  bounds: BBox | null,
  geometry: GeoJSON.Geometry | null | undefined,
): BBox | null {
  if (!geometry) {
    return bounds;
  }
  // GeometryCollection：对每个子 geometry 递归求并集。
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.reduce(
      (currentBounds, item) => extendGeometryBounds(currentBounds, item),
      bounds,
    );
  }
  const visit = (coordinates: unknown): void => {
    if (!Array.isArray(coordinates)) {
      return;
    }
    // 命中一个坐标点（两个 number 元素）：并入包围盒并停止下钻。
    if (
      coordinates.length >= 2 &&
      typeof coordinates[0] === "number" &&
      typeof coordinates[1] === "number"
    ) {
      bounds = extendBounds(bounds, coordinates);
      return;
    }
    // 否则是嵌套坐标数组（多边形环、Multi* 等），继续递归下钻。
    for (const item of coordinates) {
      visit(item);
    }
  };
  visit(geometry.coordinates);
  return bounds;
}

/**
 * 计算 GeoJSON 的 bbox：优先使用数据自带的 `bbox` 字段（校验其有限性），
 * 否则遍历全部坐标实时计算。支持 FeatureCollection / Feature / 裸 geometry。
 *
 * @param geojson - 待计算的 GeoJSON 数据
 * @returns [west, south, east, north] 包围盒；无有效坐标时返回 null
 */
export function geoJsonBounds(geojson: GeoJSON.GeoJSON | undefined): BBox | null {
  if (!geojson) {
    return null;
  }
  // 数据自带 bbox（可能是 3 维的 6 元素）：取前两维压缩成 2D 包围盒。
  if (Array.isArray(geojson.bbox) && geojson.bbox.length >= 4) {
    const dimension = geojson.bbox.length / 2;
    const bbox = [
      geojson.bbox[0],
      geojson.bbox[1],
      geojson.bbox[dimension],
      geojson.bbox[dimension + 1],
    ].map(Number);
    // 声明的 bbox 必须全部有限才可信，否则回退到实测计算。
    if (bbox.every(Number.isFinite)) {
      return bbox as BBox;
    }
  }
  if (geojson.type === "FeatureCollection") {
    return geojson.features.reduce(
      (currentBounds, feature) => extendGeometryBounds(currentBounds, feature.geometry),
      null as BBox | null,
    );
  }
  if (geojson.type === "Feature") {
    return extendGeometryBounds(null, geojson.geometry);
  }
  // 裸 geometry（非 Feature/FeatureCollection）直接遍历。
  return extendGeometryBounds(null, geojson);
}

/**
 * collectGeometryTypes 的递归辅助：把单个 geometry 的类型并入集合；
 * GeometryCollection 展开为各子 geometry 的类型。
 */
function collectGeometryTypes(
  types: Set<GeoJSON.GeoJsonGeometryTypes>,
  geometry: GeoJSON.Geometry | null | undefined,
): Set<GeoJSON.GeoJsonGeometryTypes> {
  if (!geometry) {
    return types;
  }
  if (geometry.type === "GeometryCollection") {
    for (const item of geometry.geometries) {
      collectGeometryTypes(types, item);
    }
    return types;
  }
  types.add(geometry.type);
  return types;
}

/**
 * 收集 GeoJSON 中出现的全部 geometry 类型（Point/LineString/Polygon 及
 * Multi 变体、GeometryCollection 展开后），用于决定要生成哪几类图层。
 *
 * @param geojson - 待分析的 GeoJSON 数据
 * @returns geometry 类型集合；数据为空时为空集
 */
export function geoJsonGeometryTypes(
  geojson: GeoJSON.GeoJSON | undefined,
): Set<GeoJSON.GeoJsonGeometryTypes> {
  const types = new Set<GeoJSON.GeoJsonGeometryTypes>();
  if (!geojson) {
    return types;
  }
  if (geojson.type === "FeatureCollection") {
    for (const feature of geojson.features) {
      collectGeometryTypes(types, feature.geometry);
    }
    return types;
  }
  if (geojson.type === "Feature") {
    return collectGeometryTypes(types, geojson.geometry);
  }
  return collectGeometryTypes(types, geojson);
}

/**
 * 把用户传入的宽松样式参数（支持驼峰与 Style-Spec 两种键名）解析为
 * fill / line / circle 三套 Style-Spec paint 属性，供 GeoJSON 图层使用。
 *
 * @param style - 用户样式对象（可混用 `fill-color` / `fillColor` 等键名）
 * @returns 三类图层各自的 paint 属性对象
 */
export function geojsonLayerPaint(style: JsonObject): {
  fill: JsonObject;
  line: JsonObject;
  circle: JsonObject;
} {
  // 基础色：优先 `color`，其次 `line-color`，都没有时用默认蓝。
  const color = stringArg(style, "color") || stringArg(style, "line-color") || "#1c7ed6";
  const fillColor = stringArg(style, "fill-color", stringArg(style, "fillColor", color));
  const lineColor = stringArg(style, "line-color", stringArg(style, "lineColor", color));
  const circleColor = stringArg(style, "circle-color", stringArg(style, "circleColor", color));
  // 透明度兼容三种键名：`opacity` / `fill-opacity`，默认 0.35。
  const opacity = style.opacity ?? style["fill-opacity"] ?? 0.35;
  return {
    fill: {
      "fill-color": fillColor,
      "fill-outline-color": lineColor,
      "fill-opacity": clampUnit(opacity, 0.35),
    },
    line: {
      "line-color": lineColor,
      "line-width": finiteOr(style["line-width"] ?? style.lineWidth, 2),
    },
    circle: {
      "circle-color": circleColor,
      "circle-radius": finiteOr(style["circle-radius"] ?? style.radius, 6),
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1,
    },
  };
}

/**
 * 依据 GeoJSON 中实际出现的 geometry 类型生成所需的图层定义列表：
 * 有面生成 fill 图层、有线生成 line 图层、有点生成 circle 图层，各自带
 * geometry-type 过滤；类型未知（如仅提供 URL）时三类全部生成兜底。
 *
 * @param baseId - 图层 id 基础名（会拼接 `-fill` 等后缀）
 * @param paint - geojsonLayerPaint 产出的三套 paint 属性
 * @param geojson - 待渲染的 GeoJSON 数据（用于类型判断）
 * @returns 按面 → 线 → 点顺序排列的图层定义
 */
export function geojsonLayerDefs(
  baseId: string,
  paint: ReturnType<typeof geojsonLayerPaint>,
  geojson: GeoJSON.GeoJSON | undefined,
): GeoJsonLayerDefinition[] {
  const geometryTypes = geoJsonGeometryTypes(geojson);
  const hasKnownTypes = geometryTypes.size > 0;
  // 类型未知时（hasKnownTypes 为 false）三类全建，避免 URL 数据落地后缺图层。
  const hasPolygons =
    !hasKnownTypes || geometryTypes.has("Polygon") || geometryTypes.has("MultiPolygon");
  const hasLines =
    !hasKnownTypes || geometryTypes.has("LineString") || geometryTypes.has("MultiLineString");
  const hasPoints = !hasKnownTypes || geometryTypes.has("Point") || geometryTypes.has("MultiPoint");
  const layerDefs: GeoJsonLayerDefinition[] = [];
  if (hasPolygons) {
    layerDefs.push({
      id: `${baseId}-fill`,
      suffix: "-fill",
      type: "fill",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: paint.fill,
    });
  }
  if (hasLines) {
    layerDefs.push({
      id: `${baseId}-line`,
      suffix: "-line",
      type: "line",
      filter: ["==", ["geometry-type"], "LineString"],
      paint: paint.line,
    });
  }
  if (hasPoints) {
    layerDefs.push({
      id: `${baseId}-point`,
      suffix: "-point",
      type: "circle",
      filter: ["==", ["geometry-type"], "Point"],
      paint: paint.circle,
    });
  }
  return layerDefs;
}

/**
 * 把任意值安全转换为 Strands SDK 要求的 JSONValue：undefined 归一为 null，
 * 经一轮 JSON 序列化/反序列化剥掉函数等不可序列化内容；序列化失败时降级为
 * String(value)。
 *
 * @param value - 任意返回值
 * @returns 可安全放进工具结果 JSONValue
 */
export function toJsonValue(value: unknown): JSONValue {
  if (value === undefined) {
    return null;
  }
  try {
    // JSON 往返会丢弃循环引用与函数、把 undefined 属性剥掉，保证结果可序列化。
    return JSON.parse(JSON.stringify(value)) as JSONValue;
  } catch {
    // 循环引用等无法序列化的场景：退化为字符串表示，不让工具调用整体失败。
    return String(value);
  }
}

/** GeoAgentTools 的构造选项。 */
export interface GeoAgentToolsOptions {
  geoJsonLimits?: GeoJsonLimits;
  /** 追加/覆盖 DEFAULT_BASEMAPS 的底图清单（style id → URL 或 StyleSpecification）。 */
  basemaps?: Record<string, string | StyleSpecification>;
  /** 是否允许执行 run_maplibre_script 等 JS 代码的判定函数（宿主策略）。 */
  allowCodeExecution: () => boolean;
  /** 是否允许 remove_layer / clear_layers 等破坏性操作的判定函数（宿主策略）。 */
  allowDestructiveTools: () => boolean;
  /** Google Earth Engine 配置；未传或 disabled 时不注册 GEE 工具。 */
  earthEngine?: EarthEngineOptions;
  /**
   * 地名/地址搜索配置（三级回退：天地图 → ArcGIS geocoder → LLM）。
   * 未传 tiandituKey 时第一级自动跳过；search_place 工具始终注册。
   */
  placeSearch?: PlaceSearchOptions;
  /** 向宿主 UI 发布非对话状态数据（如截图、GEE 状态）的回调。 */
  onStateDataChange?: (data: Record<string, unknown>) => void;
  /**
   * `map` 来自哪个地图库。每个子类负责校验；见 {@link GeoAgentMapEngine}
   * 与 `createGeoAgentTools`。
   */
  mapEngine?: GeoAgentMapEngine;
}

/**
 * @deprecated 已更名为 {@link GeoAgentToolsOptions}；保留此别名以兼容既有导入。
 */
export type MapLibreAgentToolsOptions = GeoAgentToolsOptions;

/**
 * 引擎无关的 agent 工具基类。子类如何拆分引擎专属表面见文件头注释。
 */
export abstract class GeoAgentTools {
  /**
   * 所有共享命令驱动的地图命令 surface（真地图或 shim），显式契约见
   * {@link GeoAgentMapSurface}。
   */
  protected readonly map: GeoAgentMapSurface;
  /** 合并 DEFAULT_BASEMAPS 与宿主自定义后的底图清单。 */
  private readonly geoJsonLimits: GeoJsonLimits;
  private readonly basemaps: Record<string, string | StyleSpecification>;
  /** JS 代码执行开关的宿主策略（每次调用时实时判定）。 */
  private readonly allowCodeExecution: () => boolean;
  /** 破坏性操作开关的宿主策略（每次调用时实时判定）。 */
  private readonly allowDestructiveTools: () => boolean;
  /** 向宿主 UI 发布状态数据的回调。 */
  private readonly onStateDataChange?: (data: Record<string, unknown>) => void;
  /** agent 管理的 overlay 注册表：名称 → 记账记录（图层/来源/marker 等）。 */
  protected readonly overlays = new globalThis.Map<string, Overlay>();
  // 命令串行队列：runCommand 链式追加，保证并行工具调用逐条执行。
  private commandChain: Promise<void> = Promise.resolve();
  /** Google Earth Engine 服务封装；未配置时为 undefined。 */
  private readonly earthEngine?: EarthEngineService;
  /** 地名/地址搜索配置（天地图 key、端点、超时等）。 */
  private readonly placeSearch?: PlaceSearchOptions;
  /** 经子类 resolveEngine 校验后的引擎声明。 */
  protected readonly engine: GeoAgentMapEngine;
  /**
   * 引擎 namespace，在首个命令执行时经子类 `loadNamespace()` 解析 ——
   * shim 引擎上是宿主注入，默认引擎上是惰性导入的 `maplibre-gl`。
   */
  private resolvedNamespace?: GeoAgentStyleSpecNamespace;

  constructor(map: unknown, options: GeoAgentToolsOptions) {
    // 先确定引擎声明（子类校验 kind 合法性），再据此把宿主地图包装成命令 surface。
    this.geoJsonLimits = options.geoJsonLimits ?? {};
    this.engine = this.resolveEngine(options.mapEngine);
    this.map = this.createSurface(map);
    // 宿主自定义底图覆盖同名默认项。
    this.basemaps = { ...DEFAULT_BASEMAPS, ...options.basemaps };
    this.allowCodeExecution = options.allowCodeExecution;
    this.allowDestructiveTools = options.allowDestructiveTools;
    this.onStateDataChange = options.onStateDataChange;
    // 配置了 Earth Engine 且未显式禁用时创建服务实例，并立即向宿主发布初始状态。
    if (options.earthEngine && options.earthEngine.enabled !== false) {
      this.earthEngine = new EarthEngineService(options.earthEngine);
      this.publishEarthEngineState();
    }
    this.placeSearch = options.placeSearch;
  }

  /* ------------------------------------------------------------ hooks */

  /** 校验（并给出默认值）当前子类对应的引擎声明。 */
  protected abstract resolveEngine(provided: GeoAgentMapEngine | undefined): GeoAgentMapEngine;

  /** 把宿主原始地图包装成 {@link GeoAgentMapSurface} 形状的命令 surface。 */
  protected abstract createSurface(map: unknown): GeoAgentMapSurface;

  /** 提供引擎 namespace（宿主注入或惰性导入）。 */
  protected abstract loadNamespace():
    Promise<GeoAgentStyleSpecNamespace> | GeoAgentStyleSpecNamespace;

  /** 人类可读的引擎名，用于 tool schema 文案与结果消息。 */
  protected abstract engineDisplayName(): string;

  /** 用户脚本可见的引擎 namespace 绑定名。 */
  protected abstract scriptNamespaceName(): string;

  /** 当前引擎上 `run_maplibre_script` 工具的 description 文案。 */
  protected abstract scriptToolDescription(): string;

  /** 引擎专属的 Strands 工具；不追加工具的引擎返回空数组。 */
  protected abstract engineTools(): Tool[];

  /** 执行仅当前引擎理解的命令；其余命令抛错。 */
  protected abstract executeEngineCommand(command: string, args: JsonObject): Promise<unknown>;

  /** 用户脚本拿到的地图对象（shim 引擎上是真实地图而非 shim）。 */
  protected scriptMap(): GeoAgentMapSurface {
    return this.map;
  }

  /** 为 `add_marker` 构造引擎自己的 Marker。 */
  protected createEngineMarker(color: string): GeoAgentMarker {
    return new (this.requireNamespace().Marker)({ color });
  }

  /** 为 `add_marker` 构造引擎自己的 Popup。 */
  protected createEnginePopup(): GeoAgentPopup {
    return new (this.requireNamespace().Popup)();
  }

  /* -------------------------------------------------------- lifecycle */

  /** 运行时更新 Earth Engine 配置并重新发布状态（供宿主面板切换开关用）。 */
  updateEarthEngineOptions(options: EarthEngineOptions): void {
    this.earthEngine?.updateOptions(options);
    this.publishEarthEngineState();
  }

  /**
   * 在任何命令触碰 namespace 之前先解析它。默认 MapLibre 引擎的
   * `loadNamespace()` 在这里惰性导入 `maplibre-gl` —— 本包运行时唯一的加载点
   * —— 因此纯 2D 宿主永远不必为 WebGL 库买单。
   */
  protected async ensureEngineNamespace(): Promise<void> {
    if (this.resolvedNamespace) {
      return;
    }
    this.resolvedNamespace = await this.loadNamespace();
  }

  /** 返回已解析的 namespace；仅在 `ensureEngineNamespace` 执行后有效。 */
  protected requireNamespace(): GeoAgentStyleSpecNamespace {
    if (!this.resolvedNamespace) {
      throw new Error(
        "The map engine namespace is not resolved; drive the tools through runCommand.",
      );
    }
    return this.resolvedNamespace;
  }

  /** 工具生命周期与命令批次；取消后已排队的批次不可再执行。 */
  private destroyed = false;
  private commandController = new AbortController();
  protected activeCommandSignal = this.commandController.signal;

  /** 取消当前及排队命令；后续新命令使用独立 signal。 */
  cancelPendingCommands(): void {
    this.commandController.abort();
    this.commandController = new AbortController();
  }

  protected assertCommandActive(signal = this.activeCommandSignal): void {
    if (this.destroyed) throw new Error("Map tools have been destroyed.");
    signal.throwIfAborted();
  }

  /** 外部异步工作结束或取消后，不允许旧 continuation 再写地图。 */
  protected async awaitCommand<T>(promise: Promise<T>): Promise<T> {
    const signal = this.activeCommandSignal;
    this.assertCommandActive(signal);
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([promise, aborted]);
      this.assertCommandActive(signal);
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** 销毁工具集；资源清理不受用户的图层删除权限限制。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelPendingCommands();
    this.clearOverlays();
  }

  /**
   * 构建暴露给模型的全部 Strands 工具：通用地图工具、引擎专属工具
   * （engineTools()）、以及按宿主开关与配置追加的 JS 代码执行 / Earth Engine
   * 工具组。各组的 schema/文案/回调组装在 tool-defs.ts（经 ToolDefContext
   * 依赖本类的两个入口），本方法只做条件组装。
   *
   * @returns 工具实例数组
   */
  createTools(): Tool[] {
    const ctx: ToolDefContext = {
      runCommand: (command, args) => this.runCommand(command, args),
      requireDestructiveApproval: (action) => this.requireDestructiveApproval(action),
    };
    const tools: Tool[] = buildMapToolDefinitions(ctx, this.engineTools());

    // JS 代码执行类工具：统一受宿主 allowCodeExecution 开关控制。
    if (this.allowCodeExecution()) {
      // 配置了 Earth Engine 时额外提供 GEE 脚本工具。
      if (this.earthEngine) {
        tools.push(buildGeeSnippetTool(ctx));
      }
      // run_maplibre_script：任意引擎脚本逃生舱（文案按当前引擎生成）。
      tools.push(
        buildScriptTool(ctx, {
          description: this.scriptToolDescription(),
          namespaceName: this.scriptNamespaceName(),
        }),
      );
    }

    // Earth Engine 工具组：仅在构造时配置了 earthEngine 时注册。
    if (this.earthEngine) {
      tools.push(...buildGeeToolDefinitions(ctx));
    }

    return tools;
  }

  /**
   * 所有工具 callback 的统一入口：分发命令并把结果规整为 JSONValue。
   *
   * @param command - 命令名（与工具 name 或引擎命令对应）
   * @param args - 工具入参（可为空）
   * @returns 序列化后的命令结果
   */
  async runCommand(command: string, args: unknown = {}): Promise<JSONValue> {
    // args 可能是 null/undefined（无参工具调用），统一兜底为空对象。
    // 命令串行执行：agent 并行工具调用时，change_basemap 的 overlay 快照/
    // 重放与 add_marker 等写操作交错会互相覆盖注册表，链式队列保证一次
    // 只跑一条命令。异常不中断队列（后续命令照常执行），只对本次调用抛出。
    const signal = this.commandController.signal;
    const run = this.commandChain.then(async () => {
      this.assertCommandActive(signal);
      this.activeCommandSignal = signal;
      const result = await this.executeCommand(command, (args ?? {}) as JsonObject);
      this.assertCommandActive(signal);
      return toJsonValue(result);
    });
    this.commandChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 命令处理器表缓存：首次分发时合并六个语义域的处理器。 */
  private commandTable: Record<string, (args: JsonObject) => Promise<unknown>> | null = null;

  /**
   * 命令分发主流程：先确保引擎 namespace 就绪、等地图空闲，再查命令表分发；
   * 未匹配的命令交给 executeEngineCommand 处理引擎专属逻辑。
   */
  private async executeCommand(command: string, args: JsonObject = {}): Promise<unknown> {
    // namespace 惰性解析 + 等待地图空闲，保证后续 addSource/addLayer 落在可用状态上。
    await this.awaitCommand(this.ensureEngineNamespace());
    await this.waitForMapIdle();
    this.assertCommandActive();

    // 命令表惰性构建：六个语义域的处理器合并成一张表，按命令名分发。
    this.commandTable ??= {
      ...this.mapStateCommands(),
      ...this.navigationCommands(),
      ...this.basemapOverlayCommands(),
      ...this.sourceLayerStyleCommands(),
      ...this.geeCommands(),
      ...this.scriptCommands(),
      ...this.placeSearchCommands(),
    };
    const handler = this.commandTable[command];
    if (handler) {
      return handler(args);
    }

    // 其余命令全部是引擎专属的：MapLibre/Mapbox 上执行 WebGL 专属命令，
    // 2D 引擎上抛出明确的能力错误。
    return this.executeEngineCommand(command, args);
  }

  /** 地图状态与查询命令：图层清单、全图状态、来源/渲染要素查询。 */
  private mapStateCommands(): Record<string, (args: JsonObject) => Promise<unknown>> {
    return {
      list_layers: async () => {
        // style 中的图层逐个摘要：id/类型/source/可见性/是否 agent 添加。
        const styleLayers = (this.map.getStyle().layers ?? []).map((layer) => ({
          id: layer.id,
          type: layer.type,
          source: "source" in layer ? layer.source : null,
          visible: layer.layout?.visibility !== "none",
          user_added: this.isOverlayLayerId(layer.id),
        }));
        // marker 不在 style 里：单独从 overlay 注册表取，追加到列表尾部。
        const markerLayers = Array.from(this.overlays.values())
          .filter((overlay) => overlay.kind === "marker")
          .map((overlay) => ({
            id: overlay.name,
            type: "marker",
            source: null,
            // 反映 set_layer_visibility 的切换结果，而不是恒为 true。
            visible: overlay.marker?.getElement().style.display !== "none",
            user_added: true,
          }));
        return [...styleLayers, ...markerLayers];
      },
      get_map_state: async () => {
        const center = this.map.getCenter();
        const bounds = this.map.getBounds();
        // 两种拼写都要读：MapLibre 返回 `{ type }`，mapbox-gl 返回 `{ name }`。
        const projection = this.map.getProjection() as { type?: string; name?: string } | undefined;
        return {
          center: [center.lng, center.lat],
          zoom: this.map.getZoom(),
          bearing: this.map.getBearing(),
          pitch: this.map.getPitch(),
          projection: projection?.type ?? projection?.name ?? "mercator",
          bounds: {
            west: bounds.getWest(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            north: bounds.getNorth(),
          },
          user_layers: Array.from(this.overlays.keys()),
        };
      },
      query_source_features: async (args) => {
        const sourceId = stringArg(args, "source_id");
        if (!sourceId) {
          throw new Error("query_source_features requires source_id.");
        }
        const options: { sourceLayer?: string; filter?: FilterSpecification } = {};
        const sourceLayer = stringArg(args, "source_layer");
        // vector source 的要素按 source-layer 组织，指定后才能查到。
        if (sourceLayer) {
          options.sourceLayer = sourceLayer;
        }
        if (Array.isArray(args.filter)) {
          options.filter = args.filter as FilterSpecification;
        }
        // 归一化为标准 FeatureCollection 返回。
        return {
          type: "FeatureCollection",
          features: this.map.querySourceFeatures(sourceId, options).map((feature) => ({
            type: "Feature",
            geometry: feature.geometry ?? null,
            properties: feature.properties ?? {},
            id: feature.id,
          })),
        };
      },
      query_rendered_features: async (args) => {
        const canvas = this.map.getCanvas();
        // 未给 x/y 时退化为画布中心点。
        const point: [number, number] =
          args.x == null || args.y == null
            ? [canvas.clientWidth / 2, canvas.clientHeight / 2]
            : [Number(args.x), Number(args.y)];
        const layers: string[] = [];
        if (Array.isArray(args.layers)) {
          for (const requested of args.layers) {
            const layerName = String(requested);
            const overlay = this.overlays.get(layerName);
            if (overlay) {
              // overlay 名展开为其名下的全部 layer id。
              layers.push(...overlay.layerIds);
            } else if (this.map.getLayer(layerName)) {
              layers.push(layerName);
            } else {
              // 未知图层名不能退化成全图扫描 —— 模型明确指定了图层，
              // 否则会拿到不相关结果且没有任何报错。
              throw new Error(`Layer not found: ${layerName}`);
            }
          }
        }
        // 结果裁剪到 50 条并摘要化，避免超大响应撑爆上下文。
        return this.map
          .queryRenderedFeatures(point, layers.length ? { layers } : {})
          .slice(0, 50)
          .map(this.serializableFeature);
      },
    };
  }

  /**
   * 地名/地址搜索命令：search_place。跑 geocoding 模块的三级回退链
   * （天地图 → ArcGIS geocoder → LLM 指引），视口包围盒作为天地图查询的
   * focusRectangle 传入，使结果向当前视野倾斜。
   */
  private placeSearchCommands(): Record<string, (args: JsonObject) => Promise<unknown>> {
    return {
      search_place: async (args) => {
        const query = stringArg(args, "query");
        const bounds = this.map.getBounds();
        return searchPlaceChain(
          query,
          this.placeSearch ?? {},
          {
            west: bounds.getWest(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            north: bounds.getNorth(),
          },
        );
      },
    };
  }

  /**
   * set_center 的相机操作 hook：center 为 [lng, lat]（MapLibre 顺序）。
   * 默认无动画跳转（jumpTo）；引擎子类可覆写——例如 Leaflet 用 flyTo
   * 平滑过渡到目标中心。
   */
  protected setCenterCamera(center: [number, number], zoom: number): unknown {
    return this.map.jumpTo({ center, zoom });
  }

  /** 视角导航命令：中心点、飞行、缩放、范围缩放。 */
  private navigationCommands(): Record<string, (args: JsonObject) => Promise<unknown>> {
    return {
      set_center: async (args) => {
        // zoom 与 lat/lon 一样走有限数值校验，坏值会干净地报错，
        // 而不是把 NaN 交给相机。
        const zoom = args.zoom == null ? this.map.getZoom() : numberArg(args, "zoom");
        const center: [number, number] = [numberArg(args, "lon"), numberArg(args, "lat")];
        await this.runCameraAction(() => this.setCenterCamera(center, zoom));
        return "Centered map.";
      },
      fly_to: async (args) => {
        // zoom 缺省保持当前级别；numberArg 校验传入了的 zoom。
        const zoom = args.zoom == null ? this.map.getZoom() : numberArg(args, "zoom");
        await this.runCameraAction(() => this.map.flyTo({
          center: [numberArg(args, "lon"), numberArg(args, "lat")],
          zoom,
        }));
        return "Moved map.";
      },
      set_zoom: async (args) => {
        await this.runCameraAction(() => this.map.setZoom(numberArg(args, "zoom")));
        return "Zoom updated.";
      },
      zoom_to_bounds: async (args) => {
        // fitBounds 带 48px 内边距与 maxZoom 16，避免小范围时过度放大。
        await this.runCameraAction(() => this.map.fitBounds(
          [
            [numberArg(args, "west"), numberArg(args, "south")],
            [numberArg(args, "east"), numberArg(args, "north")],
          ],
          { padding: 48, maxZoom: 16 },
        ));
        return "Zoomed to bounds.";
      },
    };
  }

  /** Await promise-based cameras or the movement event on synchronous map APIs. */
  private async runCameraAction(action: () => unknown): Promise<void> {
    const signal = this.activeCommandSignal;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      try {
        this.map.stop?.();
      } catch {
        // The host may have already disposed the map.
      }
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const result = action();
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Camera movement timed out.")), MAP_EVENT_TIMEOUT_MS);
      });
      await this.awaitCommand(Promise.race([Promise.resolve(result), timeout]));
      if (this.map.isMoving?.() && !(await this.waitForMapEvent("moveend"))) {
        throw new Error("Camera movement timed out.");
      }
    } catch (error) {
      if (!signal.aborted) stop();
      throw error;
    } finally {
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", stop);
    }
  }

  /** 底图与 overlay 命令：底图添加/切换、marker、GeoJSON/矢量/瓦片/影像/聚合/分级渲染图层、移除与清空。 */
  private basemapOverlayCommands(): Record<string, (args: JsonObject) => Promise<unknown>> {
    return {
      add_basemap: async (args) => {
        // provider 键统一小写后查内置表；也允许直接给自定义 XYZ url。
        const providerKey = stringArg(args, "provider").trim().toLowerCase();
        const provider = providerKey ? RASTER_BASEMAPS[providerKey] : undefined;
        const url = stringArg(args, "url") || provider?.url;
        if (!url) {
          throw new Error(
            "add_basemap requires provider or url. Known providers: google_satellite, google_hybrid, esri_world_imagery.",
          );
        }
        // 名称优先级：显式 name > provider 显示名 > provider key > 通用默认名。
        const name = stringArg(args, "name") || provider?.name || providerKey || "Raster Basemap";
        await this.addTileOverlay({
          kind: "basemap",
          beneathUserLayers: true,
          name,
          url,
          attribution: stringArg(args, "attribution") || provider?.attribution,
          // opacity 夹取到 [0,1]，非数值（NaN 路径）回退为 1。
          opacity: args.opacity == null ? undefined : clampUnit(args.opacity, 1),
        });
        return `Added basemap ${name}.`;
      },
      change_basemap: async (args) => {
        // 先按小写 key 查内置底图清单，查不到则把整个字符串当 style URL 用。
        const rawStyle = stringArg(args, "style", "liberty").trim();
        let style = this.basemaps[rawStyle.toLowerCase()] ?? rawStyle;
        // style 值仍是字符串且命中清单（如 "osm" 别名指向 StyleSpecification）时二次解析。
        if (typeof style === "string" && this.basemaps[style]) {
          style = this.basemaps[style];
        }
        const overlayLayerIds = new Set(Array.from(this.overlays.values()).flatMap((overlay) => overlay.layerIds));
        const liveLayers = new Map(
          (this.map.getStyle()?.layers ?? [])
            .filter((layer) => overlayLayerIds.has(layer.id))
            .map((layer) => [layer.id, this.cloneSpec(layer)]),
        );
        // 等待新 style 加载完成；超时视为失败，避免在残缺 style 上继续操作。
        const styleLoaded = await this.waitForMapEvent("style.load", () => this.map.setStyle(style));
        if (!styleLoaded) {
          throw new Error(`Basemap change to ${rawStyle} timed out waiting for style.load.`);
        }
        // setStyle 会清空旧 style 的全部图层，需要按记账重放用户 overlay。
        const failures = await this.restoreOverlaysAfterStyleChange(liveLayers);
        if (failures.length) {
          throw new Error(`Basemap changed to ${rawStyle}, but some overlays could not be restored: ${failures.join("; ")}.`);
        }
        return `Basemap changed to ${rawStyle}.`;
      },
      add_marker: async (args) => {
        const name = this.addMarkerOverlay(args);
        return `Added marker ${name}.`;
      },
      add_geojson_data: async (args) => {
        await this.addGeoJsonOverlay({
          name: stringArg(args, "name", "geojson"),
          data: args.data as GeoJSON.GeoJSON,
          style: objectArg(args, "style"),
          zoomTo: true,
        });
        return `Added GeoJSON layer ${stringArg(args, "name", "geojson")}.`;
      },
      add_vector_data: async (args) => {
        await this.addGeoJsonOverlay({
          name: stringArg(args, "name", "vector-data"),
          url: stringArg(args, "url"),
          style: objectArg(args, "style"),
          zoomTo: true,
        });
        return `Added GeoJSON URL layer ${stringArg(args, "name", "vector-data")}.`;
      },
      add_xyz_tile_layer: async (args) => {
        await this.addTileOverlay({
          kind: "raster",
          name: stringArg(args, "name", "xyz-tiles"),
          url: stringArg(args, "url"),
          attribution: stringArg(args, "attribution"),
        });
        return `Added XYZ tile layer ${stringArg(args, "name", "xyz-tiles")}.`;
      },
      add_image_layer: async (args) => {
        const id = slug(stringArg(args, "id", "image-overlay"));
        const url = stringArg(args, "url");
        // 四角坐标逐个校验合法性（数量、格式、有限性）。
        const coordinates = this.cornerCoordinates(args.coordinates);
        // opacity 夹取到 [0,1]；非数值（NaN 路径）回退为 1。
        const opacity = clampUnit(args.opacity ?? 1, 1);
        const sourceId = `${id}-source`;
        await this.addNativeOverlay({
          name: id,
          sourceSpecs: {
            [sourceId]: {
              type: "image",
              url,
              coordinates,
            } as SourceSpecification,
          },
          layerSpecs: [
            {
              layer: {
                id,
                type: "raster",
                source: sourceId,
                paint: { "raster-opacity": opacity },
              } as LayerSpecification,
            },
          ],
        });
        return `Added image layer ${id}.`;
      },
      add_cluster_layer: async (args) => {
        await this.addClusterLayer(args);
        return `Added cluster layer ${stringArg(args, "name")}.`;
      },
      add_choropleth_layer: async (args) => {
        await this.addChoroplethLayer(args);
        return `Added choropleth layer ${stringArg(args, "name")}.`;
      },
      remove_layer: async (args) => {
        this.requireDestructiveApproval("Layer removal");
        const name = stringArg(args, "name");
        // removeOverlay 按 slug 比对查找；找不到说明不是用户添加的图层。
        if (!this.removeOverlay(name)) {
          throw new Error(`User-added layer not found: ${name}`);
        }
        return `Removed layer ${name}.`;
      },
      clear_layers: async () => {
        this.requireDestructiveApproval("Clearing layers");
        this.clearOverlays();
        return "Cleared user-added layers.";
      },
    };
  }

  /** source/layer/style 操作命令：来源与图层增删、排序、paint/layout/filter、可见性与透明度。 */
  private sourceLayerStyleCommands(): Record<string, (args: JsonObject) => Promise<unknown>> {
    return {
      add_map_source: async (args) => {
        const sourceId = stringArg(args, "source_id");
        if (!sourceId) {
          throw new Error("add_map_source requires source_id.");
        }
        // 以 sourceId 作为 overlay 名登记，使 remove/clear 能按名追踪。
        await this.addNativeOverlay({
          name: sourceId,
          sourceSpecs: {
            [sourceId]: objectArg(args, "source") as SourceSpecification,
          },
        });
        return `Added MapLibre source ${sourceId}.`;
      },
      remove_map_source: async (args) => {
        // 破坏性操作：先校验宿主是否放行。
        this.requireDestructiveApproval("Source removal");
        const sourceId = stringArg(args, "source_id");
        if (!sourceId) {
          throw new Error("remove_map_source requires source_id.");
        }
        // 有活动图层依赖该 source 时拒绝删除，避免渲染残缺。
        const dependentLayers = this.layersUsingSource(sourceId);
        if (dependentLayers.length > 0) {
          throw new Error(
            `Cannot remove source ${sourceId}; active layers depend on it: ${dependentLayers.join(", ")}`,
          );
        }
        const overlayName = this.overlayNameForSource(sourceId);
        if (overlayName && this.overlays.get(overlayName)?.terrain?.source === sourceId) {
          // source 被 terrain overlay 引用：整体移除该 overlay（含 terrain 清理）。
          this.removeOverlay(overlayName);
        } else {
          if (!this.map.getSource(sourceId)) {
            throw new Error(`Source not found: ${sourceId}`);
          }
          this.map.removeSource(sourceId);
          // 同步清理 overlay 记账中对该 source 的引用。
          this.pruneOverlaySource(sourceId);
        }
        return `Removed MapLibre source ${sourceId}.`;
      },
      add_map_layer: async (args) => {
        const layer = objectArg(args, "layer") as LayerSpecification;
        if (!layer.id) {
          throw new Error("add_map_layer requires layer.id.");
        }
        const beforeId = stringArg(args, "before_id") || undefined;
        // 在这里提前校验 beforeId，让代理在每个引擎上都拿到可操作的错误
        // （原生 MapLibre 只会记录 error 事件并静默跳过）。
        if (beforeId && !this.map.getLayer(beforeId)) {
          throw new Error(`Cannot add layer ${layer.id}; before_id not found: ${beforeId}`);
        }
        await this.addNativeOverlay({
          name: layer.id,
          layerSpecs: [{ layer, beforeId }],
        });
        return `Added MapLibre layer ${layer.id}.`;
      },
      remove_map_layer: async (args) => {
        this.requireDestructiveApproval("Layer removal");
        const layerId = stringArg(args, "layer_id");
        if (!layerId) {
          throw new Error("remove_map_layer requires layer_id.");
        }
        if (!this.map.getLayer(layerId)) {
          throw new Error(`Layer not found: ${layerId}`);
        }
        this.map.removeLayer(layerId);
        // 从 overlay 记账中剪除该图层的引用；全部引用耗尽的 native overlay 一并注销。
        this.pruneOverlayLayer(layerId);
        return `Removed MapLibre layer ${layerId}.`;
      },
      move_layer: async (args) => {
        const layerId = stringArg(args, "layer_id");
        const beforeId = stringArg(args, "before_id") || undefined;
        // 目标图层与参照图层都必须存在。
        this.requireLayer(layerId);
        if (beforeId) {
          this.requireLayer(beforeId);
        }
        this.map.moveLayer(layerId, beforeId);
        // 同步记录新的插入位置，保证样式切换重放后次序一致。
        this.updateOverlayLayerBeforeId(layerId, beforeId);
        return `Moved layer ${layerId}.`;
      },
      set_paint_property: async (args) => {
        const layerId = stringArg(args, "layer_id");
        const property = stringArg(args, "property");
        this.requireLayer(layerId);
        if (!property) {
          throw new Error("set_paint_property requires property.");
        }
        this.map.setPaintProperty(layerId, property, args.value);
        // 把修改同步进 overlay 记账的 layer 规格，供样式切换后重放。
        this.updateOverlayLayerSpec(layerId, (layer) => {
          layer.paint = {
            ...(layer.paint ?? {}),
            [property]: args.value,
          } as LayerSpecification["paint"];
        });
        return `Updated paint property ${property} on ${layerId}.`;
      },
      set_layout_property: async (args) => {
        const layerId = stringArg(args, "layer_id");
        const property = stringArg(args, "property");
        this.requireLayer(layerId);
        if (!property) {
          throw new Error("set_layout_property requires property.");
        }
        this.map.setLayoutProperty(layerId, property, args.value);
        this.updateOverlayLayerSpec(layerId, (layer) => {
          layer.layout = {
            ...(layer.layout ?? {}),
            [property]: args.value,
          } as LayerSpecification["layout"];
        });
        return `Updated layout property ${property} on ${layerId}.`;
      },
      set_layer_filter: async (args) => {
        const layerId = stringArg(args, "layer_id");
        this.requireLayer(layerId);
        // 必须显式带 filter 键（null 表示清除），避免漏传被误当成"无操作"。
        if (!("filter" in args)) {
          throw new Error("set_layer_filter requires filter (use null to clear).");
        }
        const filter = args.filter === null ? null : (args.filter as FilterSpecification);
        this.map.setFilter(layerId, filter);
        this.updateOverlayLayerSpec(layerId, (layer) => {
          const mutableLayer = layer as LayerSpecification & {
            filter?: FilterSpecification;
          };
          if (filter == null) {
            delete mutableLayer.filter;
          } else {
            mutableLayer.filter = filter;
          }
        });
        return `Updated filter on ${layerId}.`;
      },
      update_geojson_source: async (args) => {
        const requestedSourceId = stringArg(args, "source_id");
        // 允许传图层名：自动解析为其约定的 `{name}-source`。
        const sourceId = this.resolveGeoJsonSourceId(requestedSourceId);
        const source = this.map.getSource(sourceId) as {
          setData?: (data: GeoJSON.GeoJSON) => void;
        };
        // 只有 geojson source 才有 setData；其它类型/不存在的 source 报错。
        if (!source?.setData) {
          throw new Error(`GeoJSON source not found or not updateable: ${requestedSourceId}`);
        }
        source.setData(args.data as GeoJSON.GeoJSON);
        // 同步更新记账中的 source 规格与原始数据，保证重放一致性。
        this.updateOverlaySourceSpec(sourceId, (sourceSpec) => {
          if (sourceSpec.type === "geojson") {
            (sourceSpec as { data?: unknown }).data = args.data;
          }
        });
        const overlay = this.overlayForSource(sourceId);
        if (overlay?.kind === "geojson") {
          overlay.data = args.data as GeoJSON.GeoJSON;
        }
        return `Updated GeoJSON source ${sourceId}.`;
      },
      set_layer_visibility: async (args) => {
        const name = stringArg(args, "name");
        const overlay = this.overlays.get(name);
        const visibility = args.visible ? "visible" : "none";
        if (overlay) {
          // marker 没有 style layer，改为切换 marker 元素的 display，
          // 避免工具声称成功而 marker 仍停留在屏幕上。
          if (overlay.kind === "marker" && overlay.marker) {
            overlay.marker.getElement().style.display = args.visible ? "" : "none";
            return `Layer ${name} visibility updated.`;
          }
          // 逐个切换该 overlay 名下所有图层的可见性。
          for (const layerId of overlay.layerIds) {
            if (this.map.getLayer(layerId)) {
              this.map.setLayoutProperty(layerId, "visibility", visibility);
            }
          }
          return `Layer ${name} visibility updated.`;
        }
        // 不在注册表里：退而按 layer id 直查 style。
        if (this.map.getLayer(name)) {
          this.map.setLayoutProperty(name, "visibility", visibility);
          return `Layer ${name} visibility updated.`;
        }
        throw new Error(`Layer not found: ${name}`);
      },
      set_layer_opacity: async (args) => {
        const name = stringArg(args, "name");
        const opacity = Math.max(0, Math.min(1, numberArg(args, "opacity")));
        const overlay = this.overlays.get(name);
        // 命中 overlay 时作用于其全部图层，否则把 name 当作 layer id 直查。
        const layerIds = overlay ? overlay.layerIds : [name];
        let changed = false;
        for (const layerId of layerIds) {
          // 真实地图返回 StyleLayer、shim 返回注册表 spec：这里只读类型字段。
          const layer = this.map.getLayer(layerId) as { type?: string } | undefined;
          if (!layer) {
            continue;
          }
          // 透明度属性随图层类型不同，逐一映射；不支持的类型跳过。
          const prop =
            layer.type === "raster"
              ? "raster-opacity"
              : layer.type === "fill"
                ? "fill-opacity"
                : layer.type === "line"
                  ? "line-opacity"
                  : layer.type === "circle"
                    ? "circle-opacity"
                    : null;
          if (prop) {
            this.map.setPaintProperty(layerId, prop, opacity);
            changed = true;
          }
        }
        // 一个图层都没改到：要么图层不存在，要么类型不支持透明度。
        if (!changed) {
          throw new Error(`Layer not found or opacity unsupported: ${name}`);
        }
        return `Layer ${name} opacity updated.`;
      },
    };
  }

  /** Google Earth Engine 命令：目录检索、初始化、数据集加载、指数计算、图层管理、统计与脚本执行。 */
  private geeCommands(): Record<string, (args: JsonObject) => Promise<unknown>> {
    return {
      search_gee_datasets: async (args) => {
        // 未提供的可选参数传 undefined，交给服务层使用默认值。
        return this.requireEarthEngine().searchDatasets({
          query: stringArg(args, "query"),
          category: stringArg(args, "category") || undefined,
          data_type: stringArg(args, "data_type") || undefined,
          source: stringArg(args, "source") || undefined,
          max_results: args.max_results == null ? undefined : Number(args.max_results),
          include_community:
            args.include_community == null ? undefined : Boolean(args.include_community),
        }, this.activeCommandSignal);
      },
      get_gee_dataset_info: async (args) => {
        const assetId = stringArg(args, "asset_id");
        if (!assetId) {
          throw new Error("get_gee_dataset_info requires asset_id.");
        }
        // include_community 缺省视为 true：社区目录同样参与检索。
        return this.requireEarthEngine().getDatasetInfo(
          assetId,
          args.include_community == null ? true : Boolean(args.include_community),
          this.activeCommandSignal,
        );
      },
      summarize_gee_catalog: async (args) => {
        return this.requireEarthEngine().summarizeCatalog(
          args.include_community == null ? true : Boolean(args.include_community),
          this.activeCommandSignal,
        );
      },
      initialize_earth_engine: async (args) => {
        const result = await this.awaitCommand(this.requireEarthEngine().initialize({
          oauthClientId: stringArg(args, "oauth_client_id") || undefined,
          projectId: stringArg(args, "project_id") || undefined,
          force: Boolean(args.force),
        }));
        // 初始化结果（已初始化标志、图层计数）同步到宿主面板状态。
        this.publishEarthEngineState();
        return result;
      },
      load_gee_dataset: async (args) => {
        // 三步走：服务层构建 ee 对象 → 渲染登记（换瓦片 URL → overlay →
        // GEE 服务侧记账 → 缩放）→ 组装结果。
        const layer = await this.awaitCommand(this.requireEarthEngine().buildDatasetLayer(args));
        const tileUrl = await this.renderAndRegisterGeeLayer(
          layer,
          {
            composite_method: layer.composite_method,
            requested_reducer: layer.requested_reducer,
            rendered_band: layer.rendered_band,
            bbox: layer.bbox,
            bounds: layer.bounds,
            clip: layer.clip,
          },
          String(layer.asset_type),
        );
        return {
          success: true,
          asset_id: layer.asset_id,
          asset_type: layer.asset_type,
          layer_name: layer.layer_name,
          composite_method: layer.composite_method,
          requested_reducer: layer.requested_reducer,
          rendered_band: layer.rendered_band,
          diagnostics: layer.diagnostics,
          bbox: layer.bbox,
          bounds: layer.bounds,
          // 附上等价的 ee JavaScript 片段，方便用户复现 / 移植到 GEE Code Editor。
          earth_engine_javascript_snippet: this.buildLoadGeeDatasetSnippet(args),
          vis_params: layer.vis_params,
          tile_url: tileUrl,
          clip: layer.clip,
        };
      },
      calculate_gee_normalized_difference: async (args) => {
        // 服务层负责组合 normalizedDifference 表达式；工具层负责渲染与登记。
        const layer = await this.awaitCommand(this.requireEarthEngine().buildNormalizedDifferenceLayer(args));
        const tileUrl = await this.renderAndRegisterGeeLayer(
          layer,
          {
            index_name: layer.index_name,
            formula: layer.formula,
            bands: layer.bands,
            composite_method: layer.composite_method,
            requested_reducer: layer.requested_reducer,
            bbox: layer.bbox,
            bounds: layer.bounds,
            clip: layer.clip,
          },
          "Image",
        );
        return {
          success: true,
          asset_id: layer.asset_id,
          asset_type: layer.asset_type,
          layer_name: layer.layer_name,
          index_name: layer.index_name,
          formula: layer.formula,
          bands: layer.bands,
          composite_method: layer.composite_method,
          requested_reducer: layer.requested_reducer,
          vis_params: layer.vis_params,
          bbox: layer.bbox,
          bounds: layer.bounds,
          tile_url: tileUrl,
          earth_engine_javascript_snippet: this.buildNormalizedDifferenceSnippet(args),
          clip: layer.clip,
        };
      },
      list_loaded_gee_layers: async () => {
        const layers = this.requireEarthEngine().listLoadedLayers();
        return { count: layers.length, layers };
      },
      set_gee_layer_visualization: async (args) => {
        const result = await this.awaitCommand(this.requireEarthEngine().setLayerVisualization(args));
        // 按新可视化参数重新生成瓦片并叠加（overlay 名相同则覆盖旧层）。
        await this.addTileOverlay({
          kind: "gee",
          name: result.layer_name,
          url: result.tile_url,
        });
        this.requireEarthEngine().registerLayer({
          name: result.layer_name,
          object_type: "EarthEngineObject",
          vis_params: result.vis_params,
          tile_url: result.tile_url,
          source: "earth_engine",
          eeObject: result.eeObject,
        });
        // 新旧图层名不同（另起了 output_layer_name）时注销旧图层，避免重复计数。
        if (result.source_layer_name !== result.layer_name) {
          this.requireEarthEngine().unregisterLayer(result.source_layer_name);
        }
        this.publishEarthEngineState();
        return {
          success: result.success,
          layer_name: result.layer_name,
          source_layer_name: result.source_layer_name,
          vis_params: result.vis_params,
          tile_url: result.tile_url,
        };
      },
      calculate_gee_layer_statistics: async (args) => {
        // 统计可能因区域过大 / 像素超限失败：捕获后返回带 hint 的结构化错误，
        // 让模型能自行降参重试，而不是直接中断对话。
        try {
          return await this.awaitCommand(this.requireEarthEngine().calculateLayerStatistics(args));
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            layer_name: stringArg(args, "layer_name"),
            band: stringArg(args, "band") || null,
            statistics: stringArg(args, "statistics", "mean"),
            scale: Number(args.scale ?? 1000),
            max_pixels: Number(args.max_pixels ?? 100000000),
            best_effort: args.best_effort !== false,
            tile_scale: Number(args.tile_scale ?? 4),
            timeout_seconds: Number(args.timeout_seconds ?? 60),
            hint: "For large regions, retry with a coarser scale such as 2000 or 5000 meters, or provide a smaller region.",
          };
        }
      },
      run_gee_javascript_snippet: async (args) => {
        if (!this.allowCodeExecution()) {
          throw new Error("Earth Engine JavaScript execution is disabled.");
        }
        const code = stringArg(args, "code").trim();
        // runSnippet 在脚本调用 addLayer 等辅助函数时回调本闭包：
        // 即时换取瓦片 URL、叠加图层并登记，实现"边执行边渲染"。
        const signal = this.activeCommandSignal;
        const result = await this.awaitCommand(this.requireEarthEngine().runSnippet(
          code,
          async (eeObject, visParams, name) => {
            this.assertCommandActive(signal);
            const tileUrl = await this.awaitCommand(this.requireEarthEngine().getTileUrl(
              eeObject as never,
              visParams,
            ));
            this.assertCommandActive(signal);
            await this.addTileOverlay({ name, url: tileUrl, kind: "gee" });
            this.requireEarthEngine().registerLayer({
              name,
              object_type:
                (eeObject as { constructor?: { name?: string } })?.constructor?.name ??
                typeof eeObject,
              vis_params: visParams,
              tile_url: tileUrl,
              source: "earth_engine",
              eeObject,
            });
          },
        ));
        this.publishEarthEngineState();
        return { ...result, description: stringArg(args, "description") };
      },
    };
  }

  /** 脚本执行命令：任意 MapLibre JavaScript 片段（受权限开关门控）。 */
  private scriptCommands(): Record<string, (args: JsonObject) => Promise<unknown>> {
    return {
      run_maplibre_script: async (args) => {
        if (!this.allowCodeExecution()) {
          throw new Error(`${this.engineDisplayName()} JavaScript execution is disabled.`);
        }
        // 分发到共享脚本执行器；引擎绑定由子类提供。
        return this.runEngineScript(args);
      },
    };
  }
  /**
   * 等待地图触发一次指定事件（如 style.load、idle、render）。
   *
   * @param eventName - MapLibre 事件名
   * @returns 触发返回 true；超过 MAP_EVENT_TIMEOUT_MS 返回 false
   */
  private waitForMapEvent(eventName: string, trigger?: () => void): Promise<boolean> {
    this.assertCommandActive();
    const signal = this.activeCommandSignal;
    return new Promise((resolve, reject) => {
      // settled 防御超时与事件双路径竞争：先到者生效，后到者被忽略。
      let settled = false;
      // 超时路径也要注销 once 监听器，避免事件迟迟不触发时监听器永久残留。
      let triggered = !trigger;
      let eventReceived = false;
      const handler = () => {
        eventReceived = true;
        if (triggered) finish(true);
      };
      const onAbort = () => finish(false, true);
      const finish = (value: boolean, aborted = false) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        // off 用可选调用：宿主地图包装器可能只实现 once。
        this.map.off?.(eventName, handler);
        signal.removeEventListener("abort", onAbort);
        if (aborted) reject(signal.reason);
        else resolve(value);
      };
      const timeoutId = window.setTimeout(() => finish(false), MAP_EVENT_TIMEOUT_MS);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (eventName === "moveend" && this.map.on && this.map.off) this.map.on(eventName, handler);
        else this.map.once(eventName, handler);
        trigger?.();
        triggered = true;
        if (eventReceived) finish(true);
      } catch (error) {
        // 清理监听器。拒绝必须先于 finish 的默认 resolve。
        reject(error);
        finish(false);
      }
    });
  }

  /** 等待地图进入 idle（全部 tile/渲染就绪）；已 loaded 时立即返回。 */
  private async waitForMapIdle(): Promise<void> {
    this.assertCommandActive();
    if (this.map.loaded()) {
      return;
    }
    await this.waitForMapEvent("idle");
  }

  /**
   * 找到第一个仍存在于地图上的用户 overlay 图层 id（排除指定 overlay 与
   * basemap 类），用作新底图图层的插入锚点——让底图始终垫在用户图层之下。
   */
  private firstUserOverlayLayerId(excludingName?: string): string | undefined {
    for (const overlay of this.overlays.values()) {
      if (overlay.name === excludingName || overlay.kind === "basemap") {
        continue;
      }
      const layerId = overlay.layerIds.find((id) => this.map.getLayer(id));
      if (layerId) {
        return layerId;
      }
    }
    return undefined;
  }

  /** 生成不与现有 source 冲突的 id：冲突时追加 `-2`、`-3`… 递增后缀。 */
  private uniqueSourceId(baseId: string): string {
    let sourceId = baseId;
    let index = 2;
    while (this.map.getSource(sourceId)) {
      sourceId = `${baseId}-${index}`;
      index += 1;
    }
    return sourceId;
  }

  /**
   * 生成不与现有 layer 冲突的基础 id：对每个后缀组合都做存在性检查，
   * 任一冲突整体换名（保证整组图层 id 一致）。
   */
  private uniqueLayerBaseId(baseId: string, suffixes: string[]): string {
    let layerBaseId = baseId;
    let index = 2;
    while (suffixes.some((suffix) => this.map.getLayer(`${layerBaseId}${suffix}`))) {
      layerBaseId = `${baseId}-${index}`;
      index += 1;
    }
    return layerBaseId;
  }

  /** 判断某 layer id 是否属于某个 agent 管理的 overlay（用于 list_layers 标注）。 */
  private isOverlayLayerId(layerId: string): boolean {
    return Array.from(this.overlays.values()).some((overlay) => overlay.layerIds.includes(layerId));
  }

  /** 提取 layer 规格引用的 source id；无 source 或 source 非 string 时返回 null。 */
  private layerSourceId(layer: LayerSpecification): string | null {
    return "source" in layer && typeof layer.source === "string" ? layer.source : null;
  }

  /** 列出当前 style 中引用指定 source 的全部图层 id（删除 source 前的依赖检查）。 */
  private layersUsingSource(sourceId: string): string[] {
    return (this.map.getStyle().layers ?? [])
      .filter((layer) => this.layerSourceId(layer as LayerSpecification) === sourceId)
      .map((layer) => layer.id);
  }

  /** 按 source id 反查所属的 overlay 记录。 */
  private overlayForSource(sourceId: string): Overlay | undefined {
    return Array.from(this.overlays.values()).find((overlay) =>
      overlay.sourceIds.includes(sourceId),
    );
  }

  /** 按 source id 反查所属 overlay 的注册名；不存在时返回 null。 */
  private overlayNameForSource(sourceId: string): string | null {
    const entry = Array.from(this.overlays.entries()).find(([, overlay]) =>
      overlay.sourceIds.includes(sourceId),
    );
    return entry?.[0] ?? null;
  }

  /** 校验图层存在，否则抛出带 id 的错误（各命令共用的前置断言）。 */
  private requireLayer(layerId: string): void {
    if (!layerId) {
      throw new Error("Layer id is required.");
    }
    if (!this.map.getLayer(layerId)) {
      throw new Error(`Layer not found: ${layerId}`);
    }
  }

  /**
   * 移除一个 overlay（支持 slug 容错匹配）及其全部图层/来源/marker/terrain/sky；
   * gee 类 overlay 还会同步注销 GEE 服务侧记录。
   *
   * @param name - overlay 名称（大小写/空格差异经 slug 归一）
   * @returns 是否成功移除
   */
  private overlayKey(name: string): string | undefined {
    // 先精确匹配；slug 归一仅在没有精确命中且候选唯一时兜底——
    // 多个显示名归一后同 slug（如 "Layer - 1" 与 "layer_1"）时按其中
    // 一个名字删除会命中错误对象，此时宁可不删也不误删。
    const keys = Array.from(this.overlays.keys());
    return keys.find((item) => item === name) ??
      (() => {
        const target = slug(name);
        const candidates = keys.filter((item) => slug(item) === target);
        return candidates.length === 1 ? candidates[0] : undefined;
      })();
  }

  protected removeOverlay(name: string, cleanup = false): boolean {
    const key = this.overlayKey(name);
    if (!key) {
      return false;
    }
    const overlay = this.overlays.get(key);
    if (!overlay) {
      return false;
    }
    if (!cleanup) this.requireDestructiveApproval("Layer removal or replacement");
    // terrain/sky 是全局状态而非图层：随 overlay 一起清除。
    if (overlay.terrain) {
      this.clearTerrain();
    }
    if (overlay.sky) {
      this.clearSky();
    }
    // 逐个移除图层与 source（存在性检查，防 shim 上重复删除报错）。
    for (const layerId of overlay.layerIds) {
      if (this.map.getLayer(layerId)) {
        this.map.removeLayer(layerId);
      }
    }
    for (const sourceId of overlay.sourceIds) {
      if (this.map.getSource(sourceId)) {
        this.map.removeSource(sourceId);
      }
    }
    overlay.marker?.remove();
    if (overlay.kind === "gee" && overlay.geeLayerName) {
      // GEE overlay：同步注销服务侧记录并刷新面板状态。
      this.earthEngine?.unregisterLayer(overlay.geeLayerName);
      this.publishEarthEngineState();
    }
    this.overlays.delete(key);
    return true;
  }

  /**
   * 从全部 overlay 记账中剪除对指定 layer 的引用（ids 与 layerSpecs）；
   * native overlay 在图层与来源全部耗尽时整体注销，防止记账泄漏。
   */
  private pruneOverlayLayer(layerId: string): void {
    for (const [name, overlay] of Array.from(this.overlays.entries())) {
      const layerIndex = overlay.layerIds.indexOf(layerId);
      if (layerIndex >= 0) {
        overlay.layerIds.splice(layerIndex, 1);
      }
      if (overlay.layerSpecs) {
        overlay.layerSpecs = overlay.layerSpecs.filter((entry) => entry.layer.id !== layerId);
      }
      if (
        overlay.kind === "native" &&
        overlay.layerIds.length === 0 &&
        overlay.sourceIds.length === 0 &&
        !overlay.terrain &&
        !overlay.sky
      ) {
        this.overlays.delete(name);
      }
    }
  }

  /**
   * 从全部 overlay 记账中剪除对指定 source 的引用（ids 与 sourceSpecs）；
   * 清理规则同 pruneOverlayLayer。
   */
  private pruneOverlaySource(sourceId: string): void {
    for (const [name, overlay] of Array.from(this.overlays.entries())) {
      const sourceIndex = overlay.sourceIds.indexOf(sourceId);
      if (sourceIndex >= 0) {
        overlay.sourceIds.splice(sourceIndex, 1);
      }
      if (overlay.sourceSpecs) {
        delete overlay.sourceSpecs[sourceId];
      }
      if (
        overlay.kind === "native" &&
        overlay.layerIds.length === 0 &&
        overlay.sourceIds.length === 0 &&
        !overlay.terrain &&
        !overlay.sky
      ) {
        this.overlays.delete(name);
      }
    }
  }

  /** move_layer 后同步记账中的插入位置，保证样式切换重放次序正确。 */
  private updateOverlayLayerBeforeId(layerId: string, beforeId: string | undefined): void {
    for (const overlay of this.overlays.values()) {
      const entry = overlay.layerSpecs?.find((item) => item.layer.id === layerId);
      if (entry) {
        entry.beforeId = beforeId;
      }
    }
  }

  /** 对记账中指定 layer 的规格原位应用更新（paint/layout 等改动落盘到重放数据）。 */
  private updateOverlayLayerSpec(
    layerId: string,
    update: (layer: LayerSpecification) => void,
  ): void {
    for (const overlay of this.overlays.values()) {
      const entry = overlay.layerSpecs?.find((item) => item.layer.id === layerId);
      if (entry) {
        update(entry.layer);
      }
    }
  }

  /** 对记账中指定 source 的规格原位应用更新（如 setData 后同步 data）。 */
  private updateOverlaySourceSpec(
    sourceId: string,
    update: (source: SourceSpecification) => void,
  ): void {
    for (const overlay of this.overlays.values()) {
      const sourceSpec = overlay.sourceSpecs?.[sourceId];
      if (sourceSpec) {
        update(sourceSpec);
      }
    }
  }

  /** 清空全部用户 overlay；拷贝 key 列表后再逐个删除，避免遍历时修改集合。 */
  private clearOverlays(): void {
    for (const name of Array.from(this.overlays.keys())) {
      this.removeOverlay(name, true);
    }
  }

  /** 取 Earth Engine 服务；未配置时抛出带指引的错误。 */
  private requireEarthEngine(): EarthEngineService {
    if (!this.earthEngine) {
      throw new Error(
        "Google Earth Engine tools are disabled. Pass earthEngine configuration when creating GeoAgentControl.",
      );
    }
    return this.earthEngine;
  }

  /**
   * 向宿主 UI（面板状态）发布非对话数据。嵌入大体积负载的工具结果
   * （如截图 PNG data URL）必须走这里，而不是返回给模型 —— 数百 KB 的
   * 工具结果会被注入对话历史，撑爆 provider 的输入上限。
   */
  protected publishStateData(data: Record<string, unknown>): void {
    this.assertCommandActive();
    this.onStateDataChange?.(data);
  }

  /** 把 Earth Engine 当前状态（开关、初始化态、图层数）推送给宿主面板。 */
  private publishEarthEngineState(): void {
    if (!this.earthEngine || !this.onStateDataChange) {
      return;
    }
    this.onStateDataChange({
      earthEngine: {
        enabled: true,
        initialized: this.earthEngine.initializedState,
        layerCount: this.earthEngine.listLoadedLayers().length,
      },
    });
  }

  /** 把 surface 查询要素压缩成可序列化的普通 Feature（保留 geometry/properties 与 layer 摘要）。 */
  private serializableFeature(feature: GeoAgentSurfaceFeature): JsonObject {
    return {
      type: "Feature",
      geometry: feature.geometry ?? null,
      properties: feature.properties ?? {},
      layer: feature.layer
        ? {
            id: feature.layer.id,
            type: feature.layer.type,
            source: feature.layer.source,
          }
        : undefined,
    };
  }

  /** 拉取远程 GeoJSON；非 2xx 响应抛出带状态码的错误（不静默吞掉）。 */
  private async fetchGeoJson(url: string): Promise<GeoJSON.GeoJSON> {
    const text = await fetchBoundedText(url, {
      ...this.geoJsonLimits, signal: this.activeCommandSignal, label: "GeoJSON",
    });
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new Error("Invalid GeoJSON: response is not valid JSON."); }
    validateGeoJson(data, this.geoJsonLimits);
    return data;
  }

  /**
   * 缩放到包围盒：单点（west==east 且 south==north）时 easeTo 到该点并把
   * zoom 提到至少 12；正常范围用 fitBounds（48px 内边距、maxZoom 16）。
   * 包围盒缺失或含非有限数值时直接返回。
   */
  private async zoomToGeoJsonBounds(bounds: BBox | null): Promise<void> {
    if (!bounds) {
      return;
    }
    const [west, south, east, north] = bounds;
    if (![west, south, east, north].every(Number.isFinite)) {
      return;
    }
    if (west === east && south === north) {
      // 退化为点的包围盒无法 fitBounds：改为居中并保证最低缩放级别。
      await this.runCameraAction(() => this.map.easeTo({
        center: [west, south],
        zoom: Math.max(this.map.getZoom(), 12),
      }));
      return;
    }
    await this.runCameraAction(() => this.map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 48, maxZoom: 16 },
    ));
  }

  /**
   * 添加 GeoJSON overlay：建 geojson source + 按 geometry 类型生成的一组图层，
   * 新资源创建成功后替换同名旧 overlay；创建失败时只清理本次资源。
   */
  private async addGeoJsonOverlay(overlay: {
    name: string;
    data?: GeoJSON.GeoJSON;
    url?: string;
    style?: JsonObject;
    zoomTo?: boolean;
  }): Promise<void> {
    await this.waitForMapIdle();
    this.assertCommandActive();
    const sourceId = this.uniqueSourceId(`${slug(overlay.name)}-source`);
    const style = overlay.style ?? {};
    const paint = geojsonLayerPaint(style);
    let sourceData = overlay.data;
    if (!sourceData && overlay.url) {
      // 失败要暴露而不是吞掉：这里取不到数据，意味着 MapLibre 自己去取同一个
      // URL 也会失败，图层将渲染为空而工具结果却声称成功。
      // 先 fetch 再删旧 overlay：网络失败时用户原有的同名数据不丢。
      sourceData = await this.fetchGeoJson(overlay.url);
    }
    // 数据就绪后先校验；新资源完整创建之前保留旧 overlay。
    this.assertCommandActive();
    sourceData ??= { type: "FeatureCollection", features: [] };
    validateGeoJson(sourceData, this.geoJsonLimits);
    const previousKey = this.overlayKey(overlay.name);
    if (previousKey) this.requireDestructiveApproval("Layer replacement");
    // 先按原名探测一次图层组合，只为取得 suffix 集合做整体改名检查；
    // 若整组 id 冲突则统一加 `-N` 后缀重建，保证 fill/line/point 三件套命名一致。
    const initialLayerDefs = geojsonLayerDefs(slug(overlay.name), paint, sourceData);
    const baseId = this.uniqueLayerBaseId(
      slug(overlay.name),
      initialLayerDefs.map((item) => item.suffix),
    );
    const layerDefs = geojsonLayerDefs(baseId, paint, sourceData);
    try {
      this.map.addSource(sourceId, { type: "geojson", data: sourceData });
      if (!this.map.getSource(sourceId)) throw new Error(`Could not create source ${sourceId}.`);
      for (const layer of layerDefs) {
        // 剥掉内部记账用的 suffix 字段，其余直接作为 layer 规格。
        const { suffix: _suffix, ...layerDefinition } = layer;
        this.map.addLayer({
          ...layerDefinition,
          source: sourceId,
        } as LayerSpecification);
        if (!this.map.getLayer(layer.id)) throw new Error(`Could not create layer ${layer.id}.`);
      }
      // 所有新资源就绪后才移除旧 overlay；创建失败时旧图层完全不动。
      if (previousKey) this.removeOverlay(previousKey);
    } catch (error) {
      for (const layer of [...layerDefs].reverse()) {
        if (this.map.getLayer(layer.id)) this.map.removeLayer(layer.id);
      }
      if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
      throw error;
    }
    this.overlays.set(overlay.name, {
      kind: "geojson",
      name: overlay.name,
      data: sourceData,
      url: overlay.url,
      style,
      sourceIds: [sourceId],
      layerIds: layerDefs.map((item) => item.id),
    });
    if (overlay.zoomTo) {
      await this.zoomToGeoJsonBounds(geoJsonBounds(sourceData ?? overlay.data));
    }
  }

  /**
   * 添加 raster 瓦片 overlay（source + 单个 raster 图层）并登记。
   * XYZ raster / raster 底图 / GEE 瓦片三个调用方共享同一条管线，
   * 仅 attribution、透明度、插入锚点与记账 kind 有差异。
   */
  private async addTileOverlay(spec: {
    name: string;
    url: string;
    /** 记账类别：gee 类另存 geeLayerName，basemap 类另存透明度。 */
    kind: "raster" | "basemap" | "gee";
    /** attribution；gee 类缺省为 "Google Earth Engine"，其余缺省空串。 */
    attribution?: string;
    /** raster-opacity（默认 1）；basemap 类存进 style 记账供样式切换重放。 */
    opacity?: number;
    /** 底图垫底：图层插入在第一个用户图层之前，保证用户内容在其上。 */
    beneathUserLayers?: boolean;
  }): Promise<void> {
    await this.waitForMapIdle();
    this.assertCommandActive();
    this.removeOverlay(spec.name);
    const sourceId = this.uniqueSourceId(`${slug(spec.name)}-source`);
    const layerId = this.uniqueLayerBaseId(slug(spec.name), [""]);
    const attribution = spec.attribution ?? (spec.kind === "gee" ? "Google Earth Engine" : "");
    this.map.addSource(sourceId, {
      type: "raster",
      tiles: [spec.url],
      tileSize: 256,
      attribution,
    });
    this.map.addLayer(
      {
        id: layerId,
        type: "raster",
        source: sourceId,
        paint: { "raster-opacity": spec.opacity ?? 1 },
      },
      spec.beneathUserLayers
        ? // 插到第一个用户图层之前，保证底图永远垫在用户内容之下。
          this.firstUserOverlayLayerId(spec.name)
        : undefined,
    );
    const base = {
      name: spec.name,
      url: spec.url,
      attribution: spec.attribution,
      sourceIds: [sourceId],
      layerIds: [layerId],
    };
    this.overlays.set(
      spec.name,
      spec.kind === "basemap"
        ? {
            ...base,
            kind: "basemap",
            // opacity 存进 style 记录：change_basemap 重放时按它恢复透明度。
            style: { opacity: spec.opacity ?? 1 },
          }
        : spec.kind === "gee"
          ? { ...base, kind: "gee", geeLayerName: spec.name }
          : { ...base, kind: "raster" },
    );
  }

  /**
   * 渲染并登记一个 GEE 图层：换取瓦片 URL → 添加地图 overlay → GEE 服务侧
   * 记账 → 数据带 bbox 时缩放到数据范围 → 广播 Earth Engine 状态。
   * load_gee_dataset 与 calculate_gee_normalized_difference 共享这条管线；
   * object_type 与 metadata 由调用方按命令语义给定。
   *
   * @returns 换取到的瓦片 URL（调用方组装结果时回显）
   */
  private async renderAndRegisterGeeLayer(
    layer: {
      layer_name: string;
      asset_id?: string;
      asset_type?: string;
      vis_params: Record<string, unknown>;
      eeObject: unknown;
      bbox?: unknown;
    },
    metadata: Record<string, unknown>,
    objectType: string,
  ): Promise<string> {
    const ee = this.requireEarthEngine();
    const tileUrl = await this.awaitCommand(ee.getTileUrl(layer.eeObject as never, layer.vis_params));
    await this.addTileOverlay({
      kind: "gee",
      name: layer.layer_name,
      url: tileUrl,
    });
    this.assertCommandActive();
    // 注册到 GEE 服务侧记账，供后续可视化调整 / 统计 / 列表使用。
    ee.registerLayer({
      name: layer.layer_name,
      asset_id: layer.asset_id,
      asset_type: layer.asset_type,
      object_type: objectType,
      vis_params: layer.vis_params,
      tile_url: tileUrl,
      source: "earth_engine",
      metadata,
      eeObject: layer.eeObject,
    });
    if (layer.bbox) {
      // 数据带 bbox 时自动缩放到数据范围。
      await this.zoomToGeoJsonBounds(layer.bbox as BBox);
    }
    this.publishEarthEngineState();
    return tileUrl;
  }

  /** 深拷贝一个规格对象（JSON 往返），避免入参对象被记账持有后遭外部改写。 */
  private cloneSpec<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  /**
   * 添加 native overlay：记录完整的 source/layer 规格（及可选 terrain/sky），
   * 经 replayNativeOverlay 物化到地图。规格深拷贝入账，样式切换后可原样重放。
   */
  protected async addNativeOverlay(overlay: {
    name: string;
    sourceSpecs?: Record<string, SourceSpecification>;
    layerSpecs?: Array<{ layer: LayerSpecification; beforeId?: string }>;
    terrain?: { source: string; exaggeration?: number };
    sky?: JsonObject;
  }): Promise<void> {
    await this.waitForMapIdle();
    this.assertCommandActive();
    this.removeOverlay(overlay.name);
    const sourceSpecs = overlay.sourceSpecs ? this.cloneSpec(overlay.sourceSpecs) : undefined;
    const layerSpecs = overlay.layerSpecs ? this.cloneSpec(overlay.layerSpecs) : undefined;
    // allowExisting=false：新添加路径下 source/layer 已存在视为错误（防覆盖）。
    await this.replayNativeOverlay(
      {
        kind: "native",
        name: overlay.name,
        sourceIds: Object.keys(sourceSpecs ?? {}),
        layerIds: layerSpecs?.map((entry) => entry.layer.id) ?? [],
        sourceSpecs,
        layerSpecs,
        terrain: overlay.terrain,
        sky: overlay.sky,
      },
      false,
    );
  }

  /**
   * 把一份 native overlay 规格物化到地图：重建缺失的 source/layer、恢复
   * terrain/sky，并登记注册表。样式切换重放与新建共用此路径。
   *
   * @param overlay - 待物化的 overlay 记录
   * @param allowExisting - true（重放）时已存在的 source/layer 直接跳过；
   *                        false（新建）时抛错
   */
  private async replayNativeOverlay(overlay: Overlay, allowExisting = true): Promise<void> {
    await this.waitForMapIdle();
    this.assertCommandActive();
    for (const [sourceId, sourceSpec] of Object.entries(overlay.sourceSpecs ?? {})) {
      if (this.map.getSource(sourceId)) {
        if (!allowExisting) {
          throw new Error(`Source already exists: ${sourceId}`);
        }
        // 重放路径：样式切换后仍在的 source 无需重建。
        continue;
      }
      this.map.addSource(sourceId, this.cloneSpec(sourceSpec));
    }
    for (const { layer, beforeId } of overlay.layerSpecs ?? []) {
      if (this.map.getLayer(layer.id)) {
        if (!allowExisting) {
          throw new Error(`Layer already exists: ${layer.id}`);
        }
        continue;
      }
      const sourceId = this.layerSourceId(layer);
      if (sourceId && !this.map.getSource(sourceId)) {
        throw new Error(`Cannot add layer ${layer.id}; source not found: ${sourceId}`);
      }
      // 记录的 beforeId 可能引用旧 style 的图层（重放发生在 change_basemap
      // 之后）；与其弄丢整个 overlay，不如丢弃该锚点 —— 原生 MapLibre 上
      // 添加会静默无效，shim 引擎上则会抛错并丢弃整个 overlay。
      const effectiveBeforeId = beforeId && this.map.getLayer(beforeId) ? beforeId : undefined;
      this.map.addLayer(this.cloneSpec(layer), effectiveBeforeId);
    }
    if (overlay.terrain) {
      this.setTerrain(overlay.terrain);
    }
    if (overlay.sky) {
      this.setSky(overlay.sky);
    }
    this.overlays.set(overlay.name, overlay);
  }

  /**
   * 校验并规整图像四角坐标：必须恰为 4 个 [lon, lat] 数值对，否则抛错。
   *
   * @returns 顺序为左上、右上、右下、左下的坐标元组
   */
  private cornerCoordinates(
    value: unknown,
  ): [[number, number], [number, number], [number, number], [number, number]] {
    if (!Array.isArray(value) || value.length !== 4) {
      throw new Error("Expected exactly four corner coordinates.");
    }
    return value.map((coordinate) => {
      if (!Array.isArray(coordinate) || coordinate.length < 2) {
        throw new Error("Each corner coordinate must be [lon, lat].");
      }
      const lon = Number(coordinate[0]);
      const lat = Number(coordinate[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        throw new Error("Corner coordinates must be finite numbers.");
      }
      return [lon, lat] as [number, number];
    }) as [[number, number], [number, number], [number, number], [number, number]];
  }

  /** 启用 3D terrain（DEM source + 夸张系数，默认 1）。 */
  protected setTerrain(terrain: { source: string; exaggeration?: number }): void {
    this.map.setTerrain({
      source: terrain.source,
      exaggeration: terrain.exaggeration ?? 1,
    });
  }

  /** 关闭 3D terrain。 */
  protected clearTerrain(): void {
    this.map.setTerrain(null);
  }

  /** 设置 sky 规格；当前地图引擎不支持 setSky 时抛出能力错误。 */
  protected setSky(sky: JsonObject): void {
    // setSky 在 surface 上是可选成员：mapbox-gl 完全没有 setSky（天空经由
    // style layer 绘制），OL shim 也有意不提供，所以 Mapbox 宿主与 OL 宿主
    // 都会走到这里。
    if (typeof this.map.setSky !== "function") {
      throw new Error("Sky is not supported by this map engine.");
    }
    this.map.setSky(sky);
  }

  /** 清除 sky 规格；可用性检查逻辑同 setSky。 */
  protected clearSky(): void {
    if (typeof this.map.setSky !== "function") {
      throw new Error("Sky is not supported by this map engine.");
    }
    this.map.setSky(undefined);
  }

  /**
   * 解析 GeoJSON source id：精确 id 存在直接用；否则尝试自动补 `-source`
   * 后缀（约定图层名的 source 为 `{name}-source`）；都找不到返回原值，
   * 由调用方抛错。
   */
  private resolveGeoJsonSourceId(sourceId: string): string {
    if (!sourceId) {
      throw new Error("update_geojson_source requires source_id.");
    }
    const exactSource = this.map.getSource(sourceId);
    if (exactSource) {
      return sourceId;
    }
    const suffixedSourceId = sourceId.endsWith("-source") ? sourceId : `${sourceId}-source`;
    if (this.map.getSource(suffixedSourceId)) {
      return suffixedSourceId;
    }
    return sourceId;
  }

  /**
   * 构建点聚合（cluster）图层组：geojson cluster source + 聚合圆、可选计数
   * 标注、未聚合单点三个图层，最后可选缩放到数据范围。
   */
  private async addClusterLayer(args: JsonObject): Promise<void> {
    const name = stringArg(args, "name");
    if (!name) {
      throw new Error("add_cluster_layer requires name.");
    }
    // 聚合图层组的四个 id：source、聚合圆、计数标注、未聚合点。
    const sourceId = `${slug(name)}-source`;
    const clusterLayerId = `${slug(name)}-clusters`;
    const countLayerId = `${slug(name)}-cluster-count`;
    const unclusteredLayerId = `${slug(name)}-unclustered`;
    // 分档颜色与阈值：缺省为三色两档的经典配色。
    const clusterColors = Array.isArray(args.cluster_colors)
      ? args.cluster_colors.map(String)
      : ["#51bbd6", "#f1f075", "#f28cb1"];
    const clusterSteps = Array.isArray(args.cluster_steps)
      ? args.cluster_steps.map(Number).filter(Number.isFinite)
      : [100, 750];
    const clusterMinRadius = Number(args.cluster_min_radius ?? 15);
    const clusterMaxRadius = Number(args.cluster_max_radius ?? 30);
    // 颜色 step 表达式：point_count 越大换越暖的颜色；颜色不足时复用最后一档。
    const colorExpr: unknown[] = ["step", ["get", "point_count"], clusterColors[0] ?? "#51bbd6"];
    for (let index = 0; index < clusterSteps.length; index += 1) {
      colorExpr.push(
        clusterSteps[index],
        clusterColors[index + 1] ?? clusterColors.at(-1) ?? "#f28cb1",
      );
    }
    // 半径 step 表达式：在各阈值之间把半径从 min 线性递增到 max。
    const radiusExpr: unknown[] = ["step", ["get", "point_count"], clusterMinRadius];
    const radiusStep =
      clusterSteps.length > 0 ? (clusterMaxRadius - clusterMinRadius) / clusterSteps.length : 0;
    for (let index = 0; index < clusterSteps.length; index += 1) {
      radiusExpr.push(clusterSteps[index], clusterMinRadius + radiusStep * (index + 1));
    }
    const layerSpecs: Array<{ layer: LayerSpecification }> = [
      // 聚合圆：仅渲染带 point_count 的聚合要素。
      {
        layer: {
          id: clusterLayerId,
          type: "circle",
          source: sourceId,
          filter: ["has", "point_count"],
          paint: {
            "circle-color": colorExpr,
            "circle-radius": radiusExpr,
          },
        } as LayerSpecification,
      },
    ];
    // 计数标注默认开启；显式传 false 关闭。
    if (args.show_cluster_count !== false) {
      layerSpecs.push({
        layer: {
          id: countLayerId,
          type: "symbol",
          source: sourceId,
          filter: ["has", "point_count"],
          layout: {
            "text-field": "{point_count_abbreviated}",
            "text-size": 12,
          },
          paint: {
            "text-color": "#ffffff",
          },
        } as LayerSpecification,
      });
    }
    layerSpecs.push({
      layer: {
        id: unclusteredLayerId,
        type: "circle",
        source: sourceId,
        // 未聚合点：过滤掉带 point_count 的聚合占位要素。
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": stringArg(args, "unclustered_color", "#11b4da"),
          "circle-radius": Number(args.unclustered_radius ?? 8),
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
        },
      } as LayerSpecification,
    });
    await this.addNativeOverlay({
      name,
      sourceSpecs: {
        [sourceId]: {
          type: "geojson",
          data: args.data as GeoJSON.GeoJSON,
          cluster: true,
          clusterMaxZoom: Number(args.cluster_max_zoom ?? 14),
          clusterRadius: Number(args.cluster_radius ?? 50),
        } as SourceSpecification,
      },
      layerSpecs,
    });
    if (args.fit_bounds !== false) {
      await this.zoomToGeoJsonBounds(geoJsonBounds(args.data as GeoJSON.GeoJSON));
    }
  }

  /**
   * 构建分级设色（choropleth）图层组：geojson source（generateId 便于要素
   * 引用）+ fill 面 + outline 线两个图层，最后可选缩放到数据范围。
   */
  private async addChoroplethLayer(args: JsonObject): Promise<void> {
    const name = stringArg(args, "name");
    if (!name) {
      throw new Error("add_choropleth_layer requires name.");
    }
    if (!Array.isArray(args.color_expression)) {
      throw new Error("add_choropleth_layer requires color_expression.");
    }
    const sourceId = `${slug(name)}-source`;
    const fillLayerId = slug(name);
    const lineLayerId = `${slug(name)}-outline`;
    // opacity 夹取到 [0,1]；非数值（NaN 路径）回退默认 0.7。
    const fillOpacity = clampUnit(args.fill_opacity ?? 0.7, 0.7);
    await this.addNativeOverlay({
      name,
      sourceSpecs: {
        [sourceId]: {
          type: "geojson",
          data: args.data as GeoJSON.GeoJSON,
          generateId: true,
        } as SourceSpecification,
      },
      layerSpecs: [
        {
          layer: {
            id: fillLayerId,
            type: "fill",
            source: sourceId,
            paint: {
              "fill-color": args.color_expression,
              "fill-opacity": fillOpacity,
            },
          } as LayerSpecification,
        },
        {
          layer: {
            id: lineLayerId,
            type: "line",
            source: sourceId,
            paint: {
              "line-color": stringArg(args, "line_color", "#000000"),
              "line-width": Number(args.line_width ?? 1),
            },
          } as LayerSpecification,
        },
      ],
    });
    if (args.fit_bounds !== false) {
      await this.zoomToGeoJsonBounds(geoJsonBounds(args.data as GeoJSON.GeoJSON));
    }
  }

  // 默认 marker 名的递增计数器。用 overlay 注册表大小推名会撞名
  // （加三个 marker、删掉第一个，下一个默认名会顶掉现存 marker）。
  private markerSeq = 0;

  /**
   * 添加 marker overlay：构造引擎自己的 Marker（经 createEngineMarker）、
   * 设置 tooltip/popup、登记注册表；同名旧 marker 先移除。
   *
   * @returns 实际使用的 marker 名称
   */
  private addMarkerOverlay(args: JsonObject): string {
    // 未提供 name 时用递增计数器命名，保证不与现存 marker 撞名。
    const name = stringArg(args, "name", `marker-${(this.markerSeq += 1)}`);
    this.removeOverlay(name);
    // marker 由引擎子类构造（createEngineMarker）：MapLibre/Mapbox 上是宿主
    // 引擎自己的 Marker 类 —— MapLibre 的 Marker 会读 `map._camera.transform`
    // 在 mapbox-gl 地图上抛错 —— Leaflet/OpenLayers 上则是 shim 的 marker 适配器。
    const marker = this.createEngineMarker(stringArg(args, "color", "#3388ff"))
      .setLngLat([numberArg(args, "lon"), numberArg(args, "lat")])
      .addTo(this.map);
    // 悬停标题：优先 tooltip，其次 popup 文本，最后退化为 marker 名。
    marker.getElement().title = stringArg(args, "tooltip") || stringArg(args, "popup") || name;
    const popup = stringArg(args, "popup");
    if (popup) {
      marker.setPopup(this.createEnginePopup().setText(popup));
    }
    this.overlays.set(name, {
      kind: "marker",
      name,
      marker,
      sourceIds: [],
      layerIds: [],
    });
    return name;
  }

  /**
   * `run_maplibre_script` 的共享实现。绑定由引擎子类提供：`scriptMap()`
   * （shim 引擎上是真实地图）、namespace 名称与解析后的 namespace 对象。
   */
  protected async runEngineScript(args: JsonObject): Promise<JsonObject> {
    const code = stringArg(args, "code").trim();
    if (!code) {
      throw new Error(`No ${this.engineDisplayName()} JavaScript code was provided.`);
    }
    const description = stringArg(args, "description");
    const signal = this.activeCommandSignal;
    const guard = <T>(action: () => T): T => {
      this.assertCommandActive(signal);
      return action();
    };
    // 脚本可用的 helpers：封装常用内部能力；removeOverlay 仍要过破坏性开关。
    const helpers = Object.freeze({
      overlayNames: () => guard(() => Array.from(this.overlays.keys())),
      waitForMapIdle: () => guard(() => this.waitForMapIdle()),
      slug,
      removeOverlay: (name: string) => {
        this.assertCommandActive(signal);
        this.requireDestructiveApproval("Layer removal");
        return this.removeOverlay(name);
      },
      addGeoJsonOverlay: (overlay: {
        name: string;
        data?: GeoJSON.GeoJSON;
        url?: string;
        style?: JsonObject;
        zoomTo?: boolean;
      }) => guard(() => this.addGeoJsonOverlay(overlay)),
      addRasterOverlay: (overlay: { name: string; url: string; attribution?: string }) =>
        guard(() => this.addTileOverlay({ ...overlay, kind: "raster" })),
      addMarkerOverlay: (input: JsonObject) => guard(() => this.addMarkerOverlay(input)),
      serializeScriptResult: toJsonValue,
    });
    // namespace 绑定名取自实际绘制地图的引擎（maplibregl / mapboxgl / L / ol），
    // 与 tool schema 告知模型的作用域一致。
    const namespaceName = this.scriptNamespaceName();
    // 用 new Function 把用户代码包进异步 IIFE 执行（非沙箱）；"use strict"
    // 避免意外的全局变量泄漏。
    const fn = new Function(
      "map",
      namespaceName,
      "helpers",
      `"use strict"; return (async () => {\n${code}\n})()`,
    ) as (
      map: GeoAgentMapSurface,
      mapEngineApi: GeoAgentStyleSpecNamespace,
      helpersArg: Record<string, unknown>,
    ) => Promise<unknown>;
    // 把真正绘制地图的引擎交给用户代码，让脚本里构造 Marker 或 LngLatBounds
    // 时用的是正确的类。Leaflet 宿主上是真实 L.Map 加 L namespace；
    // OpenLayers 宿主上是真实 ol/Map 加 ol namespace —— 那里的用户脚本写
    // 原生引擎代码而非 MapLibre 代码，绕过 shim 注册表（这正是逃生舱）。
    const result = await this.awaitCommand(fn(this.scriptMap(), this.requireNamespace(), helpers));
    return {
      success: true,
      message: description || `${this.engineDisplayName()} script executed.`,
      result: toJsonValue(result),
      description,
      maplibre_script: code,
    };
  }

  /**
   * 生成 load_gee_dataset 结果附带的等价 ee JavaScript 片段：按参数重建
   * asset 构造、时间/空间过滤、reducer 归并与 Map.addLayer 调用，
   * 便于用户在 GEE Code Editor 中复现。
   */
  private buildLoadGeeDatasetSnippet(args: JsonObject): string {
    const assetId = stringArg(args, "asset_id");
    const assetType = stringArg(args, "asset_type", "Image");
    const visParams = buildGeeVisParams({
      bands: args.bands,
      min_value: args.min_value,
      max_value: args.max_value,
      palette: args.palette,
      forFeatureCollection: assetType === "FeatureCollection",
    });
    const lines = [
      `const assetId = ${JSON.stringify(assetId)};`,
      `let layer = ee.${assetType || "Image"}(assetId);`,
    ];
    // 仅 ImageCollection 才有时间过滤、空间过滤与归并逻辑。
    if (assetType === "ImageCollection") {
      lines.push("let collection = ee.ImageCollection(assetId);");
      if (args.start_date || args.end_date) {
        lines.push(
          `collection = collection.filterDate(${JSON.stringify(args.start_date ?? null)}, ${JSON.stringify(args.end_date ?? null)});`,
        );
      }
      if (args.bbox) {
        const bbox = parseBbox(args.bbox);
        if (bbox) {
          lines.push(
            `collection = collection.filterBounds(ee.Geometry.Rectangle(${JSON.stringify(bbox)}));`,
          );
        }
      }
      // reducer 生成对应归并代码；mosaic 直接调 mosaic()，mode 需要 ee.Reducer。
      const reducer = stringArg(args, "reducer", "mosaic");
      lines.push(
        reducer === "mosaic"
          ? "layer = collection.mosaic();"
          : reducer === "mode"
            ? "layer = collection.reduce(ee.Reducer.mode());"
            : `layer = collection.${reducer}();`,
      );
    }
    lines.push(
      `Map.addLayer(layer, ${JSON.stringify(visParams)}, ${JSON.stringify(stringArg(args, "layer_name", assetId.split("/").at(-1) ?? assetId))});`,
    );
    return lines.join("\n");
  }

  /** 生成归一化差异指数计算的等价 ee JavaScript 片段（normalizedDifference + rename）。 */
  private buildNormalizedDifferenceSnippet(args: JsonObject): string {
    const assetId = stringArg(args, "asset_id");
    const indexName = stringArg(args, "index_name", "NDVI") || "ND";
    const positiveBand = stringArg(args, "positive_band");
    const negativeBand = stringArg(args, "negative_band");
    // 归一化指数取值范围是 [-1, 1]，可视化参数缺省按此设定。
    const visParams = buildGeeVisParams({
      bands: indexName,
      min_value: args.min_value ?? -1,
      max_value: args.max_value ?? 1,
      palette: args.palette,
    });
    return [
      `const assetId = ${JSON.stringify(assetId)};`,
      `const source = ee.Image(assetId);`,
      `const image = source.normalizedDifference([${JSON.stringify(positiveBand)}, ${JSON.stringify(negativeBand)}]).rename(${JSON.stringify(indexName)});`,
      `Map.addLayer(image, ${JSON.stringify(visParams)}, ${JSON.stringify(stringArg(args, "layer_name", `${assetId.split("/").at(-1) ?? assetId} ${indexName}`))});`,
    ].join("\n");
  }

  /**
   * change_basemap 之后重放全部用户 overlay：setStyle 会清空旧 style 的所有
   * 图层，各类 overlay 按各自类别重建（geojson/raster/basemap/gee 重走添加
   * 流程，marker 重新 addTo，native 按记录的规格重放）。单个 overlay 恢复
   * 失败后继续恢复其余图层，并把失败详情返回给调用方。
   */
  private async restoreOverlaysAfterStyleChange(liveLayers: ReadonlyMap<string, LayerSpecification>): Promise<string[]> {
    // 先快照再清空注册表：重建流程本身会往注册表写入。
    const saved = Array.from(this.overlays.values()).map((overlay) => ({
      ...overlay,
    }));
    this.overlays.clear();
    const failures: string[] = [];
    // Marker 不随 setStyle 消失：保留注册，取消/销毁时仍可清理。
    for (const overlay of saved) {
      if (overlay.kind === "marker") this.overlays.set(overlay.name, overlay);
    }
    for (const overlay of saved) {
      this.assertCommandActive();
      try {
        if (overlay.kind === "geojson") {
          await this.addGeoJsonOverlay({
            name: overlay.name,
            data: overlay.data,
            url: overlay.url,
            style: overlay.style,
          });
        } else if (overlay.kind === "raster" && overlay.url) {
          await this.addTileOverlay({
            kind: "raster",
            name: overlay.name,
            url: overlay.url,
            attribution: overlay.attribution,
          });
        } else if (overlay.kind === "basemap" && overlay.url) {
          await this.addTileOverlay({
            kind: "basemap",
            beneathUserLayers: true,
            name: overlay.name,
            url: overlay.url,
            attribution: overlay.attribution,
            // 底图的透明度存在 style.opacity 里，重放时按它恢复。
            opacity: Number(overlay.style?.opacity ?? 1),
          });
        } else if (overlay.kind === "gee" && overlay.url) {
          await this.addTileOverlay({
            kind: "gee",
            name: overlay.name,
            url: overlay.url,
            attribution: overlay.attribution,
          });
        } else if (overlay.kind === "marker" && overlay.marker) {
          // marker 实例还在内存里：直接重新挂到新地图即可。
          overlay.marker.addTo(this.map);
          this.overlays.set(overlay.name, overlay);
        } else if (overlay.kind === "native") {
          await this.replayNativeOverlay(overlay);
        }
        const restored = this.overlays.get(overlay.name);
        for (const layerId of restored?.layerIds ?? []) {
          const current = this.map.getLayer(layerId) as { type?: string } | undefined;
          if (!current) continue;
          // Recreated GeoJSON layers can receive a different ID when the new basemap
          // already uses their original name. Each generated layer type is unique.
          const previous = overlay.layerIds.includes(layerId)
            ? liveLayers.get(layerId)
            : overlay.layerIds.map((id) => liveLayers.get(id)).find((layer) => layer?.type === current.type);
          if (!previous) continue;
          for (const [key, value] of Object.entries("paint" in previous ? previous.paint ?? {} : {})) {
            this.map.setPaintProperty(layerId, key, value);
          }
          for (const [key, value] of Object.entries(previous.layout ?? {})) {
            this.map.setLayoutProperty(layerId, key, value);
          }
          if ("filter" in previous && previous.filter) this.map.setFilter(layerId, previous.filter);
        }
      } catch (error) {
        this.assertCommandActive();
        failures.push(`${overlay.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return failures;
  }

  /** 校验宿主是否放行破坏性操作；未放行时抛出带动作名的错误。 */
  private requireDestructiveApproval(action: string): void {
    if (!this.allowDestructiveTools()) {
      throw new Error(`${action} is disabled. Enable layer removal first.`);
    }
  }
}
