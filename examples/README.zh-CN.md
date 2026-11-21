# 示例

**[English](README.md) | [简体中文](README.zh-CN.md)**

本目录包含 `web-geoagent` 的示例实现。示例直接引入
`maplibre-gl-layer-control`，以免已发布的 GeoAgent 库依赖这个可选的 UI
控件。

演示站点是基于 Vite 的多页 React 应用，使用
[shadcn/ui](https://ui.shadcn.com) 与 Tailwind CSS 4 构建样式：首页渲染
shadcn 卡片与语言切换器，每个示例页共享 `src/demo/example-shell.tsx` 提供
的页壳（返回链接、标题、GitHub 链接），各页的地图逻辑原样保留。共享的演示
模块集中在 `src/demo/`（`demo.css`、`locale.ts`、`i18n.ts` 以及
`src/demo/components/ui/` 下的 shadcn 组件）。npm 库本体提供无头
`GeoAgentCore`，同时保留原生控件与 shadcn/ui React 面板两种 UI。

所有示例均采用左右布局：shadcn/ui 的 `<GeoAgentPanel>` 直接渲染在左侧侧栏
中（无需 dock 手术——面板填满自身容器），地图占据其余空间。Leaflet 与
OpenLayers 页面传入与原生控件相同的 `mapEngine` 选项，面板在挂载时将核心
attach 到地图。

所有示例均跟随示例首页选择的语言：首页的 中文/English 下拉框会把选择保存在
`localStorage`（`geoagent.locale`），每个示例页读取该选择并通过 `locale`
选项传给 Agent 面板（`src/demo/locale.ts`）。

## 基础示例

在 React 页面入口（`main.tsx`）中用 `GeoAgentPanel` 驱动 MapLibre 地图（默认
的原生风格工具配置）。它默认启用 MapLibre JavaScript 与图层删除能力，同时
隐藏权限复选框。地图以 globe 投影启动，底图下方叠加
`@geoql/maplibre-gl-starfield` 星空穹顶（ESO 银河全景图，CC BY 4.0）。

```bash
pnpm dev
```

打开 <http://localhost:5173/examples/basic/>。

## ArcGIS Map 示例

用 [`@arcgis/map-components`](https://developers.arcgis.com/javascript/latest/references/map-components/components/arcgis-map/)
的 `<arcgis-map>` web component（MapView）配合 `ArcGISTools`。页面创建受控
`GeoAgentCore`（`mapEngine: { kind: "arcgis", viewKind: "map", namespace }`），
在组件 `when()` 就绪后，**通过 agent 自己的工具机制**（
`tools.runCommand("add_geojson_data", ...)`）预置一份手造 GeoJSON（街区面、
公交线、咖啡馆点）——第一条提示就有 agent 托管的图层可查询、可改样式。

```bash
pnpm dev
```

打开 <http://localhost:5173/examples/arcgis-map/>。

`@arcgis/map-components` 就绪方式说明：这些 web component **没有 `when()`
方法**——元素继承的是现代原生 `EventTarget.prototype.when(type)`，它要求必传
事件名，与视图就绪无关。请改用导出的 `waitForArcGISComponent(element)`，它在
元素暴露出 `.view` 时解析（监听 `arcgisViewReadyChange` 事件，并有轮询兜底）：

```javascript
import { waitForArcGISComponent } from 'web-geoagent';

const mapEl = document.querySelector('arcgis-map');
const view = await waitForArcGISComponent(mapEl);
addGeoAgentToArcGISMap(agent, mapEl, { position: 'top-left' });
```

## ArcGIS Scene 示例

`<arcgis-scene>` web component（`ground="world-elevation"` 的 SceneView 球体），
初始相机俯瞰珠穆朗玛峰，由同一个 `ArcGISTools` 驱动（
`mapEngine: { kind: "arcgis", viewKind: "scene" }`）。shim 会为场景适配相机
模型——zoom 走视图 scale、bearing 走 `camera.heading`、pitch 走
`camera.tilt`，marker 定位使用视图精确的 `toScreen` 投影。`screenshot_map`
在此可用；系统提示词一开始就描述球体几何。

```bash
pnpm dev
```

打开 <http://localhost:5173/examples/arcgis-scene/>.

## Earth Engine 示例

通过面板的 `earthEngine` 选项启用 Google Earth Engine 工具。把
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
pnpm dev
```

打开 <http://localhost:5173/examples/earth-engine/>。

公开部署时，请在构建时配置 `VITE_GEE_OAUTH_CLIENT_ID`，并保留
`VITE_GEE_PROJECT_ID` 为空，这样每个用户都可以在 GeoAgent 面板中输入自己
启用了 Earth Engine 的 Google Cloud 项目 ID。

## React 示例

与基础示例相同的配置——演示面板驱动的示例页全部是 React。它使用与基础示例
相同的默认权限行为。

```bash
pnpm dev
```

打开 <http://localhost:5173/examples/react/>。

## Leaflet 示例

在纯 [Leaflet](https://leafletjs.com/) 地图上运行同一套 agent 工具。页面向
`GeoAgentPanel` 传入 `mapEngine: { kind: 'leaflet', namespace: L }`，面板在
挂载时将核心 attach 到 Leaflet 地图。支持的命令范围见根 README 的
「在 Leaflet 上运行」章节。

```bash
pnpm dev
```

打开 <http://localhost:5173/examples/leaflet/>。

## OpenLayers 示例

在纯 [OpenLayers](https://openlayers.org/) 地图上运行同一套 agent 工具。它
组装 ol 类命名空间（`Feature`、`VectorLayer`、`GeoJSON`、样式类、投影辅助
函数），向 `GeoAgentPanel` 传入
`mapEngine: { kind: 'openlayers', namespace }`。支持的命令范围见根 README 的
「在 OpenLayers 上运行」章节。

```bash
pnpm dev
```

打开 <http://localhost:5173/examples/openlayers/>。

## 构建

```bash
pnpm build:examples
```

构建产物写入 `dist-examples`。
