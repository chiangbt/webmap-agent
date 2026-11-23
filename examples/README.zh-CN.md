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

MapLibre GL 基础示例在地图上挂载浮动的 `GeoAgentControl`。其余示例将
`<GeoAgentPanel>` 渲染到地图左侧的侧栏。Leaflet 和 OpenLayers 通过
`mapEngine` 选项指定引擎。
省略引擎配置时，`GeoAgentCore` 和 `GeoAgentPanel` 默认使用 MapLibre。
TypeScript 会检查地图实例是否与配置的引擎或传入的 Core 匹配。ArcGIS 示例
在组件的内部视图就绪后再绑定。

所有示例均跟随示例首页选择的语言：首页的 中文/English 下拉框会把选择保存在
`localStorage`（`geoagent.locale`），每个示例页读取该选择并通过 `locale`
选项传给 Agent 面板（`src/demo/locale.ts`）。

## MapLibre GL 示例

地图加载后，通过 `map.addControl()` 在左上角挂载原生 `GeoAgentControl`。
浮动面板默认展开，可收起为地图控件按钮。地图销毁时由 MapLibre 调用控件的
清理方法。地图以 globe 投影启动，初始范围即全球（正北朝上，加载后
整个球体尽收眼底）；底图下方叠加 `@geoql/maplibre-gl-starfield` 星空穹顶
（ESO 银河全景图，CC BY 4.0），GlobeControl 与 agent 的 `set_projection`
工具可随时切换到平面 Mercator。

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
初始为全球视野，由同一个 `ArcGISTools` 驱动（
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

## MapLibre GL React 示例

地图就绪后，在左侧栏渲染 `<GeoAgentPanel map={map} />`。面板负责绑定地图，
并填满 React 侧栏。

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
