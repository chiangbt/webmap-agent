/**
 * GeoAgentTools 的工具定义层：把通用地图工具、Earth Engine 工具组与
 * run_maplibre_script 的 zod schema、描述文案与回调组装成 Strands Tool
 * 实例。所有回调只依赖两个入口 —— runCommand（命令分发）与
 * requireDestructiveApproval（破坏性操作闸门）—— 因此定义层不依赖引擎
 * 子类与基类内部状态，按 {@link ToolDefContext} 纯函数式构建。
 *
 * 定义层不 import geoagent-tools.ts（避免环）；引擎专属工具仍由各子类的
 * engineTools() 提供，经 buildMapToolDefinitions 合并。
 */
import { tool, type JSONValue, type Tool } from "@strands-agents/sdk";
import { z } from "zod";

/** 工具定义层的最小依赖面：全部回调所需的两个绑定入口。 */
export interface ToolDefContext {
  /** 命令分发入口（GeoAgentTools.runCommand 的绑定引用）。 */
  runCommand: (command: string, args?: unknown) => Promise<JSONValue>;
  /** 破坏性操作闸门（GeoAgentTools.requireDestructiveApproval 的绑定引用）。 */
  requireDestructiveApproval: (action: string) => void;
}

/**
 * 通用地图工具定义：图层查询、导航、底图、overlay、source/layer/style 等
 * 命令的 schema 与描述。本组共享的 zod schema 片段也定义在这里。
 */
