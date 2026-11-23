/**
 * ArcGIS MapView 2D 示例：演示通过 @arcgis/map-components 的
 * <arcgis-map> web component + arcgis-engine 兼容 shim 接入 GeoAgentPanel。
 *
 * 与其它示例的差异：
 * - 库本身从不 import @arcgis/*，由宿主应用导入 esri 类并一次性组装成
 *   namespace 传入 GeoAgentCore（mapEngine: { kind: "arcgis", viewKind: "map" }）；
 * - viewKind 为 "map"，驱动平面 2D 的 MapView；arcgis-scene 示例则用
 *   viewKind: "scene" 驱动 3D 的 SceneView 相机模型；
 * - 额外演示用 core.getTools().runCommand 经 agent 自身的工具机制
 *   预置一组示例数据（add_geojson_data），面板首轮对话即有图层可操作。
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
// @arcgis/map-components 的 web components + GeoAgent shim 需要构造的 esri 类。
// 库本身从不 import @arcgis/*——由宿主一次性组装好 namespace。
import { defineCustomElements } from '@arcgis/map-components/dist/loader';
import WebTileLayer from '@arcgis/core/layers/WebTileLayer.js';
import FeatureLayer from '@arcgis/core/layers/FeatureLayer.js';
import Graphic from '@arcgis/core/Graphic.js';
import SimpleFillSymbol from '@arcgis/core/symbols/SimpleFillSymbol.js';
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol.js';
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol.js';
import TextSymbol from '@arcgis/core/symbols/TextSymbol.js';
import PictureMarkerSymbol from '@arcgis/core/symbols/PictureMarkerSymbol.js';
import { GeoAgentCore } from '@/lib/core/GeoAgentCore';
import { GeoAgentPanel } from '@/react';
import { waitForArcGISComponent } from '@/lib/core/engines/arcgis-engine';
import { ExampleShell } from '@/demo/example-shell';
import { applyExamplePageLocale, resolveExamplesLocale } from '@/demo/locale';
import { HOMEPAGE_I18N } from '@/demo/i18n';
import { readLlmEnvConfig } from '@/demo/env';
import '@/demo/demo.css';
import '@arcgis/map-components/dist/arcgis-map-components/arcgis-map-components.css';

// 注册 <arcgis-map> / <arcgis-scene> 等 web component。
void defineCustomElements();

// 跟随示例首页选择的语言（存储在 localStorage）。
const locale = resolveExamplesLocale();
// 从 .env 读取的部署默认值（LLM_API_URL / LLM_API_KEY / LLM_API_MODEL）。
const llm = readLlmEnvConfig();
applyExamplePageLocale(locale, {
  en: 'web-geoagent - ArcGIS Map Example',
  zh: 'web-geoagent - ArcGIS Map 示例',
  tw: 'web-geoagent - ArcGIS Map 範例',
});

/**
 * 手工构造的小型示例数据集，通过 agent 自己的工具机制（runCommand）注入，
 * 使面板首轮对话时就已经有 agent 托管的图层可供查询与改样式：
 * 两个行政区面、一条公交线路（Bus 38）和四个咖啡馆点，均位于旧金山。
 */
const DEMO_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-122.44, 37.77],
            [-122.39, 37.77],
            [-122.39, 37.81],
            [-122.44, 37.81],
            [-122.44, 37.77],
          ],
        ],
      },
      properties: { name: 'Downtown', population: 87000, density: 14500 },
    },
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-122.51, 37.79],
            [-122.45, 37.79],
            [-122.45, 37.83],
            [-122.51, 37.83],
            [-122.51, 37.79],
          ],
        ],
      },
      properties: { name: 'Richmond', population: 71000, density: 9800 },
    },
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-122.508, 37.802],
          [-122.472, 37.804],
          [-122.44, 37.789],
          [-122.417, 37.784],
        ],
      },
      properties: { name: 'Bus 38', ridership: 21000 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.419, 37.779] },
      properties: { name: 'Cafe Mission', rating: 4.7, seats: 40 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.434, 37.786] },
      properties: { name: 'Cafe Civic', rating: 4.4, seats: 65 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.462, 37.79] },
      properties: { name: 'Cafe Presidio', rating: 4.8, seats: 30 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.497, 37.808] },
      properties: { name: 'Cafe Golden Gate', rating: 4.6, seats: 52 },
    },
  ],
} as const;

