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
    home: string;
    github: string;
    npm: string;
    language: string;
  }
> = {
  en: {
    title: 'maplibre-gl-geoagent Examples',
    subtitle: 'A browser-only GeoAgent control for MapLibre maps.',
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
    home: 'Home',
    github: 'GitHub',
    npm: 'npm',
    language: 'Language',
  },
  'zh-CN': {
    title: 'maplibre-gl-geoagent 示例',
    subtitle: '一个纯浏览器端运行的 MapLibre GeoAgent 控件。',
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
    home: '首页',
    github: 'GitHub',
    npm: 'npm',
    language: '语言',
  },
};
