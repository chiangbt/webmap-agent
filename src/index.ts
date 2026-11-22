/**
 * 包主入口（vanilla 版）：引入命令式控件样式，集中导出无头引擎核心、
 * 浮动面板控件、各地图引擎的 agent 工具类与兼容 shim，以及共享类型。
 */
import './lib/styles/geoagent-control.css';

// 命令式浮动面板控件（实现 MapLibre IControl）与无头引擎核心 GeoAgentCore。
export { GeoAgentControl } from './lib/core/control/GeoAgentControl';
export { GeoAgentCore } from './lib/core/GeoAgentCore';
// 地图工具层：工具集类、默认底图配置、GeoJSON 渲染辅助函数与相关类型。
export {
  GeoAgentTools,
  DEFAULT_BASEMAPS,
  geoJsonBounds,
  geoJsonGeometryTypes,
  geojsonLayerDefs,
  geojsonLayerPaint,
  slug,
  toJsonValue,
  type BBox,
  type JsonObject,
  type GeoAgentToolsOptions,
  type MapLibreAgentToolsOptions,
  type GeoAgentMapEngine,
  type GeoAgentMapSurface,
  type GeoAgentStyleSnapshot,
  type GeoAgentSurfaceCanvas,
  type GeoAgentSurfaceFeature,
  type GeoAgentStyleSpecEngine,
  type GeoAgentStyleSpecNamespace,
  type GeoAgentLeafletEngine,
  type GeoAgentOpenLayersEngine,
  type GeoAgentArcGISEngine,
  type GeoAgentMarker,
  type GeoAgentPopup,
} from './lib/core/tools/geoagent-tools';
// 各引擎的 agent 工具类，可脱离工厂单独实例化使用。
export { MapLibreAgentTools } from './lib/core/tools/maplibre-tools';
export { LeafletAgentTools } from './lib/core/tools/leaflet-tools';
export { OpenLayersAgentTools } from './lib/core/tools/openlayers-tools';
export { ArcGISTools } from './lib/core/tools/arcgis-tools';
// 工具工厂：按 mapEngine 类型创建与地图引擎匹配的 GeoAgentTools 实例。
export { createGeoAgentTools } from './lib/core/tools/tools-factory';

// Leaflet 兼容层：MapShim 包装、把 GeoAgent 控件挂到 Leaflet map 的辅助函数
// 与实例类型守卫（Leaflet 没有外来控件的 addControl 槽位，需经此挂载）。
export {
  LeafletMapShim,
  addGeoAgentToLeafletMap,
  createLeafletMapShim,
  isLeafletMap,
  isLeafletMapShim,
  type LeafletControlAttachment,
  type LeafletMapLike,
} from './lib/core/engines/leaflet-engine';

// OpenLayers 兼容层：MapShim 包装、挂载辅助函数、类型守卫，以及宿主需传入
// 的 ol 类/辅助函数集合类型 OpenLayersNamespace。
export {
  OpenLayersMapShim,
  addGeoAgentToOpenLayersMap,
  createOpenLayersMapShim,
  isOpenLayersMap,
  isOpenLayersMapShim,
  type OpenLayersControlAttachment,
  type OpenLayersMapLike,
  type OpenLayersNamespace,
} from './lib/core/engines/openlayers-engine';

// ArcGIS 兼容层：MapShim 包装、把 GeoAgent 控件挂到 MapView/SceneView 的辅助
// 函数、类型守卫（含 `<arcgis-map>` web component 的等待/识别工具），以及
// 宿主需传入的 esri 类集合类型 ArcGISNamespace。
export {
  ArcGISMapShim,
  addGeoAgentToArcGISMap,
  createArcGISMapShim,
  isArcGISComponent,
  isArcGISMapShim,
  isArcGISSceneView,
  isArcGISView,
  resolveArcGISView,
  waitForArcGISComponent,
  type ArcGISControlAttachment,
  type ArcGISComponentLike,
  type ArcGISNamespace,
  type ArcGISViewLike,
} from './lib/core/engines/arcgis-engine';

// Google Earth Engine 工具的配置项、图层记录与数据集描述类型（仅类型导出）。
export type {
  EarthEngineOptions,
  EarthEngineLayerRecord,
  GeeDataset,
} from './lib/core/earth-engine/earth-engine';

// 核心共享类型：控件选项、状态快照、会话条目、provider 配置与事件签名。
export type {
  GeoAgentControlEvent,
  GeoAgentControlEventHandler,
  GeoAgentControlOptions,
  GeoAgentControlReactProps,
  GeoAgentConversationChange,
  GeoAgentConversationEntry,
  GeoAgentNoteState,
  GeoAgentProviderConfig,
  GeoAgentProviderId,
  GeoAgentState,
  GeoAgentStatusState,
} from './lib/core/types';

// 面板 UI 文案支持的 locale 类型。
export type { GeoAgentLocale } from './lib/i18n';

export type { GeoJsonLimits } from './lib/utils/geojson';
