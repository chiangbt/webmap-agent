/**
 * OpenLayers 缓冲区分析示例：演示经 `customTools` 选项为 GeoAgent 扩展
 * 领域专属工具的推荐姿势——
 *
 * 1. 页面用 OpenLayers 自己的 Draw 交互让用户画多边形，画好的要素以
 *    WGS84 GeoJSON 存在一个页面持有的 store 里；
 * 2. 通过 `customTools` 注册一个 `buffer_drawn_feature` 工具：用
 *    `@turf/buffer` 对最新绘制的要素做缓冲区分析，把结果要素渲染到
 *    页面自己的矢量图层并适配视野，向 agent 返回面积等指标；
 * 3. 通过 `customSystemPrompt` 教会 agent 何时以及如何调用这个工具。
 *
 * 缓冲结果的渲染走页面自己的 VectorSource，不占用 agent 管理的图层注册表；
 * agent 仍可使用全部内置工具（相机、底图、要素查询等）。
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import buffer from '@turf/buffer';
import area from '@turf/area';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import XYZ from 'ol/source/XYZ';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import Draw from 'ol/interaction/Draw';
import { Style, Fill, Stroke } from 'ol/style';
import { fromLonLat } from 'ol/proj';
import { GeoAgentPanel } from '@/react';
import { ExampleShell } from '@/demo/example-shell';
import { applyExamplePageLocale, resolveExamplesLocale } from '@/demo/locale';
import { HOMEPAGE_I18N } from '@/demo/i18n';
import { readDemoPlaceSearchConfig, readLlmEnvConfig } from '@/demo/env';
import '@/demo/demo.css';
import 'ol/ol.css';

// 跟随示例首页选择的语言（存储在 localStorage）。
const locale = resolveExamplesLocale();
// 从 .env 读取的部署默认值（LLM_API_URL / LLM_API_KEY / LLM_API_MODEL）。
const llm = readLlmEnvConfig();
applyExamplePageLocale(locale, {
  en: 'web-geoagent - OpenLayers Buffer Example',
  zh: 'web-geoagent - OpenLayers 缓冲区分析示例',
  tw: 'web-geoagent - OpenLayers 緩衝區分析範例',
});

// openlayers-engine shim 所需的 ol 类与工具函数命名空间：一次性手工组装，
// 每个键都是必需项，键集合与 openlayers 示例保持一致。
import Feature from 'ol/Feature';
import Overlay from 'ol/Overlay';
import Point from 'ol/geom/Point';
import { Circle as CircleStyle, Text } from 'ol/style';
import { toLonLat, transformExtent } from 'ol/proj';
function buildOpenLayersNamespace(): Record<string, unknown> {
  return {
    Feature, Point, Overlay, VectorLayer, TileLayer, VectorSource, XYZ, GeoJSON,
    Style, Fill, Stroke, CircleStyle, Text, fromLonLat, toLonLat, transformExtent,
  };
}

/** 页面持有的最新绘制要素（WGS84 GeoJSON）；工具闭包读取这份状态。 */
const drawnStore: { current: unknown; has: boolean } = { current: null, has: false };

/**
 * 构造 buffer_drawn_feature 工具：对最新绘制的多边形做缓冲区分析。
 * 结果要素直接渲染到页面的缓冲区图层并适配视野；返回值是给 agent 看的
 * 结构化指标（成功标志、半径、面积、几何类型）。
 */
function buildBufferTool(map: Map, bufferSource: VectorSource) {
  return tool({
    name: 'buffer_drawn_feature',
    description:
      'Buffer the polygon the user drew on the map by a radius in kilometers, render the result on the map, fit the view to it, and return its metrics. If nothing has been drawn yet, ask the user to draw a polygon first instead of guessing.',
    inputSchema: z.object({
      radiusKm: z.number().positive().max(500).describe('Buffer radius in kilometers.'),
    }),
    callback: (input: { radiusKm: number }) => {
      if (!drawnStore.has) {
        throw new Error(
          'No drawn feature yet. Ask the user to draw a polygon on the map first.',
        );
      }
      const buffered = buffer(drawnStore.current as never, input.radiusKm, {
        units: 'kilometers',
      }) as never as { geometry: { type: string }; type: 'Feature' };
      // WGS84 GeoJSON → 地图投影（EPSG:3857）的 ol 要素，渲染进缓冲区图层。
      const feature = new GeoJSON().readFeature(buffered as never, {
        featureProjection: 'EPSG:3857',
      }) as never as Feature;
      bufferSource.addFeature(feature);
      const extent = feature.getGeometry()?.getExtent();
      if (extent) {
        map.getView().fit(extent, { padding: [48, 48, 48, 48], maxZoom: 14 });
      }
      const areaKm2 = area(buffered as never) / 1e6;
      return {
        success: true,
        radiusKm: input.radiusKm,
        areaKm2: Number(areaKm2.toFixed(2)),
        geometryType: buffered.geometry.type,
      };
    },
  });
}

