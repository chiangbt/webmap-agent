/**
 * Google Earth Engine 示例：演示在 MapLibre GL 地图上为 GeoAgentPanel
 * 启用 Earth Engine 数据源（OAuth 授权 + GEE 项目）。
 *
 * 与其它示例的差异：
 * - 地图部分与 basic 示例一致（原生 MapLibre GL 引擎，无需 mapEngine
 *   shim），但不加载星空背景；
 * - 通过 earthEngine prop 传入 OAuth client id 与 GEE project id，
 *   使 agent 能检索 Earth Engine 数据目录并调用其计算服务；
 * - project id 支持四级回退取值：URL 查询参数 → .env →
 *   sessionStorage → localStorage。
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import maplibregl, { type Map } from 'maplibre-gl';
import { LayerControl } from 'maplibre-gl-layer-control';
import { GeoAgentPanel } from '@/react';
import { ExampleShell } from '@/demo/example-shell';
import { applyExamplePageLocale, resolveExamplesLocale } from '@/demo/locale';
import { HOMEPAGE_I18N } from '@/demo/i18n';
import { readDemoPlaceSearchConfig, readLlmEnvConfig } from '@/demo/env';
import '@/demo/demo.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import 'maplibre-gl-layer-control/style.css';

// 跟随示例首页选择的语言（存储在 localStorage）。
const locale = resolveExamplesLocale();
// 从 .env 读取的部署默认值（LLM_API_URL / LLM_API_KEY / LLM_API_MODEL）。
const llm = readLlmEnvConfig();
applyExamplePageLocale(locale, {
  en: 'web-geoagent - Earth Engine Example',
  zh: 'web-geoagent - Earth Engine 示例',
  tw: 'web-geoagent - Earth Engine 範例',
});

/** Earth Engine 相关配置在 localStorage / sessionStorage 中的键前缀。 */
const STORAGE_PREFIX = 'web-geoagent.ee-example';

/**
 * 将未知类型的 env 值收敛为字符串。
 * @param value Vite 注入的 env 变量原始值。
 * @returns 字符串原样返回，其余类型返回空串。
 */
function envString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 解析 Earth Engine project id，按优先级依次尝试四个来源。
 * @param envValue Vite 注入的 VITE_GEE_PROJECT_ID 原始值。
 * @returns 第一个非空来源的 project id，全部为空时返回空串。
 */
function projectValue(envValue: unknown): string {
  const params = new URLSearchParams(window.location.search);
  return (
    // 1) URL 查询参数 ?ee_project_id=...（便于临时调试切换项目）。
    params.get('ee_project_id') ||
    // 2) .env 注入的部署默认值 VITE_GEE_PROJECT_ID。
    envString(envValue) ||
    // 3) 会话级缓存（面板保存过的 project id，本次浏览器会话内有效）。
    sessionStorage.getItem(`${STORAGE_PREFIX}.earthEngine.projectId`) ||
    // 4) 持久缓存（跨浏览器会话保留）。
    localStorage.getItem(`${STORAGE_PREFIX}.ee_project_id`) ||
    ''
  );
}

/**
 * 页面主组件：创建 MapLibre GL 地图，并在 GeoAgentPanel 上启用
 * Earth Engine 数据源（OAuth client id + project id）。
 * @returns 左侧 GeoAgent 面板 + 右侧地图容器的页面布局。
 */
function EarthEngineExample() {
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
      // 全球初始范围：加载时整个世界都在视野内。
      center: [10, 12],
      zoom: 1.6,
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
      // 切换为球体（globe）投影：加载时整个地球都在视野内。
      mapInstance.setProjection({ type: 'globe' });

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
            title="GeoAgent（Earth Engine）"
            locale={locale}
            collapsed={false}
            showCollapseButton={false}
          defaultBaseUrl={llm.baseUrl}
          defaultApiKey={llm.apiKey}
          defaultModel={llm.model}
          placeSearch={readDemoPlaceSearchConfig()}
            // 面板内 EE 配置的存储键前缀，与上方 projectValue 的回退链保持一致。
            storagePrefix={STORAGE_PREFIX}
            // 启用 Earth Engine 数据源：首次使用时面板会发起 Google OAuth 授权。
            earthEngine={{
              // OAuth client id 只从 .env 读取（VITE_GEE_OAUTH_CLIENT_ID）。
              oauthClientId: envString(import.meta.env.VITE_GEE_OAUTH_CLIENT_ID),
              // project id 经 projectValue 按四级回退链解析。
              projectId: projectValue(import.meta.env.VITE_GEE_PROJECT_ID),
              // 数据目录中包含社区（community）贡献的数据条目。
              includeCommunityCatalog: true,
            }}
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
  <ExampleShell title={HOMEPAGE_I18N[locale].earthEngineTitle}>
    <EarthEngineExample />
  </ExampleShell>,
);
