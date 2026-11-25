/**
 * ArcGIS SceneView 3D 示例：演示通过 <arcgis-scene> web component +
 * arcgis-engine 兼容 shim（viewKind: "scene"）接入 GeoAgentPanel。
 *
 * 与其它示例的差异：
 * - shim 按 SceneView 相机模型驱动视图：zoom 走 scale、bearing 走
 *   camera.heading、pitch 走 tilt（arcgis-map 示例用的是平面 2D MapView）；
 * - 全球 3D 视图保留卫星影像和世界高程，并叠加 OpenFreeMap 的 MVT 道路与建筑。
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
// @arcgis/map-components 的 web components + GeoAgent shim 需要构造的 esri 类。
// 库本身从不 import @arcgis/*——由宿主一次性组装好 namespace。
import { defineCustomElements } from '@arcgis/map-components/dist/loader';
import '@arcgis/map-components/components/arcgis-navigation-toggle';
import '@arcgis/map-components/components/arcgis-compass';
import WebTileLayer from '@arcgis/core/layers/WebTileLayer.js';
import VectorTileLayer from '@arcgis/core/layers/VectorTileLayer.js';
import FeatureLayer from '@arcgis/core/layers/FeatureLayer.js';
import Graphic from '@arcgis/core/Graphic.js';
import SimpleFillSymbol from '@arcgis/core/symbols/SimpleFillSymbol.js';
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol.js';
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol.js';
import TextSymbol from '@arcgis/core/symbols/TextSymbol.js';
import * as reactiveUtils from '@arcgis/core/core/reactiveUtils.js';
import PictureMarkerSymbol from '@arcgis/core/symbols/PictureMarkerSymbol.js';
import { addMvtBuildings } from './mvt-buildings';
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
const mvtUrl = 'https://tiles.openfreemap.org/planet/20261122_124456_pt/{z}/{x}/{y}.pbf';
// 从瓦片 14/8299/5634 的南侧斜看巴黎，便于观察建筑侧面。
const initialCamera = { longitude: 2.36206, latitude: 48.8808, z: 620 };
const initialTilt = 58;
applyExamplePageLocale(locale, {
  en: 'web-geoagent - ArcGIS Scene Example',
  zh: 'web-geoagent - ArcGIS Scene 示例',
  tw: 'web-geoagent - ArcGIS Scene 範例',
});

/**
 * 页面主组件：渲染 <arcgis-scene> web component，并通过 GeoAgentCore +
 * GeoAgentPanel 接入 agent；视图就绪后显式设置初始相机。
 * @returns 左侧 GeoAgent 面板 + 右侧 3D 场景容器的页面布局。
 */
function ArcGISSceneExample() {
  const sceneElement = useRef<HTMLElementTagNameMap['arcgis-scene']>(null);
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
        // viewKind "scene"：shim 按 SceneView 相机模型驱动
        // （zoom 走 scale，bearing 走 camera.heading，pitch 走 tilt）。
        mapEngine: {
          kind: 'arcgis',
          viewKind: 'scene',
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
            // 4.32 起 view.watch 弃用，提供 reactiveUtils 走新监听通道。
            reactiveUtils,
          },
        },
      }),
  );
  const [mapEl, setMapEl] = useState<HTMLElementTagNameMap['arcgis-scene'] | null>(null);

  // 等待 <arcgis-scene> 完成 web component 升级（其内部 SceneView 就绪）。
  useEffect(() => {
    const el = sceneElement.current;
    if (!el) return;
    // 卸载标记：防止组件卸载后仍执行 setState。
    let disposed = false;
    let removeBuildings: (() => void) | undefined;
    const mvtLayer = new VectorTileLayer({
      id: 'openfreemap-mvt',
      title: 'OpenFreeMap MVT',
      copyright: 'OpenFreeMap © OpenMapTiles · © OpenStreetMap contributors',
      style: {
        version: 8,
        sources: {
          openfreemap: { type: 'vector', tiles: [mvtUrl], minzoom: 0, maxzoom: 14 },
        },
        layers: [
          {
            id: 'roads',
            type: 'line',
            source: 'openfreemap',
            'source-layer': 'transportation',
            minzoom: 10,
            paint: { 'line-color': '#ffe9aa', 'line-width': 1.5 },
          },
        ],
      },
    });
    // 组件的 SceneView 要等 web component 加载完成后才存在。注意：这些
    // web component 没有 when() 方法——元素上继承的是原生
    // EventTarget.prototype.when(type)，需要传事件名。
    void waitForArcGISComponent(el).then(() => {
      if (disposed) {
        return;
      }
      const view = el.view;
      view.map?.add(mvtLayer);
      view.camera = {
        position: initialCamera,
        heading: 0,
        tilt: initialTilt,
      };
      removeBuildings = addMvtBuildings(view, mvtUrl);
      // 视图就绪，更新 state 以渲染 GeoAgentPanel。
      setMapEl(el);
    });
    return () => {
      disposed = true;
      removeBuildings?.();
      mvtLayer.destroy();
    };
  }, []);

  return (
    <div className="flex w-full">
      <div className="flex shrink-0 flex-col overflow-hidden border-r bg-muted">
        {/* web component 的视图就绪后才渲染面板；core 已在 useState 中创建。 */}
        {mapEl && (
          <GeoAgentPanel
            core={core}
            map={mapEl}
            title="GeoAgent（ArcGIS SceneView）"
            locale={locale}
            collapsed={false}
            showCollapseButton={false}
          />
        )}
      </div>
      {/* 全球 3D 场景，初始视角和 Home 均定位到示例瓦片。 */}
      <div className="relative min-w-0 flex-1">
        <arcgis-scene
          ref={sceneElement}
          basemap="satellite"
          ground="world-elevation"
          camera-position={`${initialCamera.longitude}, ${initialCamera.latitude}, ${initialCamera.z}`}
          camera-heading="0"
          camera-tilt={String(initialTilt)}
          className="h-full w-full"
        >
          {/* 缩放按钮放在视图 UI 的指定 slot 位置；在 scene 中
              它们按相机远近步进拉近 / 拉远。 */}
          <arcgis-zoom slot="top-right" />
          {/* Home 回到初始相机位置（与缩放按钮留 8px 间距）。 */}
          <arcgis-home slot="top-right" style={{ marginTop: 8 }} />
          <arcgis-navigation-toggle slot="top-right" style={{ marginTop: 8 }} />
          <arcgis-compass slot="top-right" style={{ marginTop: 8 }} />
        </arcgis-scene>
        <div className="absolute bottom-6 right-2 bg-background/90 px-2 py-1 text-xs">
          <a href="https://openfreemap.org/">OpenFreeMap</a>
          {' © '}
          <a href="https://www.openmaptiles.org/">OpenMapTiles</a>
          {' · © '}
          <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>
        </div>
      </div>
    </div>
  );
}

// 将示例挂载到 #root；外层 ExampleShell 提供页面标题与说明栏。
createRoot(document.getElementById('root')!).render(
  <ExampleShell title={HOMEPAGE_I18N[locale].arcgisSceneTitle}>
    <ArcGISSceneExample />
  </ExampleShell>,
);
