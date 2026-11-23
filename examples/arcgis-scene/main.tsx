/**
 * ArcGIS SceneView 3D 示例：演示通过 <arcgis-scene> web component +
 * arcgis-engine 兼容 shim（viewKind: "scene"）接入 GeoAgentPanel。
 *
 * 与其它示例的差异：
 * - shim 按 SceneView 相机模型驱动视图：zoom 走 scale、bearing 走
 *   camera.heading、pitch 走 tilt（arcgis-map 示例用的是平面 2D MapView）；
 * - 场景为卫星影像（basemap: "satellite"）叠加真实世界高程
 *   （ground: "world-elevation"）的全球 3D 视图；
 * - 不预置示例数据（与 arcgis-map 示例不同），直接从空场景开始对话。
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
    // 组件的 SceneView 要等 web component 加载完成后才存在。注意：这些
    // web component 没有 when() 方法——元素上继承的是原生
    // EventTarget.prototype.when(type)，需要传事件名。
    void waitForArcGISComponent(el).then((view) => {
      if (disposed) {
        return;
      }
      // 全球初始范围：加载时整个地球都在视野内（下方 JSX 属性已声明该
      // 意图；显式赋值 camera 可保证跨 SDK 版本的起始视角一致）。
      view.camera = {
        // 相机位于 (10, 12) 上空约 2 万千米处，heading 与 tilt 均为 0，
        // 即垂直俯视地球的全球视角。
        position: { longitude: 10, latitude: 12, z: 20000000 },
        heading: 0,
        tilt: 0,
      };
      // 视图就绪，更新 state 以渲染 GeoAgentPanel。
      setMapEl(el);
    });
    return () => {
      disposed = true;
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
      {/* 全球 3D 场景：卫星影像叠加真实世界高程。agent 的相机类工具
          （fly_to、zoom_to_bounds、标记、截图）全部经由 shim 驱动这个
          SceneView；初始相机 (10, 12) 上空 2 万千米，heading / tilt 均为 0。 */}
      <arcgis-scene
        ref={sceneElement}
        basemap="satellite"
        ground="world-elevation"
        camera-position="10, 12, 20000000"
        camera-heading="0"
        camera-tilt="0"
        className="relative min-w-0 flex-1"
      >
        {/* 缩放按钮放在视图 UI 的指定 slot 位置；在 scene 中
            它们按相机远近步进拉近 / 拉远。 */}
        <arcgis-zoom slot="top-right" />
        {/* Home 回到初始相机位置；图层面板查看/切换图层
            （内联 marginTop 与上方控件留出 8px 间距）。 */}
        <arcgis-home slot="top-right" style={{ marginTop: 8 }} />
        <arcgis-layer-list slot="top-right" collapsed={true} style={{ marginTop: 8 }} />
      </arcgis-scene>
    </div>
  );
}

// 将示例挂载到 #root；外层 ExampleShell 提供页面标题与说明栏。
createRoot(document.getElementById('root')!).render(
  <ExampleShell title={HOMEPAGE_I18N[locale].arcgisSceneTitle}>
    <ArcGISSceneExample />
  </ExampleShell>,
);
