import type { GeoAgentLocale } from '@/lib/i18n';

/** Localized strings for the demo site (homepage + shared example chrome). */
export const HOMEPAGE_I18N: Record<
  GeoAgentLocale,
  {
    title: string;
    subtitle: string;
    basicTitle: string;
    basicDesc: string;
    reactTitle: string;
    reactDesc: string;
    earthEngineTitle: string;
    earthEngineDesc: string;
    leafletTitle: string;
    leafletDesc: string;
    openlayersTitle: string;
    openlayersDesc: string;
    arcgisMapTitle: string;
    arcgisMapDesc: string;
    arcgisSceneTitle: string;
    arcgisSceneDesc: string;
    home: string;
    github: string;
    npm: string;
    language: string;
  }
> = {
  en: {
    title: 'web-geoagent Examples',
    subtitle:
      'A browser-only GeoAgent for web maps — MapLibre, Leaflet, OpenLayers, and the ArcGIS Maps SDK (MapView & SceneView).',
    basicTitle: 'MapLibre GL Example',
    basicDesc: 'Use the vanilla `GeoAgentControl` with a MapLibre map.',
    reactTitle: 'MapLibre GL React Example',
    reactDesc: 'Use `GeoAgentControlReact` and the React state hook.',
    earthEngineTitle: 'Earth Engine Example',
    earthEngineDesc: 'Use browser OAuth to add Google Earth Engine catalog layers and indexes.',
    leafletTitle: 'Leaflet Example',
    leafletDesc: 'Run the same GeoAgent tools on a plain Leaflet map via the compatibility engine.',
    openlayersTitle: 'OpenLayers Example',
    openlayersDesc:
      'Run the same GeoAgent tools on a plain OpenLayers map via the compatibility engine.',
    arcgisMapTitle: 'ArcGIS Map Example',
    arcgisMapDesc:
      'Drive an @arcgis/map-components <arcgis-map> (MapView, 2D) with the ArcGIS compatibility engine; demo GeoJSON is seeded through the agent tools.',
    arcgisSceneTitle: 'ArcGIS Scene Example',
    arcgisSceneDesc:
      'Drive an <arcgis-scene> (SceneView 3D globe with world elevation) — camera tools, DOM markers, and screenshots through the shim.',
    home: 'Home',
    github: 'GitHub',
    npm: 'npm',
    language: 'Language',
  },
  'zh-CN': {
    title: 'web-geoagent 示例',
    subtitle:
      '一个纯浏览器端运行的 Web 地图 GeoAgent——支持 MapLibre、Leaflet、OpenLayers 与 ArcGIS Maps SDK（MapView 与 SceneView）。',
    basicTitle: 'MapLibre GL 示例',
    basicDesc: '在 MapLibre 地图上使用原生 `GeoAgentControl`。',
    reactTitle: 'MapLibre GL React 示例',
    reactDesc: '使用 `GeoAgentControlReact` 与 React 状态 Hook。',
    earthEngineTitle: 'Earth Engine 示例',
    earthEngineDesc: '通过浏览器 OAuth 添加 Google Earth Engine 目录图层与指数。',
    leafletTitle: 'Leaflet 示例',
    leafletDesc: '通过兼容引擎在 Leaflet 地图上运行相同的 GeoAgent 工具。',
    openlayersTitle: 'OpenLayers 示例',
    openlayersDesc: '通过兼容引擎在 OpenLayers 地图上运行相同的 GeoAgent 工具。',
    arcgisMapTitle: 'ArcGIS Map 示例',
    arcgisMapDesc: '用 ArcGIS 兼容引擎驱动 @arcgis/map-components 的 <arcgis-map>（MapView，2D），演示数据经 agent 工具预置。',
    arcgisSceneTitle: 'ArcGIS Scene 示例',
    arcgisSceneDesc: '驱动 <arcgis-scene>（带世界高程的 SceneView 3D 球体）——相机工具、DOM 图钉与截图全部经 shim 生效。',
    home: '首页',
    github: 'GitHub',
    npm: 'npm',
    language: '语言',
  },
  'zh-TW': {
    title: 'web-geoagent 範例',
    subtitle:
      '一個純瀏覽器端執行的 Web 地圖 GeoAgent——支援 MapLibre、Leaflet、OpenLayers 與 ArcGIS Maps SDK（MapView 與 SceneView）。',
    basicTitle: 'MapLibre GL 範例',
    basicDesc: '在 MapLibre 地圖上使用原生 `GeoAgentControl`。',
    reactTitle: 'MapLibre GL React 範例',
    reactDesc: '使用 `GeoAgentControlReact` 與 React 狀態 Hook。',
    earthEngineTitle: 'Earth Engine 範例',
    earthEngineDesc: '透過瀏覽器 OAuth 加入 Google Earth Engine 目錄圖層與指數。',
    leafletTitle: 'Leaflet 範例',
    leafletDesc: '透過相容引擎在 Leaflet 地圖上執行相同的 GeoAgent 工具。',
    openlayersTitle: 'OpenLayers 範例',
    openlayersDesc: '透過相容引擎在 OpenLayers 地圖上執行相同的 GeoAgent 工具。',
    arcgisMapTitle: 'ArcGIS Map 範例',
    arcgisMapDesc:
      '用 ArcGIS 相容引擎驅動 @arcgis/map-components 的 <arcgis-map>（MapView，2D），示範資料經 agent 工具預置。',
    arcgisSceneTitle: 'ArcGIS Scene 範例',
    arcgisSceneDesc:
      '驅動 <arcgis-scene>（含世界高程的 SceneView 3D 球體）——相機工具、DOM 圖釘與截圖全部經 shim 生效。',
    home: '首頁',
    github: 'GitHub',
    npm: 'npm',
    language: '語言',
  },
};
