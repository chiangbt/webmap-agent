# maplibre-gl-geoagent

**[English](README.md) | [简体中文](README.zh-CN.md)**

面向 MapLibre GL JS 的纯浏览器 GeoAgent 控件。该控件实现 MapLibre 的
`IControl` 接口，内嵌一个 Strands TypeScript agent，可以通过专用的浏览器
工具查看并操作当前地图。

[![npm version](https://img.shields.io/npm/v/maplibre-gl-geoagent.svg)](https://www.npmjs.com/package/maplibre-gl-geoagent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Open in CodeSandbox](https://img.shields.io/badge/Open%20in-CodeSandbox-blue?logo=codesandbox)](https://codesandbox.io/p/github/opengeos/maplibre-gl-geoagent)
[![Open in StackBlitz](https://img.shields.io/badge/Open%20in-StackBlitz-blue?logo=stackblitz)](https://stackblitz.com/github/opengeos/maplibre-gl-geoagent)

## 功能特性

- 可折叠的 MapLibre 控件，带浮动聊天面板
- 浏览器端 provider 界面，支持 OpenAI Responses、OpenAI Chat、Anthropic、Google Gemini、Amazon Bedrock 以及任意 OpenAI 兼容/自定义端点
- API key 在提交时（回车或失焦）才保存，并有行内确认提示；provider 报错在发送 prompt 时展示
- provider、key 与模型设置集中在一个可折叠区块中，配置完成后自动收起；内置 provider 默认使用其最新配置模型，模型仍可手动修改
- 地图工具覆盖相机移动、投影、底图、标记点、GeoJSON、XYZ 瓦片、图层可见性、透明度、要素查询、截图与图层清理
- 可选的 Google Earth Engine 工具：目录检索、OAuth 初始化、数据集瓦片图层、归一化差异指数、可视化更新、代码片段与区域统计
- 可选的 MapLibre JavaScript 执行工具，默认关闭
- 破坏性图层删除工具由独立开关控制
- 可将可见的对话日志复制为 Markdown
- 提供 React 包装组件与状态 hook

## 安装

```bash
npm install maplibre-gl-geoagent maplibre-gl
```

## 原生 JS/TS 用法

```typescript
import maplibregl from "maplibre-gl";
import { GeoAgentControl } from "maplibre-gl-geoagent";
import "maplibre-gl/dist/maplibre-gl.css";
import "maplibre-gl-geoagent/style.css";

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/liberty",
  center: [-98.5795, 39.8283],
  zoom: 3,
  maxPitch: 85,
  canvasContextAttributes: { preserveDrawingBuffer: true },
});

map.on("load", () => {
  map.addControl(
    new GeoAgentControl({
      title: "GeoAgent",
      collapsed: false,
    }),
    "top-left",
  );
});
```

## React 用法

```tsx
import { useEffect, useRef, useState } from "react";
import maplibregl, { type Map } from "maplibre-gl";
import {
  GeoAgentControlReact,
  useGeoAgentState,
} from "maplibre-gl-geoagent/react";
import "maplibre-gl/dist/maplibre-gl.css";
import "maplibre-gl-geoagent/style.css";

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<Map | null>(null);
  const { state, setState } = useGeoAgentState({ collapsed: false });

  useEffect(() => {
    if (!mapContainer.current) return;

    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [-98.5795, 39.8283],
      zoom: 3,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });

    mapInstance.on("load", () => setMap(mapInstance));
    return () => mapInstance.remove();
  }, []);

  return (
    <>
      <div ref={mapContainer} style={{ width: "100vw", height: "100vh" }} />
      {map && (
        <GeoAgentControlReact
          map={map}
          title="GeoAgent"
          collapsed={state.collapsed}
          position="top-left"
          onStateChange={setState}
        />
      )}
    </>
  );
}
```

## 模型提供商

支持的 provider：

- OpenAI Responses
- OpenAI Chat
- Anthropic
- Google Gemini
- Amazon Bedrock
- OpenAI-Compatible（自定义）

使用 Bedrock 时，选择 `Amazon Bedrock`，输入 Bedrock API key，选择 Bedrock
Converse 模型 ID 并设置 AWS 区域。默认 Bedrock 模型为
`anthropic.claude-opus-4-8`，默认区域为 `us-west-2`。

使用自定义或自托管模型时，选择 `OpenAI-Compatible (Custom)`，输入
OpenAI 兼容端点的 API base URL（例如本地 LLM 服务或私有化部署），提供 API
key 并填写模型 ID。该端点按 OpenAI Chat Completions API 的请求格式调用。

### 保存 key 与模型

API key 只在你提交时（按回车或焦点移出输入框）写入 `sessionStorage`，因此
输入一半的 key 不会把状态徽章变成 "Ready"，也不会被写入存储。

内置 provider 使用包内配置的最新模型：OpenAI Responses 与 OpenAI Chat 为
`gpt-5.5`，Anthropic 为 `claude-opus-4-8`，Google Gemini 为
`gemini-3.5-flash`，Amazon Bedrock 为 `anthropic.claude-opus-4-8`。
"Use latest" 按钮会把模型输入框重置为该配置默认值，不会调用 provider 的
模型列表接口。`OpenAI-Compatible (Custom)` 没有通用的最新模型，请填写该
端点暴露的模型 ID。

### 语言

将 `locale` 选项设为 `'zh-CN'` 即可以中文渲染面板的全部文案（标签、状态徽章、
按钮与运行时消息），默认 `'en'` 为英文。品牌名与技术术语在两种语言下保持一致。
示例首页提供中英文下拉框，选择保存在 `localStorage`（`geoagent.locale`），
各示例页会读取该选择并跟随显示，参见 `examples/shared/locale.ts`。

## 配置项

| 选项                           | 类型                                                           | 默认值              |
| ------------------------------ | -------------------------------------------------------------- | ------------------- |
| `collapsed`                    | `boolean`                                                      | `true`              |
| `position`                     | `'top-left' \| 'top-right' \| 'bottom-left' \| 'bottom-right'` | `'top-right'`       |
| `title`                        | `string`                                                       | `'GeoAgent'`        |
| `panelWidth`                   | `number`                                                       | `390`               |
| `panelMinWidth`                | `number`                                                       | `320`               |
| `panelMaxWidth`                | `number`                                                       | `720`               |
| `className`                    | `string`                                                       | `''`                |
| `locale`                       | `'en' \| 'zh-CN'`                                              | `'en'`              |
| `defaultProvider`              | `GeoAgentProviderId`                                           | `'openai-responses'`|
| `defaultModel`                 | `string \| Partial<Record<GeoAgentProviderId, string>>`        | provider 默认值     |
| `storagePrefix`                | `string`                                                       | `'geoagent.maplibre'`|
| `apiKeys`                      | `Partial<Record<GeoAgentProviderId, string>>`                  | `undefined`         |
| `allowCodeExecutionDefault`    | `boolean`                                                      | `true`              |
| `allowDestructiveToolsDefault` | `boolean`                                                      | `true`              |
| `showPermissionToggles`        | `boolean`                                                      | `false`             |
| `basemaps`                     | `Record<string, string \| StyleSpecification>`                 | 内置底图            |
| `earthEngine`                  | `EarthEngineOptions`                                           | `undefined`         |
| `mapEngine`                    | `GeoAgentMapEngine`                                            | maplibre-gl         |

### 在 Mapbox GL JS 上运行

几乎所有工具都停留在 `maplibre-gl` 与 `mapbox-gl` 共享的 Style Spec 表面上。
有四个工具做不到，一次性声明引擎正是为了让它们保持诚实：

- `add_marker` 构造引擎自己的 `Marker` 与 `Popup`（MapLibre 的版本会读取
  `map._camera.transform`，在 mapbox-gl 地图上会抛错），
- `set_projection` 在 MapLibre 写 `{ type: 'globe' }`、在 Mapbox 写 `'globe'`，
- `get_map_state` 读取 `{ type }` 或 `{ name }`，
- `run_maplibre_script` 把引擎自己的命名空间交给用户代码。

```javascript
import mapboxgl from 'mapbox-gl';

const agent = new GeoAgentControl({
  mapEngine: { kind: 'mapbox', namespace: mapboxgl },
});

map.addControl(agent);
```

`namespace` 必须是真实的库命名空间，不能是子集：`run_maplibre_script` 会把
整个对象交给它运行的脚本。省略 `mapEngine` 时工具使用本包自带的
`maplibre-gl`，行为与以前完全一致。

无论哪种引擎都有一个工具仍是 MapLibre 专属：`set_sky` / `clear_sky` 调用
`map.setSky`，而 mapbox-gl 没有该方法（它通过样式图层绘制天空）。工具会
明确报告这一点，而不是静默失败。

### 在 Leaflet 上运行

同样的工具也可以运行在纯 [Leaflet](https://leafletjs.com/) 地图上。Leaflet
没有 Style Spec，因此本包内置了一个兼容引擎（`leaflet-engine.ts`）：一个在
真实 `L.Map` 之上模拟 MapLibre map API 的 shim，把 Style Spec 的
source/layer 物化为 Leaflet 图层（每个 Style Spec 图层对应 GeoJSON/vector
图层，raster source 对应瓦片图层，用每层独立 pane 控制 z-order 与可见性，
用表达式求值器处理 `["get", ...]`/`["step", ...]`/`["match", ...]` 过滤器与
paint，用贪心像素网格聚类实现 `cluster: true` 的 source）。

```javascript
import L from 'leaflet';
import { GeoAgentControl, addGeoAgentToLeafletMap } from 'maplibre-gl-geoagent';
import 'maplibre-gl-geoagent/dist/maplibre-gl-geoagent.css';
import 'leaflet/dist/leaflet.css';

const map = L.map('map').setView([39.8283, -98.5795], 4);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const agent = new GeoAgentControl({
  mapEngine: { kind: 'leaflet', namespace: L },
});

// Leaflet 的 map.addControl 不接受外部控件，因此通过助手挂载——
// 它会挂到 Leaflet 的角落 DOM 上，并返回 { remove() } 用于卸载。
addGeoAgentToLeafletMap(agent, map, { position: 'topleft' });
```

设计上支持和不支持的能力：

- 相机（`set_center`、`fly_to`、`zoom_to_bounds`、`get_map_state`）、所有
  GeoJSON/raster/marker 覆盖物、图层可见性/透明度、要素查询
  （`query_rendered_features` 做像素级命中测试）、底图切换（具名 MapLibre
  样式会解析为 raster 瓦片 URL——矢量样式无法在 Leaflet 中渲染），以及
  `run_maplibre_script`（用户代码拿到真实的 `L.Map` 与 `L` 命名空间，因此
  其中的脚本就是 Leaflet 脚本）。
- `set_projection` 只接受 `'mercator'`（Leaflet 即 Web Mercator）；
  `add_terrain`、`set_sky`/`clear_sky`、`fill-extrusion`/`heatmap` 图层与
  `screenshot_map` 会报告不支持，而不是静默失败。
- Earth Engine 瓦片以普通 XYZ raster 覆盖物加载。

### 在 OpenLayers 上运行

同样的工具也可以运行在纯 [OpenLayers](https://openlayers.org/) 地图上。本包
内置第二个兼容引擎（`openlayers-engine.ts`）：一个在真实 `ol/Map` 之上模拟
MapLibre map API 的 shim，把 Style Spec 的 source/layer 物化为 OpenLayers
图层（每个 Style Spec 图层对应一个 `VectorLayer`，其 style function 求值
fill/line/circle/symbol 的 paint 与 `["get", ...]`/`["step", ...]`/
`["match", ...]` 过滤器；raster source 对应 `TileLayer` + `XYZ`；
`cluster: true` 的 source 用贪心像素网格聚类并在 `moveend` 时重算）。

库本身不 import `ol`，因此由宿主一次性组装一个 ol 类命名空间：

```javascript
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
import { GeoAgentControl, addGeoAgentToOpenLayersMap } from 'maplibre-gl-geoagent';
import 'maplibre-gl-geoagent/dist/maplibre-gl-geoagent.css';
import 'ol/ol.css';

const map = new Map({
  target: 'map',
  layers: [
    new TileLayer({
      source: new XYZ({ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' }),
    }),
  ],
  view: new View({ center: fromLonLat([-98.5795, 39.8283]), zoom: 4 }),
});

const agent = new GeoAgentControl({
  mapEngine: {
    kind: 'openlayers',
    namespace: {
      Feature, Point, Overlay, VectorLayer, TileLayer, VectorSource, XYZ,
      GeoJSON, Style, Fill, Stroke, CircleStyle, Text,
      fromLonLat, toLonLat, transformExtent,
    },
  },
});

// OpenLayers 的 map.addControl 不接受外部控件，因此通过助手挂载——
// 它会挂到地图 viewport 上，并返回 { remove() } 用于卸载。
addGeoAgentToOpenLayersMap(agent, map, { position: 'top-left' });
```

设计上支持和不支持的能力：

- 相机（`set_center`、`fly_to`、`zoom_to_bounds`、`get_map_state`；bearing
  映射为视图旋转，pitch 恒为 0）、所有 GeoJSON/raster/marker 覆盖物
  （marker 变为 `ol/Overlay` 图钉，点击弹出 popup）、图层可见性/透明度、
  要素查询（`query_rendered_features` 做像素级命中测试，首帧渲染前退化为
  纯 Web Mercator 数学计算）、底图切换（具名 MapLibre 样式解析为 raster
  瓦片 URL），以及 `run_maplibre_script`（用户代码拿到真实的 `ol/Map` 与你
  提供的命名空间，因此其中的脚本就是 OpenLayers 脚本）。
- `set_projection` 只接受 `'mercator'`；`add_terrain`、`set_sky`/`clear_sky`、
  `fill-extrusion`/`heatmap` 图层、矢量瓦片 source 与 `screenshot_map` 会
  报告不支持，而不是静默失败。
- Earth Engine 瓦片以普通 XYZ raster 覆盖物加载。

### Earth Engine 配置

```typescript
new GeoAgentControl({
  earthEngine: {
    oauthClientId: "YOUR_GOOGLE_OAUTH_CLIENT_ID",
    projectId: "your-earth-engine-project",
    includeCommunityCatalog: true,
  },
});
```

Earth Engine 集成通过官方 `@google/earthengine` 包走浏览器 OAuth。本纯浏览器
包有意不支持服务账号私钥；如果你的部署需要服务账号访问，请使用后端代理。

已经在浏览器外完成 Earth Engine 认证的宿主应用，可以提供短期 OAuth access
token 代替发起浏览器 OAuth：

```typescript
new GeoAgentControl({
  earthEngine: {
    accessToken: "SHORT_LIVED_EARTH_ENGINE_ACCESS_TOKEN",
    tokenType: "Bearer",
    tokenExpiresIn: 3600,
    projectId: "your-earth-engine-project",
    includeCommunityCatalog: true,
  },
});
```

Access token 会被传入浏览器 JavaScript 运行时，因此应当是短效的。不要把它
持久化在页面源码、notebook、localStorage 或 sessionStorage 中。面向不可信
用户或生产部署时，优先使用后端代理。

## 浏览器凭据

本包直接在浏览器中运行模型 SDK。面板中输入的 API key 保存在配置了
`storagePrefix` 的 `sessionStorage` 下，并由页面直接发送给所选模型
provider。适用于本地开发、可信内部应用，或有意暴露浏览器凭据通道的应用。

宿主应用可以用初始 API key 预填面板：

```typescript
new GeoAgentControl({
  apiKeys: {
    "openai-responses": "OPENAI_API_KEY_VALUE",
    "openai-chat": "OPENAI_API_KEY_VALUE",
    anthropic: "ANTHROPIC_API_KEY_VALUE",
    google: "GOOGLE_API_KEY_VALUE",
    bedrock: "AWS_BEARER_TOKEN_BEDROCK_VALUE",
  },
});
```

已保存的 `sessionStorage` 值优先于 `apiKeys`。初始 key 只保留在浏览器内存
中，除非用户编辑 API key 输入框，否则不会写入存储。

Amazon Bedrock 方面，本纯浏览器控件使用 Bedrock API-key bearer-token 认证。
不要在此 UI 中输入 AWS access key ID、secret access key 或 session token。
生产环境的 Bedrock 部署优先使用以 IAM 角色凭据调用 Bedrock 的后端代理。

MapLibre JavaScript 工具与图层删除工具默认启用。它们的复选框默认隐藏；初始化
时传 `showPermissionToggles: true` 可让用户在面板中自行开关。启动时禁用某项
能力请使用 `allowCodeExecutionDefault: false` 或
`allowDestructiveToolsDefault: false`。

## Prompt 示例

```text
为旧金山添加一个红色标记并缩放到它。
```

```text
把底图换成 dark，然后获取当前地图状态。
```

```text
把 GeoJSON 网址 https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json 作为美国县界添加进来。
```

```text
在 Google Earth Engine 中检索 SRTM 高程数据集，然后用地形色带添加 SRTM 影像。
```

```text
加载 Knoxville 2024 年 6 月的 Sentinel-2 地表反射率数据，并用 B8 与 B4 计算 NDVI。
```

```text
隐藏美国县界图层，然后再显示出来。
```

```text
当前地图中心处可见哪些要素？
```

## API

- `GeoAgentControl` 实现 MapLibre `IControl`
- `GeoAgentControlReact` 为 React 应用挂载/卸载控件
- `useGeoAgentState` 提供轻量 React 状态 helper
- 导出控件配置、状态、provider、事件与 React props 的类型

## 开发

```bash
npm install
cp .env.example .env
npm run dev
npm test
npm run build
npm run build:examples
```

Earth Engine 示例需要在 `.env` 中设置 `VITE_GEE_OAUTH_CLIENT_ID`。
`VITE_GEE_PROJECT_ID` 可选；省略时用户可以在 GeoAgent 面板中自行输入其
启用 Earth Engine 的 Google Cloud 项目 ID。
