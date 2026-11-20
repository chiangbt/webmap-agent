# 示例

**[English](README.md) | [简体中文](README.zh-CN.md)**

本目录包含 `maplibre-gl-geoagent` 的示例实现。示例直接引入
`maplibre-gl-layer-control`，以免已发布的 GeoAgent 库依赖这个可选的 UI
控件。

所有示例均采用左右布局：GeoAgent 面板停靠在左侧侧栏中，侧栏宽度随面板
自适应，地图占据其余空间（`examples/shared/dock-panel.ts` +
`dock-panel.css`）。由于面板在侧栏中始终可见，浮动切换按钮已被移除。

## 基础示例

一个原生 TypeScript 示例，演示将 `GeoAgentControl` 添加到 MapLibre 地图。
它默认启用 MapLibre JavaScript 与图层删除能力，同时隐藏权限复选框。地图以
globe 投影启动，底图下方叠加 `@geoql/maplibre-gl-starfield` 星空穹顶（ESO
银河全景图，CC BY 4.0）。

```bash
npm run dev
```

打开 <http://localhost:5173/examples/basic/>。

## Earth Engine 示例

一个启用了 Google Earth Engine 工具的原生 TypeScript 示例。把
`.env.example` 复制为 `.env` 并设置 Vite 环境变量：

```bash
cp .env.example .env
```

```env
VITE_GEE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
# 可选的默认值。用户也可以在面板中输入自己的项目 ID。
VITE_GEE_PROJECT_ID=
```

然后运行：

```bash
npm run dev
```

打开 <http://localhost:5173/examples/earth-engine/>。

公开部署时，请在构建时配置 `VITE_GEE_OAUTH_CLIENT_ID`，并保留
`VITE_GEE_PROJECT_ID` 为空，这样每个用户都可以在 GeoAgent 面板中输入自己
启用了 Earth Engine 的 Google Cloud 项目 ID。

## React 示例

一个演示 `GeoAgentControlReact` 与 `useGeoAgentState` 的 React 示例。它使用
与原生示例相同的默认权限行为。

```bash
npm run dev
```

打开 <http://localhost:5173/examples/react/>。

## Leaflet 示例

一个在纯 [Leaflet](https://leafletjs.com/) 地图上运行同一套 agent 工具的原生
TypeScript 示例。它向 `GeoAgentControl` 传入
`mapEngine: { kind: 'leaflet', namespace: L }`，并通过
`addGeoAgentToLeafletMap` 挂载控件。支持的命令范围见根 README 的
「在 Leaflet 上运行」章节。

```bash
npm run dev
```

打开 <http://localhost:5173/examples/leaflet/>。

## OpenLayers 示例

一个在纯 [OpenLayers](https://openlayers.org/) 地图上运行同一套 agent 工具
的原生 TypeScript 示例。它组装 ol 类命名空间（`Feature`、`VectorLayer`、
`GeoJSON`、样式类、投影辅助函数），传入
`mapEngine: { kind: 'openlayers', namespace }`，并通过
`addGeoAgentToOpenLayersMap` 挂载控件。支持的命令范围见根 README 的
「在 OpenLayers 上运行」章节。

```bash
npm run dev
```

打开 <http://localhost:5173/examples/openlayers/>。

## 构建

```bash
npm run build:examples
```

构建产物写入 `dist-examples`。