/** 工具使用指引：追加在内置 system prompt 之后。 */
const BUFFER_SYSTEM_PROMPT = [
  'Buffer analysis workflow:',
  '- This app registers a custom tool buffer_drawn_feature({ radiusKm }): it buffers the polygon the user drew on the map with @turf/buffer, renders the result, fits the view, and returns { success, radiusKm, areaKm2, geometryType }.',
  '- When the user asks for a buffer around the drawn shape, call the tool with the requested radius, then report the resulting area in km2.',
  '- If the tool reports that nothing has been drawn, tell the user to draw a polygon on the map first.',
  '- Do not attempt to approximate buffers with built-in map tools; use the custom tool.',
].join('\n');

/** 页面主组件：OpenLayers 地图 + 绘制交互 + 挂载 customTools 的 GeoAgent 面板。 */
function OpenLayersBufferExample() {
  const mapContainer = useRef<HTMLDivElement>(null);
  // 地图与缓冲区图层就绪后才渲染面板，保证 customTools 闭包拿到非空实例。
  const [ready, setReady] = useState<{ map: Map; bufferSource: VectorSource } | null>(
    null,
  );

  useEffect(() => {
    if (!mapContainer.current) return;
    const source = new VectorSource();
    const bufferLayer = new VectorLayer({
      source,
      style: new Style({
        fill: new Fill({ color: 'rgba(56, 189, 248, 0.25)' }),
        stroke: new Stroke({ color: '#0ea5e9', width: 2 }),
      }),
    });
    const drawSource = new VectorSource();
    const drawLayer = new VectorLayer({
      source: drawSource,
      style: new Style({
        fill: new Fill({ color: 'rgba(250, 204, 21, 0.2)' }),
        stroke: new Stroke({ color: '#facc15', width: 2 }),
      }),
    });
    const mapInstance = new Map({
      target: mapContainer.current,
      layers: [
        new TileLayer({
          source: new XYZ({
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            attributions: [
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            ],
          }),
        }),
        bufferLayer,
        drawLayer,
      ],
      view: new View({ center: fromLonLat([10, 12]), zoom: 2 }),
    });
    // 绘制交互：画好的要素转成 WGS84 GeoJSON 存入页面 store，供工具读取。
    const draw = new Draw({ source: drawSource, type: 'Polygon' });
    draw.on('drawend', (event) => {
      const geometry = event.feature.getGeometry()?.clone().transform('EPSG:3857', 'EPSG:4326');
      if (geometry) {
        // WGS84 GeoJSON 存入页面 store；工具闭包读取，agent 无法直接触碰。
        drawnStore.current = new GeoJSON().writeFeatureObject(new Feature({ geometry }));
        drawnStore.has = true;
      }
    });
    mapInstance.addInteraction(draw);
    setReady({ map: mapInstance, bufferSource: source });
    return () => {
      mapInstance.setTarget(null);
    };
  }, []);

  return (
    <div className="flex w-full flex-col">
      {/* 操作提示条：先画多边形，再让 agent 做缓冲区分析。 */}
      <div className="border-b bg-muted px-3 py-2 text-xs text-muted-foreground">
        {locale === 'en'
          ? 'Draw a polygon on the map, then ask the agent, e.g. "buffer it by 50 km".'
          : locale === 'zh-CN'
            ? '先在地图上绘制一个多边形，然后对 agent 说，例如“给它做一个 50 公里的缓冲区”。'
            : '先在地圖上繪製一個多邊形，然後對 agent 說，例如「給它做一個 50 公里的緩衝區」。'}
      </div>
      <div className="flex w-full">
        <div className="flex shrink-0 flex-col overflow-hidden border-r bg-muted">
          {ready && (
            <GeoAgentPanel
              map={ready.map}
              title="GeoAgent（Buffer）"
              locale={locale}
              collapsed={false}
              showCollapseButton={false}
              defaultBaseUrl={llm.baseUrl}
              defaultApiKey={llm.apiKey}
              defaultModel={llm.model}
              placeSearch={readDemoPlaceSearchConfig()}
              mapEngine={{
                kind: 'openlayers',
                namespace: buildOpenLayersNamespace(),
              }}
              // 领域工具经 customTools 注入：面板挂载后 agent 即可调用。
              customTools={() => [buildBufferTool(ready.map, ready.bufferSource)]}
              // 教会 agent 何时以及如何使用自定义工具。
              customSystemPrompt={BUFFER_SYSTEM_PROMPT}
            />
          )}
        </div>
        <div ref={mapContainer} className="relative min-w-0 flex-1" />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ExampleShell title={HOMEPAGE_I18N[locale].bufferTitle ?? 'OpenLayers Buffer'}>
    <OpenLayersBufferExample />
  </ExampleShell>,
);