export function buildMapToolDefinitions(ctx: ToolDefContext, engineTools: Tool[]): Tool[] {
  // 通用 schema 片段：多个工具复用同一段 zod 定义，保证文案一致。
  // 可选的 MapLibre 兼容样式参数（键名自由）。
  const optionalStyleSchema = z
    .record(z.string(), z.any())
    .optional()
    .describe("Optional MapLibre-compatible paint/style values.");
  // 必填的 MapLibre source 规格。
  const sourceSpecSchema = z.record(z.string(), z.any()).describe("MapLibre source specification.");
  // 必填的 MapLibre layer 规格。
  const layerSpecSchema = z.record(z.string(), z.any()).describe("MapLibre layer specification.");
  // filter 表达式；允许 null 表示清除现有过滤。
  const filterSchema = z
    .array(z.any())
    .nullable()
    .describe("MapLibre filter expression, or null to clear the filter. Required.");
  // 图像/视频四角坐标：左上、右上、右下、左下（各为 [x, y] 数值对）。
  const cornerCoordinatesSchema = z
    .array(z.array(z.number()).length(2))
    .length(4)
    .describe(
      "Four image/video corner coordinates: top-left, top-right, bottom-right, bottom-left.",
    );
  return [
    /**
     * list_layers — 列出浏览器地图当前的全部图层（style layer + agent 管理的
     * marker），并标注每个图层是否由 agent 添加（user_added）与可见性。
     * 代理在操作图层前（如 set_paint_property / remove_layer）用它探查现状；
     * 无参数。
     */
    tool({
      name: "list_layers",
      description: "List layers currently present in the browser MapLibre map.",
      inputSchema: z.object({}),
      callback: () => ctx.runCommand("list_layers"),
    }),
    /**
     * get_map_state — 返回地图相机状态：center/zoom/bearing/pitch/projection、
     * 视口 bounds 与 agent 已添加的图层名。代理在定位、绘图或回答“当前看到什么”
     * 之前用它感知地图状态；无参数。
     */
    tool({
      name: "get_map_state",
      description: "Return the browser map camera state, bounds, pitch, bearing, and user layers.",
      inputSchema: z.object({}),
      callback: () => ctx.runCommand("get_map_state"),
    }),
    /**
     * search_place — 地名/地址搜索（内置三级回退：天地图 → ArcGIS geocoder
     * → LLM 自身知识）。中文地名优先走天地图；返回归一化候选列表与命中来源。
     * 拿到候选后应紧随 fly_to / zoom_to_bounds 完成定位。
     */
    tool({
      name: "search_place",
      description:
        "Search a place name or address and return candidates with lon/lat and the source (Tianditu, ArcGIS, or LLM fallback). Use before map operations that need coordinates for a place or address.",
      inputSchema: z.object({
        query: z.string().describe("Place name or address, e.g. a Chinese place name like 天安门."),
      }),
      callback: (input) => ctx.runCommand("search_place", input),
    }),
    /**
     * set_center — 立即跳转（无动画）将地图中心设为指定经纬度。
     * lat/lon 为十进制度；zoom 可选，缺省保持当前缩放级别。
     */
    tool({
      name: "set_center",
      description: "Center the browser map on a latitude/longitude coordinate.",
      inputSchema: z.object({
        lat: z.number().describe("Latitude in decimal degrees."),
        lon: z.number().describe("Longitude in decimal degrees."),
        zoom: z.number().optional().describe("Optional zoom level."),
      }),
      callback: (input) => ctx.runCommand("set_center", input),
    }),
    /**
     * fly_to — 以动画方式飞行到指定经纬度（适合向用户展示移动过程）。
     * 参数含义与 set_center 相同；zoom 可选，缺省保持当前级别。
     */
    tool({
      name: "fly_to",
      description: "Animate the browser map to a latitude/longitude coordinate.",
      inputSchema: z.object({
        lat: z.number().describe("Latitude in decimal degrees."),
        lon: z.number().describe("Longitude in decimal degrees."),
        zoom: z.number().optional().describe("Optional zoom level."),
      }),
      callback: (input) => ctx.runCommand("fly_to", input),
    }),
    /**
     * set_zoom — 直接设置地图缩放级别（MapLibre zoom，0 为全球视角）。
     * 需要改变细节层级而不移动中心点时调用。
     */
    tool({
      name: "set_zoom",
      description: "Set the browser map zoom level.",
      inputSchema: z.object({
        zoom: z.number().describe("MapLibre zoom level."),
      }),
      callback: (input) => ctx.runCommand("set_zoom", input),
    }),
    /**
     * zoom_to_bounds — 把视口适配到西/南/东/北包围盒（带 48px 内边距、
     * maxZoom 16 防止过度放大）。展示某个区域范围时调用。
     */
    tool({
      name: "zoom_to_bounds",
      description: "Zoom the browser map to a west/south/east/north bounding box.",
      inputSchema: z.object({
        west: z.number(),
        south: z.number(),
        east: z.number(),
        north: z.number(),
      }),
      callback: (input) => ctx.runCommand("zoom_to_bounds", input),
    }),
    /**
     * add_basemap — 在既有用户图层之下追加一层 raster 底图（Google 卫星影像、
     * Google 混合、Esri World Imagery 或自定义 XYZ 模板），不替换当前 style。
     * 代理想给地图加卫星影像/栅格背景时应优先用它而非 change_basemap。
     */
    tool({
      name: "add_basemap",
      description:
        "Add a raster basemap, such as Google satellite imagery, beneath existing user overlays without replacing the current MapLibre style.",
      inputSchema: z.object({
        provider: z
          .enum(["google_satellite", "google_hybrid", "esri_world_imagery"])
          .optional()
          .describe("Known raster basemap provider."),
        url: z.string().optional().describe("Custom XYZ tile URL template."),
        name: z.string().optional().describe("Layer name."),
        attribution: z.string().optional(),
        opacity: z.number().min(0).max(1).optional(),
      }),
      callback: (input) => ctx.runCommand("add_basemap", input),
    }),
    /**
     * change_basemap — 用 style URL 或内置 style id（liberty/positron/dark/
     * voyager/demotiles/osm 等）整体替换当前地图 style，并在加载完成后自动
     * 重放此前添加的用户图层。适合整体换风格；仅加栅格背景请用 add_basemap。
     */
    tool({
      name: "change_basemap",
      description:
        "Replace the entire browser MapLibre style by URL or known style id. Prefer add_basemap for satellite imagery or raster background layers.",
      inputSchema: z.object({
        style: z.string().describe("Known style id or MapLibre style URL."),
      }),
      callback: (input) => ctx.runCommand("change_basemap", input),
    }),
    /**
     * add_marker — 在地图上添加一个带可选 popup/tooltip 的 marker。
     * 代理需要标注某个位置（POI、查询结果点等）时调用。lat/lon 定位；
     * popup 为点击弹出的文本、tooltip 为悬停标题、name 为图层名（默认
     * marker-N）、color 为 marker 颜色。
     */
    tool({
      name: "add_marker",
      description: "Add a marker to the browser map.",
      inputSchema: z.object({
        lat: z.number(),
        lon: z.number(),
        popup: z.string().optional(),
        tooltip: z.string().optional(),
        name: z.string().optional(),
        color: z.string().optional(),
      }),
      callback: (input) => ctx.runCommand("add_marker", input),
    }),
    /**
     * add_geojson_data — 把内存中的 GeoJSON 对象渲染为新图层（自动按
     * geometry 类型生成 fill/line/circle 图层并适配视野）。代理拿到分析
     * 结果数据需要在地图上可视化时调用。data 为 GeoJSON 对象、name 为图层名、
     * style 为可选 paint/style 参数。
     */
    tool({
      name: "add_geojson_data",
      description: "Add an in-memory GeoJSON object to the browser map.",
      inputSchema: z.object({
        data: z.any().describe(
          "GeoJSON Feature, FeatureCollection, or Geometry object. A JSON-encoded string of one is also accepted.",
        ),
        name: z.string().describe("Layer name."),
        style: optionalStyleSchema,
      }),
      callback: (input) => ctx.runCommand("add_geojson_data", input),
    }),
    /**
     * add_vector_data — 从 URL 拉取 GeoJSON 并渲染为新图层（同 add_geojson_data，
     * 只是数据来源为远程文档）。代理只知道数据地址而非数据内容时调用。
     * url 必须是合法 URL；name 为图层名；style 可选。
     */
    tool({
      name: "add_vector_data",
      description: "Add a GeoJSON URL to the browser map.",
      inputSchema: z.object({
        url: z.string().url().describe("URL to a GeoJSON document."),
        name: z.string().describe("Layer name."),
        style: optionalStyleSchema,
      }),
      callback: (input) => ctx.runCommand("add_vector_data", input),
    }),
    /**
     * add_xyz_tile_layer — 添加一个 XYZ 栅格瓦片图层（url 为含 {z}/{x}/{y}
     * 的模板）。代理需要叠加第三方栅格服务（影像、专题瓦片）时调用；
     * attribution 可选。
     */
    tool({
      name: "add_xyz_tile_layer",
      description: "Add an XYZ raster tile layer to the browser map.",
      inputSchema: z.object({
        url: z.string().describe("XYZ tile URL template."),
        name: z.string().describe("Layer name."),
        attribution: z.string().optional(),
      }),
      callback: (input) => ctx.runCommand("add_xyz_tile_layer", input),
    }),
    /**
     * add_map_source — 直接添加一个原生 MapLibre source 规格（不自动建图层）。
     * 代理要使用 add_map_layer 之外的底层控制、或先建 source 再逐个建 layer
     * 时调用。source_id 为 source 标识，source 为完整 SourceSpecification。
     */
    tool({
      name: "add_map_source",
      description: "Add a native MapLibre source specification to the browser map.",
      inputSchema: z.object({
        source_id: z.string().describe("Source id to add."),
        source: sourceSpecSchema,
      }),
      callback: (input) => ctx.runCommand("add_map_source", input),
    }),
    /**
     * remove_map_source — 删除一个原生 source；若有活动图层依赖该 source 则
     * 拒绝删除并列出依赖图层，避免渲染残缺。source_id 指明要删除的 source。
     */
    tool({
      name: "remove_map_source",
      description: "Remove a native MapLibre source when no active layers depend on it.",
      inputSchema: z.object({
        source_id: z.string().describe("Source id to remove."),
      }),
      callback: (input) => ctx.runCommand("remove_map_source", input),
    }),
    /**
     * add_map_layer — 直接添加一个原生 MapLibre layer 规格（source 需已存在）。
     * 代理要精细控制渲染（vector 样式、heatmap 等）时调用；layer 为完整
     * LayerSpecification，before_id 可选，指定插入到哪个图层之前。
     */
    tool({
      name: "add_map_layer",
      description: "Add a native MapLibre layer specification to the browser map.",
      inputSchema: z.object({
        layer: layerSpecSchema,
        before_id: z.string().optional().describe("Optional layer id to insert before."),
      }),
      callback: (input) => ctx.runCommand("add_map_layer", input),
    }),
    /**
     * remove_map_layer — 删除任意一个原生 style 图层（按 layer_id）。
     * 属于破坏性操作，需宿主允许 remove_layer 类工具。
     */
    tool({
      name: "remove_map_layer",
      description: "Remove an arbitrary native MapLibre style layer.",
      inputSchema: z.object({
        layer_id: z.string().describe("Layer id to remove."),
      }),
      callback: (input) => ctx.runCommand("remove_map_layer", input),
    }),
    /**
     * move_layer — 调整图层叠放顺序：把 layer_id 移动到 before_id 之前；
     * before_id 省略时移到最顶层。代理需要控制渲染次序（如让标注盖在
     * 矢量层之上）时调用。
     */
    tool({
      name: "move_layer",
      description:
        "Move a MapLibre layer before another layer, or to the top if before_id is omitted.",
      inputSchema: z.object({
        layer_id: z.string(),
        before_id: z.string().optional(),
      }),
      callback: (input) => ctx.runCommand("move_layer", input),
    }),
    /**
     * set_paint_property — 修改已有图层的 paint 属性（颜色、透明度、线宽等
     * 渲染外观）。代理在样式调整请求（如"把这层改成红色"）时调用；
     * value 可以是字面量或 MapLibre 表达式。
     */
    tool({
      name: "set_paint_property",
      description: "Set a MapLibre paint property on an existing layer.",
      inputSchema: z.object({
        layer_id: z.string(),
        property: z.string(),
        value: z.any(),
      }),
      callback: (input) => ctx.runCommand("set_paint_property", input),
    }),
    /**
     * set_layout_property — 修改已有图层的 layout 属性（visibility、
     * text-field、icon-size 等布局项）。与 paint 的区别：layout 改变结构/
     * 排布而非颜色外观。
     */
    tool({
      name: "set_layout_property",
      description: "Set a MapLibre layout property on an existing layer.",
      inputSchema: z.object({
        layer_id: z.string(),
        property: z.string(),
        value: z.any(),
      }),
      callback: (input) => ctx.runCommand("set_layout_property", input),
    }),
    /**
     * set_layer_filter — 设置或清除图层的 filter 表达式（控制哪些要素参与
     * 渲染）。代理要按属性筛选显示（如"只显示人口大于 100 万的城市"）时调用；
     * filter 传 null 表示清除过滤。
     */
    tool({
      name: "set_layer_filter",
      description: "Set or clear a MapLibre filter expression on an existing layer.",
      inputSchema: z.object({
        layer_id: z.string(),
        filter: filterSchema,
      }),
      callback: (input) => ctx.runCommand("set_layer_filter", input),
    }),
    /**
     * update_geojson_source — 原位更新已有 GeoJSON source 的数据（setData），
     * 不重建图层。代理需要刷新数据（轮询、筛选结果更新）时调用。
     * source_id 可以是精确 source id，也可以是图层名（约定其 source 为
     * `{name}-source`）；data 为新的 GeoJSON。
     */
    tool({
      name: "update_geojson_source",
      description: "Update data for an existing GeoJSON source by source id or layer name.",
      inputSchema: z.object({
        source_id: z
          .string()
          .describe("Exact source id, or a layer name whose source is {name}-source."),
        data: z.any().describe("GeoJSON data for the source."),
      }),
      callback: (input) => ctx.runCommand("update_geojson_source", input),
    }),
    /**
     * query_source_features — 按 source 查询要素（含未渲染的），可指定
     * source_layer（vector source 必填）与 filter。代理要做属性级检索、
     * 统计而非屏幕拾取时调用。
     */
    tool({
      name: "query_source_features",
      description: "Query source features from a MapLibre source.",
      inputSchema: z.object({
        source_id: z.string(),
        source_layer: z.string().optional(),
        filter: z.array(z.any()).optional(),
      }),
      callback: (input) => ctx.runCommand("query_source_features", input),
    }),
    /**
     * add_image_layer — 把一张地理参考图片作为 image source + raster 图层
     * 叠加到地图（四角坐标决定其摆放）。代理要叠加扫描图、历史地图、
     * 雷达图等静态影像时调用。coordinates 为四角 [lon,lat]，按左上、右上、
     * 右下、左下顺序；opacity 可选。
     */
    tool({
      name: "add_image_layer",
      description: "Add a georeferenced image overlay as a MapLibre image source and raster layer.",
      inputSchema: z.object({
        id: z.string().optional().describe("Layer id. Defaults to image-overlay."),
        url: z.string().url(),
        coordinates: cornerCoordinatesSchema,
        opacity: z.number().min(0).max(1).optional(),
      }),
      callback: (input) => ctx.runCommand("add_image_layer", input),
    }),
    /**
     * add_cluster_layer — 添加点聚合计数图层：聚合圆（颜色/半径随数量分档）、
     * 可选计数标注、以及未聚合的单点图层。代理要展示大量点（成千上万的
     * POI/事件）而不想互相遮挡时调用。data 为点要素 FeatureCollection；
     * cluster_radius/cluster_max_zoom 控制聚合行为，cluster_colors 与
     * cluster_steps 控制分档配色，show_cluster_count 控制是否显示数字，
     * fit_bounds 控制是否缩放至数据范围。
     */
    tool({
      name: "add_cluster_layer",
      description:
        "Add a clustered GeoJSON point layer with cluster circles, count labels, and unclustered points.",
      inputSchema: z.object({
        data: z.any().describe("GeoJSON FeatureCollection containing point features."),
        name: z.string(),
        cluster_radius: z.number().optional(),
        cluster_max_zoom: z.number().optional(),
        cluster_colors: z.array(z.string()).optional(),
        cluster_steps: z.array(z.number()).optional(),
        cluster_min_radius: z.number().optional(),
        cluster_max_radius: z.number().optional(),
        unclustered_color: z.string().optional(),
        unclustered_radius: z.number().optional(),
        show_cluster_count: z.boolean().optional(),
        fit_bounds: z.boolean().optional(),
      }),
      callback: (input) => ctx.runCommand("add_cluster_layer", input),
    }),
    /**
     * add_choropleth_layer — 添加分级设色（choropleth）面图层：fill 面 +
     * outline 线两个图层。代理要按属性值给多边形着色（人口密度、得分分区等）
     * 时调用。data 为面要素 FeatureCollection；color_expression 为 MapLibre
     * fill-color 表达式（如 interpolate/step 分档）；fill_opacity、line_color、
     * line_width、fit_bounds 可选。
     */
    tool({
      name: "add_choropleth_layer",
      description:
        "Add a polygon choropleth fill layer and outline layer from GeoJSON and a MapLibre color expression.",
      inputSchema: z.object({
        data: z.any().describe("GeoJSON FeatureCollection containing polygon features."),
        name: z.string(),
        color_expression: z.array(z.any()).describe("MapLibre expression for fill-color."),
        fill_opacity: z.number().min(0).max(1).optional(),
        line_color: z.string().optional(),
        line_width: z.number().optional(),
        fit_bounds: z.boolean().optional(),
      }),
      callback: (input) => ctx.runCommand("add_choropleth_layer", input),
    }),
    /**
     * set_layer_visibility — 显示或隐藏图层（按 overlay 名或 layer id）。
     * marker 类 overlay 会切换 DOM 元素显隐；代理在对比展示、临时关闭干扰
     * 图层时调用。
     */
    tool({
      name: "set_layer_visibility",
      description: "Show or hide a browser map layer.",
      inputSchema: z.object({
        name: z.string().describe("Layer or overlay name."),
        visible: z.boolean(),
      }),
      callback: (input) => ctx.runCommand("set_layer_visibility", input),
    }),
    /**
     * set_layer_opacity — 设置图层透明度（0-1），按图层类型映射到
     * raster/fill/line/circle-opacity 属性。代理要弱化背景层、突出前景层时调用。
     */
    tool({
      name: "set_layer_opacity",
      description: "Set browser map layer opacity between 0 and 1.",
      inputSchema: z.object({
        name: z.string().describe("Layer or overlay name."),
        opacity: z.number().min(0).max(1),
      }),
      callback: (input) => ctx.runCommand("set_layer_opacity", input),
    }),
    /**
     * query_rendered_features — 查询当前渲染出的要素（屏幕拾取）。代理要
     * 回答"这个位置是什么"（点击处信息）时调用。layers 可限定图层名列表；
     * x/y 为画布坐标，缺省取地图中心。返回要素会裁剪到最多 50 条。
     */
    tool({
      name: "query_rendered_features",
      description: "Query rendered features from the browser map.",
      inputSchema: z.object({
        layers: z.array(z.string()).optional(),
        x: z.number().optional().describe("Canvas x coordinate; defaults to map center."),
        y: z.number().optional().describe("Canvas y coordinate; defaults to map center."),
      }),
      callback: (input) => ctx.runCommand("query_rendered_features", input),
    }),
    /**
     * remove_layer — 移除一个用户添加的图层/overlay（按名称）。破坏性操作：
     * 受宿主 allowDestructiveTools 开关限制，未授权时直接报错。
     */
    tool({
      name: "remove_layer",
      description: "Remove a user-added layer from the browser map.",
      inputSchema: z.object({
        name: z.string().describe("User-added layer name."),
      }),
      callback: (input) => {
        ctx.requireDestructiveApproval("Layer removal");
        return ctx.runCommand("remove_layer", input);
      },
    }),
    /**
     * clear_layers — 一次性移除全部用户添加的图层/overlay（不影响底图 style
     * 自带图层）。破坏性操作：受宿主 allowDestructiveTools 开关限制；常用于
     * 开始新一轮可视化前的清场。
     */
    tool({
      name: "clear_layers",
      description: "Remove all user-added layers from the browser map.",
      inputSchema: z.object({}),
      callback: () => {
        ctx.requireDestructiveApproval("Clearing layers");
        return ctx.runCommand("clear_layers");
      },
    }),
    /**
     * buffer_layer — 对一个用户添加的 GeoJSON 图层做缓冲区分析（所有引擎
     * 可用）。结果渲染为新图层并适配视野，返回半径、要素数与面积；分析前
     * 先用 list_layers 确认图层名。
     */
    tool({
      name: "buffer_layer",
      description:
        "Buffer all features of a user-added GeoJSON layer by a radius in kilometers, add the result as a new layer, fit the view to it, and return its metrics (feature count, area in km2). Works on every map engine.",
      inputSchema: z.object({
        name: z.string().describe("User-added GeoJSON layer name (see list_layers)."),
        radiusKm: z.number().positive().max(1000).describe("Buffer radius in kilometers."),
        resultName: z.string().optional().describe("Name for the result layer (default: <name>-buffer)."),
      }),
      callback: (input) => ctx.runCommand("buffer_layer", input),
    }),
    /**
     * create_plan — 为多步任务创建执行计划。用户请求需要三个及以上独立操作
     * （检索→加载→渲染→统计等）时先调用它拆解步骤，再用 update_plan_step
     * 随执行推进各步骤状态；简单的一步请求不要建计划。
     */
    tool({
      name: "create_plan",
      description:
        "Create a step-by-step plan for a multi-step task (3+ distinct operations). Call update_plan_step as you progress; do not create a plan for simple single-step requests.",
      inputSchema: z.object({
        steps: z
          .array(z.string().min(1))
          .min(1)
          .max(12)
          .describe("Ordered short step titles, at most 12 items."),
      }),
      callback: (input) => ctx.runCommand("create_plan", input),
    }),
    /**
     * update_plan_step — 按 1 起步的步骤编号推进计划状态，可附简短备注
     * （如产出的图层名或失败原因）。全部步骤 done/failed 后应在回答中总结。
     */
    tool({
      name: "update_plan_step",
      description:
        "Update one plan step by its 1-based index: set status to in_progress when starting, done or failed when finished, with an optional short note.",
      inputSchema: z.object({
        index: z.number().int().min(1).describe("1-based step index from create_plan."),
        status: z.enum(["pending", "in_progress", "done", "failed"]),
        note: z.string().optional().describe("Optional short note, e.g. the produced layer name or failure reason."),
      }),
      callback: (input) => ctx.runCommand("update_plan_step", input),
    }),
    // 引擎专属工具由子类提供：MapLibre/Mapbox 上是 WebGL 专属批次，
    // 2D shim 引擎上为空。
    ...engineTools,
  ];
}

