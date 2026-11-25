/**
 * Leaflet 接入示例：演示通过 mapEngine 兼容层（leaflet-engine shim）
 * 在原生 Leaflet 地图上使用 GeoAgentPanel。
 *
 * 与其它示例的差异：
 * - 地图是纯 Leaflet（L.map），不涉及 MapLibre GL，也没有 globe 投影、
 *   星空背景等 MapLibre 专属特性；
 * - agent 工具调用全部经由 leaflet 兼容 shim 转译执行，必须在
 *   mapEngine prop 中声明 kind: "leaflet" 并显式传入 L 命名空间；
 * - basic / react / earth-engine 示例（MapLibre 原生引擎）则不需要这一步。
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import L, { type Map as LeafletMap } from 'leaflet';
import { GeoAgentPanel } from '@/react';
import { ExampleShell } from '@/demo/example-shell';
import { applyExamplePageLocale, resolveExamplesLocale } from '@/demo/locale';
import { HOMEPAGE_I18N } from '@/demo/i18n';
import { readDemoPlaceSearchConfig, readLlmEnvConfig } from '@/demo/env';
import '@/demo/demo.css';
import 'leaflet/dist/leaflet.css';

// 跟随示例首页选择的语言（存储在 localStorage）。
const locale = resolveExamplesLocale();
// 从 .env 读取的部署默认值（LLM_API_URL / LLM_API_KEY / LLM_API_MODEL）。
const llm = readLlmEnvConfig();
applyExamplePageLocale(locale, {
  en: 'web-geoagent - Leaflet Example',
  zh: 'web-geoagent - Leaflet 示例',
  tw: 'web-geoagent - Leaflet 範例',
});

/**
 * 页面主组件：创建 Leaflet 地图，并通过 mapEngine 配置把 L 命名空间
 * 交给 GeoAgentPanel 的 leaflet 兼容层。
 * @returns 左侧 GeoAgent 面板 + 右侧地图容器的页面布局。
 */
function LeafletExample() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<LeafletMap | null>(null);

  // 空依赖数组：仅在组件首次挂载后执行一次地图初始化。
  useEffect(() => {
    // 容器尚未挂载时跳过初始化。
    if (!mapContainer.current) return;

    // 纯 Leaflet 地图——完全没有 MapLibre。GeoAgent 工具调用
    // 经由 leaflet-engine 兼容 shim 执行（mapEngine: { kind: "leaflet" }）。
    const mapInstance = L.map(mapContainer.current, {
      // 全球初始范围：加载时整个世界都在视野内。
      center: [12, 10],
      zoom: 2,
    });

    // OSM 标准瓦片作为底图，最大缩放 19 级并标注 OpenStreetMap 版权信息。
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(mapInstance);

    // 地图创建完成后立即更新 state，触发 GeoAgentPanel 渲染。
    setMap(mapInstance);

    // 组件卸载时销毁地图实例。
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
            title="GeoAgent（Leaflet）"
            locale={locale}
            collapsed={false}
            showCollapseButton={false}
          defaultBaseUrl={llm.baseUrl}
          defaultApiKey={llm.apiKey}
          defaultModel={llm.model}
          placeSearch={readDemoPlaceSearchConfig()}
            // 告知工具层这是 Leaflet 地图，并把 L 命名空间交给它们，
            // shim 据此调用 L.marker / L.divIcon 等 Leaflet API。
            mapEngine={{
              kind: 'leaflet',
              // L 的强类型与 shim 期望的通用命名空间结构不一致，
              // 这里统一断言成 Record<string, unknown>。
              namespace: L as unknown as Record<string, unknown>,
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
  <ExampleShell title={HOMEPAGE_I18N[locale].leafletTitle}>
    <LeafletExample />
  </ExampleShell>,
);
