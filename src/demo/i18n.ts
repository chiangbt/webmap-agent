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
    basicTitle: 'Basic Example',
    basicDesc: 'Use the vanilla `GeoAgentControl` with a MapLibre map.',
    reactTitle: 'React Example',
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
    basicTitle: '基础示例',
    basicDesc: '在 MapLibre 地图上使用原生 `GeoAgentControl`。',
    reactTitle: 'React 示例',
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
};