/**
 * GEE 脚本工具（run_gee_javascript_snippet）：在脱敏 ee 门面上执行模型
 * 生成的 Earth Engine JavaScript 片段。仅在配置了 earthEngine 且宿主
 * 开启代码执行时由 createTools 注册。
 */
export function buildGeeSnippetTool(ctx: ToolDefContext): Tool {
  return tool({
    /**
     * run_gee_javascript_snippet — 执行一段 Earth Engine JavaScript 片段
     * （经 new Function 执行、非沙箱），片段可通过 Map.addLayer(...)/
     * addLayer(...) 等辅助函数把 GEE 对象渲染为 raster 瓦片图层。
     * 代理需要自由组合 ee API（filterDate/normalizedDifference 等专用
     * 工具覆盖不了的场景）时调用；code 为脚本内容、description 可选。
     */
    name: "run_gee_javascript_snippet",
    description:
      "Run an Earth Engine JavaScript snippet (executed with new Function, not sandboxed) that adds one or more MapLibre raster tile layers.",
    inputSchema: z.object({
      code: z
        .string()
        .describe(
          "JavaScript using ee plus Map.addLayer(...), addLayer(...), getEeLayer(name), and listEeLayers().",
        ),
      description: z.string().optional(),
    }),
    callback: (input) => ctx.runCommand("run_gee_javascript_snippet", input),
  });
}