/**
 * 页面主组件：渲染 <arcgis-map> web component，并通过 GeoAgentCore +
 * GeoAgentPanel 接入 agent；视图就绪后经 runCommand 预置示例数据。
 * @returns 左侧 GeoAgent 面板 + 右侧地图容器的页面布局。
 */
function ArcGISMapExample() {
  const mapElement = useRef<HTMLElementTagNameMap['arcgis-map']>(null);
  // 惰性初始化 GeoAgentCore：仅在首次渲染时创建一次，
  // 并在此挂接 ArcGIS 兼容引擎与 esri 命名空间。
  const [core] = useState(
    () =>
      new GeoAgentCore({
        collapsed: false,
        locale,
        defaultBaseUrl: llm.baseUrl,
        defaultApiKey: llm.apiKey,
        defaultModel: llm.model,
        // ArcGIS 兼容引擎：MapView（平面 2D）+ shim 需要构造的 esri 类。
        mapEngine: {
          kind: 'arcgis',
          viewKind: 'map',
          // shim 用这些类把 GeoJSON 转成 FeatureLayer / Graphic，
          // 并构造面、线、点、文字、图片等各类 Symbol。
          namespace: {
            WebTileLayer,
            FeatureLayer,
            Graphic,
            SimpleFillSymbol,
            SimpleLineSymbol,
            SimpleMarkerSymbol,
            TextSymbol,
            PictureMarkerSymbol,
          },
        },
      }),
  );
  const [mapEl, setMapEl] = useState<HTMLElementTagNameMap['arcgis-map'] | null>(null);

  // 等待 <arcgis-map> 完成 web component 升级（其内部 MapView 就绪）。
  useEffect(() => {
    const el = mapElement.current;
    if (!el) return;
    // 卸载标记：防止组件卸载后仍执行 setState。
    let disposed = false;
    // 组件的 MapView 要等 web component 加载完成后才存在。注意：这些
    // web component 没有 when() 方法——元素上继承的是原生
    // EventTarget.prototype.when(type)，需要传事件名。
    void waitForArcGISComponent(el).then(() => {
      if (disposed) {
        return;
      }
      // 视图就绪，更新 state 以渲染 GeoAgentPanel。
      setMapEl(el);
    });
    return () => {
      disposed = true;
    };
  }, []);

  // 面板挂载完成后，通过 agent 自身的工具机制预置示例数据
  // （子组件 effect 先于父组件 effect 执行，因此此处工具已就绪）。
  useEffect(() => {
    if (!mapEl) return;
    const tools = core.getTools();
    if (!tools) return;
    // 以 add_geojson_data 工具注入 GeoJSON 图层；样式键沿用
    // MapLibre 的 paint 属性命名（circle-color / line-color），由 shim 转换。
    void tools.runCommand('add_geojson_data', {
      name: 'sf-demo',
      data: DEMO_GEOJSON,
      style: { 'circle-color': '#f08c00', 'line-color': '#e8590c' },
    });
  }, [mapEl, core]);

  return (
    <div className="flex w-full">
      <div className="flex shrink-0 flex-col overflow-hidden border-r bg-muted">
        {/* web component 的视图就绪后才渲染面板；core 已在 useState 中创建。 */}
        {mapEl && (
          <GeoAgentPanel
            core={core}
            map={mapEl}
            title="GeoAgent（ArcGIS MapView）"
            locale={locale}
            collapsed={false}
            showCollapseButton={false}
          />
        )}
      </div>
      {/* ArcGIS 2D 地图：topo 地形底图，初始中心 (10, 12)、zoom 2（全球视野）。 */}
      <arcgis-map
        ref={mapElement}
        basemap="topo"
        center="10, 12"
        zoom="2"
        className="relative min-w-0 flex-1"
      >
        {/* 缩放与 Home（回到初始范围）按钮放在视图 UI 的指定 slot 位置。 */}
        <arcgis-zoom slot="top-right" />
        {/* Home 与缩放按钮之间留出间距（slot 内控件默认贴在一起）。 */}
        <arcgis-home slot="top-right" className="mt-2" />
      </arcgis-map>
    </div>
  );
}

// 将示例挂载到 #root；外层 ExampleShell 提供页面标题与说明栏。
createRoot(document.getElementById('root')!).render(
  <ExampleShell title={HOMEPAGE_I18N[locale].arcgisMapTitle}>
    <ArcGISMapExample />
  </ExampleShell>,
);
