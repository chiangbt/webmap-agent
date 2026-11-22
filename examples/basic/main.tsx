/**
 * MapLibre GL 基础示例：演示在原生 maplibregl.Map 上直接接入 GeoAgentPanel，
 * 是所有示例中最精简的一条接入路径。
 *
 * 与其它示例的差异：
 * - MapLibre GL 是本库的原生引擎，无需创建 GeoAgentCore，也无需传 mapEngine
 *   兼容 shim，直接把 Map 实例作为 map prop 传给 GeoAgentPanel 即可；
 *   （leaflet / openlayers / arcgis 示例都必须走 mapEngine 兼容层）
 * - 额外演示了 globe（球体）投影、MaplibreStarfieldLayer 星空背景与
 *   LayerControl 图层控制的组合效果；
 * - react 示例与其结构几乎相同，仅页面标题与组件名不同。
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import maplibregl, { type Map } from 'maplibre-gl';
import { LayerControl } from 'maplibre-gl-layer-control';
import { MaplibreStarfieldLayer } from '@geoql/maplibre-gl-starfield';
import { GeoAgentPanel } from '@/react';
import { ExampleShell } from '@/demo/example-shell';
import { applyExamplePageLocale, resolveExamplesLocale } from '@/demo/locale';
import { HOMEPAGE_I18N } from '@/demo/i18n';
import { readLlmEnvConfig } from '@/demo/env';
import '@/demo/demo.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import 'maplibre-gl-layer-control/style.css';
// ESO/S. Brunier 银河全景图（CC BY 4.0 授权），等距圆柱（equirectangular）投影，4096x2048。
import milkywayUrl from '../assets/milkyway.jpg';

// 跟随示例首页选择的语言（存储在 localStorage）。
const locale = resolveExamplesLocale();
// 从 .env 读取的部署默认值（LLM_API_URL / LLM_API_KEY / LLM_API_MODEL）。
const llm = readLlmEnvConfig();
applyExamplePageLocale(locale, {
  en: 'web-geoagent - MapLibre GL Example',
  zh: 'web-geoagent - MapLibre GL 示例',
  tw: 'web-geoagent - MapLibre GL 範例',
});

/**
 * 页面主组件：创建 MapLibre GL 地图，地图加载完成后渲染左侧 GeoAgentPanel。
 * @returns 左侧 GeoAgent 面板 + 右侧地图容器的页面布局。
 */
function BasicExample() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<Map | null>(null);

  // 空依赖数组：仅在组件首次挂载后执行一次地图初始化。
  useEffect(() => {
    // 容器尚未挂载时跳过初始化。
    if (!mapContainer.current) return;

    // 创建地图实例：使用 OpenFreeMap 的 Liberty 样式作为底图。
    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      // 初始视角带倾斜/旋转，使星空天球的银河带在加载后即可环绕地球可见。
      // 全球初始范围：加载时整个世界都在视野内。
      center: [10, 12],
      zoom: 1.6,
      bearing: 0, // 指北，与 Earth Engine 示例保持一致
      maxPitch: 85,
      // preserveDrawingBuffer 保留绘图缓冲区，agent 的地图截图工具才能从 canvas 读帧。
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });

    // 右上角依次添加导航（缩放/罗盘）、全屏与 globe 投影切换控件。
    mapInstance.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapInstance.addControl(new maplibregl.FullscreenControl(), 'top-right');
    mapInstance.addControl(new maplibregl.GlobeControl(), 'top-right');

    // 地图样式加载完成后，再添加依赖样式结构的图层与控件。
    mapInstance.on('load', () => {
      // 全球初始范围下使用球体（globe）投影：加载时整个地球都在视野内。
      // GlobeControl / agent 的 set_projection 工具可按需切换为平面 Mercator 投影。
      mapInstance.setProjection({ type: 'globe' });

      // 星空背景：Three.js 天球盒（skybox）上的银河全景图 + 数千个点状星星，
      // 插入到最底层，使地球渲染在其前方。
      mapInstance.addLayer(
        new MaplibreStarfieldLayer({
          galaxyTextureUrl: milkywayUrl,
          // ESO 全景图是真实的暗夜空照片；插件默认亮度 0.35 几乎全黑，
          // 调到 1.5 才能让银河带显现。
          galaxyBrightness: 1.5,
          starCount: 4000,
          starSize: 2.0,
        }),
        // 第二个参数为 beforeId：插到当前首个图层之前，即所有图层的最下方。
        mapInstance.getStyle().layers[0]?.id,
      );

      // 图层控制面板：默认折叠，可切换底图样式，面板宽度在 240–420px 间可拖拽。
      mapInstance.addControl(
        new LayerControl({
          collapsed: true,
          basemapStyleUrl: 'https://tiles.openfreemap.org/styles/liberty',
          panelWidth: 320,
          panelMinWidth: 240,
          panelMaxWidth: 420,
        }),
        'top-right',
      );
      // 地图完全就绪后更新 state，触发左侧 GeoAgentPanel 渲染。
      setMap(mapInstance);
    });

    // 组件卸载时销毁地图实例，释放 WebGL 等资源。
    return () => {
      mapInstance.remove();
    };
  }, []);

  return (
    <div className="flex w-full">
      <div className="flex shrink-0 flex-col overflow-hidden border-r bg-muted">
        {/* 地图实例就绪后才渲染面板，保证 map prop 不为 null。 */}
        {map && (
          <GeoAgentPanel
            map={map}
            title="GeoAgent（MapLibre GL）"
            locale={locale}
            collapsed={false}
            showCollapseButton={false}
          defaultBaseUrl={llm.baseUrl}
          defaultApiKey={llm.apiKey}
          defaultModel={llm.model}
          />
        )}
      </div>
      {/* 地图挂载容器。 */}
      <div ref={mapContainer} className="relative min-w-0 flex-1" />
    </div>
  );
}

// 将示例挂载到 #root；外层 ExampleShell 提供页面标题与说明栏。
createRoot(document.getElementById('root')!).render(
  <ExampleShell title={HOMEPAGE_I18N[locale].basicTitle}>
    <BasicExample />
  </ExampleShell>,
);