/**
 * Earth Engine 工具组定义：目录检索、数据集信息、目录摘要、初始化、
 * 数据集加载、归一化指数计算、已加载图层列表与可视化调整、区域统计。
 * 仅在构造时配置了 earthEngine 时由 createTools 注册。
 */
export function buildGeeToolDefinitions(ctx: ToolDefContext): Tool[] {
  // GEE 数据加载类工具共享的参数集（asset、时间窗、bbox、云量、reducer、可视化等）。
  const geeCommonLoadSchema = {
    asset_id: z.string().describe("Google Earth Engine asset id."),
    layer_name: z.string().optional(),
    asset_type: z.enum(["Image", "ImageCollection", "FeatureCollection"]).optional(),
    start_date: z.string().optional().describe("YYYY-MM-DD start date."),
    end_date: z.string().optional().describe("YYYY-MM-DD end date."),
    bbox: z.string().optional().describe("west,south,east,north in WGS84."),
    bounds_collection_asset_id: z.string().optional(),
    bounds_filter_property: z.string().optional(),
    bounds_filter_value: z.string().optional(),
    cloud_cover: z.number().optional(),
    cloud_property: z.string().optional(),
    reducer: z.enum(["mosaic", "median", "mean", "min", "max", "first", "mode"]).optional(),
    min_value: z.number().optional(),
    max_value: z.number().optional(),
    palette: z.string().optional(),
    clip_collection_asset_id: z.string().optional(),
    clip_filter_property: z.string().optional(),
    clip_filter_value: z.string().optional(),
    oauth_client_id: z.string().optional(),
    project_id: z.string().optional(),
  };
  return [
    /**
     * search_gee_datasets — 在 GEE 官方与社区数据目录中检索数据集。
     * 代理要为任务寻找合适的影像/矢量资产时调用。query/category/data_type/
     * source/max_results/include_community 均可选。
     */
    tool({
      name: "search_gee_datasets",
      description: "Search official and community Google Earth Engine data catalogs.",
      inputSchema: z.object({
        query: z.string().optional(),
        category: z.string().optional(),
        data_type: z.string().optional(),
        source: z.enum(["official", "community"]).optional(),
        max_results: z.number().optional(),
        include_community: z.boolean().optional(),
      }),
      callback: (input) => ctx.runCommand("search_gee_datasets", input),
    }),
    /**
     * get_gee_dataset_info — 按 asset id 返回 GEE 目录元数据（波段、时间
     * 范围、比例尺等）。代理在加载资产前了解其结构时调用。
     */
    tool({
      name: "get_gee_dataset_info",
      description: "Return catalog metadata for a Google Earth Engine asset id.",
      inputSchema: z.object({
        asset_id: z.string(),
        include_community: z.boolean().optional(),
      }),
      callback: (input) => ctx.runCommand("get_gee_dataset_info", input),
    }),
    /**
     * summarize_gee_catalog — 按类别汇总 GEE 数据目录的条目数。代理需要
     * 快速了解可用数据面（而不逐条检索）时调用。
     */
    tool({
      name: "summarize_gee_catalog",
      description: "Summarize Earth Engine catalog counts by category.",
      inputSchema: z.object({
        include_community: z.boolean().optional(),
      }),
      callback: (input) => ctx.runCommand("summarize_gee_catalog", input),
    }),
    /**
     * initialize_earth_engine — 用浏览器 OAuth 完成地球引擎认证与初始化。
     * 首次使用 GEE 工具、或换项目/凭据时调用。oauth_client_id/project_id
     * 可选；force 为 true 时跳过已初始化缓存强制重初始化。
     */
    tool({
      name: "initialize_earth_engine",
      description: "Authenticate and initialize Google Earth Engine with browser OAuth.",
      inputSchema: z.object({
        oauth_client_id: z.string().optional(),
        project_id: z.string().optional(),
        force: z.boolean().optional(),
      }),
      callback: (input) => ctx.runCommand("initialize_earth_engine", input),
    }),
    /**
     * load_gee_dataset — 把 GEE 的 Image/ImageCollection/FeatureCollection
     * 加载为地图 raster 瓦片图层。参数沿用 geeCommonLoadSchema（asset_id
     * 必填，时间窗、bbox、云量、reducer、可视化 min/max/palette 等可选），
     * 另有 bands 指定波段、diagnose 输出诊断信息。
     */
    tool({
      name: "load_gee_dataset",
      description:
        "Load a Google Earth Engine Image, ImageCollection, or FeatureCollection into the browser map as raster tiles.",
      inputSchema: z.object({
        ...geeCommonLoadSchema,
        bands: z.string().optional(),
        diagnose: z.boolean().optional(),
      }),
      callback: (input) => ctx.runCommand("load_gee_dataset", input),
    }),
    /**
     * calculate_gee_normalized_difference — 计算并显示归一化差异指数
     * （NDVI/NDWI/MNDWI/NBR 等）。参数沿用 geeCommonLoadSchema，另需
     * positive_band（高反射波段，如 NIR）与 negative_band（低反射波段，
     * 如 RED）；index_name 可自定义结果波段名。
     */
    tool({
      name: "calculate_gee_normalized_difference",
      description:
        "Calculate and display an Earth Engine normalized difference index such as NDVI, NDWI, MNDWI, or NBR.",
      inputSchema: z.object({
        ...geeCommonLoadSchema,
        positive_band: z.string(),
        negative_band: z.string(),
        index_name: z.string().optional(),
      }),
      callback: (input) => ctx.runCommand("calculate_gee_normalized_difference", input),
    }),
    /**
     * list_loaded_gee_layers — 列出当前已注册加载的 GEE 图层（名称、asset、
     * 可视化参数等）。代理在调整可视化或做统计前盘点现状时调用；无参数。
     */
    tool({
      name: "list_loaded_gee_layers",
      description: "List Earth Engine layers registered by the browser GeoAgent.",
      inputSchema: z.object({}),
      callback: () => ctx.runCommand("list_loaded_gee_layers"),
    }),
    /**
     * set_gee_layer_visualization — 用新的可视化参数重新渲染一个已加载的
     * GEE 图层（换波段、调 min/max、换 palette）。layer_name 指定目标图层；
     * 其余参数可选。
     */
    tool({
      name: "set_gee_layer_visualization",
      description: "Re-render a loaded Earth Engine layer with updated visualization parameters.",
      inputSchema: z.object({
        layer_name: z.string(),
        bands: z.string().optional(),
        min_value: z.number().optional(),
        max_value: z.number().optional(),
        palette: z.string().optional(),
        output_layer_name: z.string().optional(),
      }),
      callback: (input) => ctx.runCommand("set_gee_layer_visualization", input),
    }),
    /**
     * calculate_gee_layer_statistics — 对已加载的 GEE 影像图层做限定区域的
     * 服务端统计（均值/最小/最大等）。layer_name 指定图层；band/statistics/
     * scale/max_pixels/best_effort/tile_scale/timeout_seconds 控制计算行为，
     * region_* 三参数可用资产过滤限定统计区域。失败时会返回带 hint 的
     * 降级结果而不是抛错。
     */
    tool({
      name: "calculate_gee_layer_statistics",
      description:
        "Calculate bounded server-side statistics for a loaded Earth Engine image layer.",
      inputSchema: z.object({
        layer_name: z.string(),
        band: z.string().optional(),
        statistics: z.string().optional(),
        scale: z.number().optional(),
        max_pixels: z.number().optional(),
        best_effort: z.boolean().optional(),
        tile_scale: z.number().optional(),
        timeout_seconds: z.number().optional(),
        region_collection_asset_id: z.string().optional(),
        region_filter_property: z.string().optional(),
        region_filter_value: z.string().optional(),
      }),
      callback: (input) => ctx.runCommand("calculate_gee_layer_statistics", input),
    }),
  ];
}

/**
 * 构建 `run_maplibre_script` 工具，文案按当前引擎定制：description 与 code
 * 参数会点名用户脚本实际拿到的绑定（map / namespace / helpers），确保模型
 * 不会对着 Leaflet 地图写出 `maplibregl.Marker(...)`。
 */
export function buildScriptTool(
  ctx: ToolDefContext,
  options: { description: string; namespaceName: string },
): Tool {
  return tool({
    name: "run_maplibre_script",
    description: options.description,
    inputSchema: z.object({
      code: z
        .string()
        .describe(`JavaScript code to execute against map, ${options.namespaceName}, and helpers.`),
      description: z.string().optional(),
    }),
    callback: (input) => ctx.runCommand("run_maplibre_script", input),
  });
}
