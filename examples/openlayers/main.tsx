/**
 * OpenLayers 接入示例：演示通过 mapEngine 兼容层（openlayers-engine shim）
 * 在原生 OpenLayers 地图上使用 GeoAgentPanel。
 *
 * 与其它示例的差异：
 * - 地图是纯 OpenLayers（ol/Map），坐标系默认为 EPSG:3857（Web Mercator），
 *   agent 工具中的经纬度坐标由 shim 经 fromLonLat / toLonLat 转换；
 * - shim 需要一份手工组装的 ol 类与工具函数命名空间（openLayersNamespace），
 *   而不是整包 ol 对象，且每个键都是必需项；
 * - basic / react 示例（MapLibre 原生引擎）则不需要 mapEngine 配置。
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Map from 'ol/Map';
import View from 'ol/View';
import Feature from 'ol/Feature';
import Overlay from 'ol/Overlay';
import Point from 'ol/geom/Point';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import XYZ from 'ol/source/XYZ';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from 'ol/style';
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj';
import { GeoAgentPanel } from '@/react';
import { ExampleShell } from '@/demo/example-shell';
import { applyExamplePageLocale, resolveExamplesLocale } from '@/demo/locale';
import { HOMEPAGE_I18N } from '@/demo/i18n';
import { readLlmEnvConfig } from '@/demo/env';
import '@/demo/demo.css';
import 'ol/ol.css';

// 跟随示例首页选择的语言（存储在 localStorage）。
const locale = resolveExamplesLocale();
// 从 .env 读取的部署默认值（LLM_API_URL / LLM_API_KEY / LLM_API_MODEL）。
const llm = readLlmEnvConfig();
applyExamplePageLocale(locale, {
  en: 'web-geoagent - OpenLayers Example',
  zh: 'web-geoagent - OpenLayers 示例',
  tw: 'web-geoagent - OpenLayers 範例',
});

/**
 * openlayers-engine shim 所需的 ol 类与工具函数命名空间，一次性手工组装。
 * 每个键都是必需项：缺失任何一项都会得到明确的报错，而不是令人困惑的崩溃。
 * 覆盖 marker（Overlay/Point）、GeoJSON 图层（VectorLayer/VectorSource/GeoJSON）、
 * 样式（Style/Fill/Stroke/CircleStyle/Text）与坐标换算（fromLonLat 等）。
 */
const openLayersNamespace = {
  Feature,
  Point,
  Overlay,
  VectorLayer,
  TileLayer,
  VectorSource,
  XYZ,
  GeoJSON,
  Style,
  Fill,
  Stroke,
  CircleStyle,
  Text,
  fromLonLat,
  toLonLat,
  transformExtent,
};

/**
 * 页面主组件：创建 OpenLayers 地图，并把 ol 命名空间交给
 * GeoAgentPanel 的 openlayers 兼容层。
 * @returns 左侧 GeoAgent 面板 + 右侧地图容器的页面布局。
 */
function OpenLayersExample() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<Map | null>(null);

  // 空依赖数组：仅在组件首次挂载后执行一次地图初始化。
  useEffect(() => {
    // 容器尚未挂载时跳过初始化。
    if (!mapContainer.current) return;

    // 纯 OpenLayers 地图——完全没有 MapLibre。GeoAgent 工具调用
    // 经由 openlayers-engine 兼容 shim 执行（mapEngine: { kind: "openlayers" }）。
    const mapInstance = new Map({
      target: mapContainer.current,
      layers: [
        // XYZ 瓦片源加载 OSM 标准瓦片作为底图，并标注版权信息。
        new TileLayer({
          source: new XYZ({
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            attributions: [
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            ],
          }),
        }),
      ],
      view: new View({
        // 全球初始范围：加载时整个世界都在视野内。
        // 经纬度 [10, 12] 转成 OpenLayers 默认的 EPSG:3857 投影坐标。
        center: fromLonLat([10, 12]),
        zoom: 2,
      }),
    });
    // 地图创建完成后立即更新 state，触发 GeoAgentPanel 渲染。
    setMap(mapInstance);

    // 组件卸载时解除地图与 DOM 的绑定（OpenLayers 没有 remove()，
    // 用 setTarget(null) 释放 target）。
    return () => {
      mapInstance.setTarget(null);
    };
  }, []);

  return (
    <div className="flex w-full">
      <div className="flex shrink-0 flex-col overflow-hidden border-r bg-muted">
        {/* 地图实例就绪后才渲染面板，保证 map prop 不为 null。 */}
        {map && (
          <GeoAgentPanel
            map={map}
            title="GeoAgent（OpenLayers）"
            locale={locale}
            collapsed={false}
            showCollapseButton={false}
          defaultBaseUrl={llm.baseUrl}
          defaultApiKey={llm.apiKey}
          defaultModel={llm.model}
            // 告知工具层这是 OpenLayers 地图，并把上面组装的
            // 命名空间交给它们，shim 据此构造图层 / Overlay / 样式。
            mapEngine={{
              kind: 'openlayers',
              // ol 的强类型与 shim 期望的通用命名空间结构不一致，
              // 这里统一断言成 Record<string, unknown>。
              namespace: openLayersNamespace as unknown as Record<string, unknown>,
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
  <ExampleShell title={HOMEPAGE_I18N[locale].openlayersTitle}>
    <OpenLayersExample />
  </ExampleShell>,
);
