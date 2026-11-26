import type { GeoJsonLimits } from '../utils/geojson';
/**
 * 核心共享类型：控件选项、状态快照、会话条目、provider 配置与事件签名。
 * 命令式控件、React 面板与无头引擎共同依赖这份定义。
 */
import type { Map, StyleSpecification } from 'maplibre-gl';
import type { GeoAgentLocale } from '../i18n';
import type { GeoAgentMapEngine } from './tools/geoagent-tools';
import type { EarthEngineOptions } from './earth-engine/earth-engine';
import type { PlaceSearchOptions } from './geocoding/place-search';

/** 支持的 provider 标识：OpenAI 兼容端点与 Anthropic 兼容端点。 */
export type GeoAgentProviderId =
  | 'openai-compatible'
  | 'anthropic-compatible';

/** 单个 provider 的展示与存储配置（面板据此渲染设置表单与 sessionStorage 键）。 */
export interface GeoAgentProviderConfig {
  id: GeoAgentProviderId;
  label: string;
  keyLabel: string;
  keyPlaceholder: string;
  storageKey: string;
  defaultModel: string;
  defaultRegion?: string;
  /**
   * 该 provider 是否需要用户填写 API base URL
   * （OpenAI-compatible / 自定义端点，如本地 LLM 服务或私有化部署）。
   */
  requiresBaseUrl?: boolean;
  /** API base URL 输入框显示的 placeholder。 */
  baseUrlPlaceholder?: string;
}

/** GeoAgent 控件的全部可配置项（缺失项由 GeoAgentCore 构造时填默认值）。 */
export interface GeoAgentControlOptions {
  /** GeoJSON request/body/geometry limits. Defaults: 30s, 10 MiB, 100k features, 1m positions. */
  geoJsonLimits?: GeoJsonLimits;
  /**
   * 面板是否以折叠状态启动。
   * @default true
   */
  collapsed?: boolean;

  /**
   * 控件按钮在地图上的位置。
   * @default 'top-right'
   */
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

  /**
   * 控件头部显示的标题。
   * @default 'GeoAgent'
   */
  title?: string;

  /**
   * 浮动面板宽度（像素）。
   * @default 390
   */
  panelWidth?: number;

  /**
   * 可调整面板的最小宽度（像素）。
   * @default 320
   */
  panelMinWidth?: number;

  /**
   * 可调整面板的最大宽度（像素）。
   * @default 720
   */
  panelMaxWidth?: number;

  /**
   * 浮动面板高度（像素）。省略时面板按内容自适应高度
   * （上限为 `panelMaxHeight`），直到用户手动调整。
   */
  panelHeight?: number;

  /**
   * 可调整面板的最小高度（像素）。
   * @default 320
   */
  panelMinHeight?: number;

  /**
   * 可调整面板的最大高度（像素）。地图容器高度也会作为上限生效，
   * 因此面板可被拖拽到几乎填满地图。
   * @default 2000
   */
  panelMaxHeight?: number;

  /**
   * 控件按钮容器的自定义 CSS class。
   */
  className?: string;

  /**
   * 面板所有 UI 文案（标签、按钮、状态徽标、日志消息）使用的 locale。
   * 品牌名与技术名词在各语言下保持一致。
   * @default 'en'
   */
  locale?: GeoAgentLocale;

  /**
   * 无已存储 provider 偏好时的初始 provider。
   * @default 'openai-compatible'
   */
  defaultProvider?: GeoAgentProviderId;

  /**
   * 覆盖所有 provider 或指定 provider 的默认模型。
   */
  defaultModel?: string | Partial<Record<GeoAgentProviderId, string>>;

  /**
   * sessionStorage 键的前缀。
   * @default 'web-geoagent'
   */
  storagePrefix?: string;

  /**
   * 是否把会话条目持久化到 localStorage（跨页面刷新恢复对话）。
   * 持久化内容仅含展示条目（角色与文本，上限 200 条），不含 API key
   * 等敏感配置。默认关闭，宿主显式开启。
   * @default false
   */
  persistConversation?: boolean;

  /**
   * 宿主应用传入的初始 API key。已保存的 sessionStorage 值优先；
   * 除非用户编辑 API key 输入框，这些值不会写入 storage。
   */
  apiKeys?: Partial<Record<GeoAgentProviderId, string>>;

  /**
   * 所有 provider 共用的兜底 API key：在没有存储 key 且没有 provider 专属
   * `apiKeys` 条目时使用（例如从环境变量注入的全局部署凭据）。面板中像
   * 已提交的 key 一样展示，且被上述两个来源覆盖。
   */
  defaultApiKey?: string;

  /**
   * 兼容型 provider 的兜底 API base URL：当前 provider 在 storage 中没有任何
   * 值时使用（例如从环境变量注入的部署端点）。在面板中展示，存储值优先。
   */
  defaultBaseUrl?: string;

  /**
   * 可选的 MapLibre JavaScript 执行工具（run_maplibre_script）是否默认启用。
   * 该工具经 `new Function` 在页面上下文执行模型生成的代码，并非安全沙箱；
   * 仅应在可信环境显式开启。
   * @default false
   */
  allowCodeExecutionDefault?: boolean;

  /**
   * 破坏性的图层删除类工具是否默认启用。
   * @default true
   */
  allowDestructiveToolsDefault?: boolean;

  /**
   * 是否在面板中显示权限开关。
   * @default false
   */
  showPermissionToggles?: boolean;

  /**
   * 代理可用的已知底图 style ID 表。
   */
  basemaps?: Record<string, string | StyleSpecification>;

  /**
   * 可选的 Google Earth Engine 工具配置。默认走浏览器 OAuth；宿主应用也可以
   * 提供短期 access token。不要向这个浏览器端包提供 service account 私钥。
   */
  earthEngine?: EarthEngineOptions;

  /**
   * 地名/地址搜索配置（三级回退：天地图 → ArcGIS geocoder → LLM）。
   * 传入 tiandituKey（如部署环境变量 TIANDITU_SERVER_KEY）后，中文地名
   * 搜索优先走天地图；两级地理编码都无结果时由 LLM 用自身知识兜底。
   */
  placeSearch?: PlaceSearchOptions;

  /**
   * 额外暴露给代理的领域专属 Strands tools（数组或返回数组的工厂函数）。
   */
  customTools?: unknown[] | (() => unknown[]);

  /**
   * 附加的 system 指令，追加在内置 MapLibre 指令之后。
   * 用它教会代理何时以及如何调用自定义工具。
   */
  customSystemPrompt?: string;

  /**
   * 传给 `onAdd` 的地图来自哪个地图库。
   *
   * 绝大多数工具停留在 `maplibre-gl` 与 `mapbox-gl` 共享的 Style Spec 层面；
   * 有四个工具做不到，本字段就是用来如实声明引擎差异的。参见
   * {@link GeoAgentMapEngine}。默认 `maplibre-gl`，已有宿主无需设置；
   * 用 Mapbox GL JS 渲染的宿主传 `{ kind: "mapbox", namespace: mapboxgl }`。
   *
   * Leaflet 宿主传 `{ kind: "leaflet", namespace: L }`；工具随后经兼容 shim
   * 运行（见 `leaflet-engine.ts`），且需用 `addGeoAgentToLeafletMap(control,
   * map)` 挂载控件——Leaflet 没有为外来控件提供 `map.addControl` 槽位。
   *
   * OpenLayers 宿主传 `{ kind: "openlayers", namespace }`，其中 `namespace`
   * 打包了 `OpenLayersNamespace` 列出的 ol 类与辅助函数；工具经兼容 shim
   * 运行（见 `openlayers-engine.ts`），控件用
   * `addGeoAgentToOpenLayersMap(control, map)` 挂载。
   *
   * ArcGIS 宿主（ArcGIS Maps SDK for JavaScript，含 `@arcgis/map-components`
   * web components）传 `{ kind: "arcgis", namespace }`，其中 `namespace`
   * 打包了 `ArcGISNamespace` 列出的 esri 类；工具经兼容 shim 运行（见
   * `arcgis-engine.ts`），控件用 `addGeoAgentToArcGISMap(control, view)` 挂载。
   */
  mapEngine?: GeoAgentMapEngine;
}

/** 任务计划中的单个步骤状态。 */
export type GeoAgentPlanStepStatus = 'pending' | 'in_progress' | 'done' | 'failed';

/** 任务计划中的一个步骤（agent 经 create_plan / update_plan_step 维护）。 */
export interface GeoAgentPlanStep {
  /** 1 起步的稳定步骤编号。 */
  id: number;
  /** 短步骤标题（创建时截断到 120 字符）。 */
  title: string;
  status: GeoAgentPlanStepStatus;
  /** 可选的简短备注（如产出的图层名、失败原因）。 */
  note?: string;
}

/** 多步任务的执行计划快照（经 state.data.plan 暴露给宿主与面板）。 */
export interface GeoAgentPlan {
  steps: GeoAgentPlanStep[];
  /** 最近一次变更的时间戳（epoch 毫秒）。 */
  updatedAt: number;
}

/** 控件的完整运行时状态快照（面板尺寸、provider、模型、权限开关等）。 */
export interface GeoAgentState {
  collapsed: boolean;
  panelWidth: number;
  /** 用户设置的面板高度（像素）；按内容自适应时为 undefined。 */
  panelHeight?: number;
  busy: boolean;
  providerId: GeoAgentProviderId;
  modelId: string;
  /** OpenAI-compatible / Anthropic-compatible provider 的 API base URL。 */
  baseUrl: string;
  allowCodeExecution: boolean;
  allowDestructiveTools: boolean;
  data?: Record<string, unknown>;
}

/** 代理会话中的一行渲染条目。列表由 core 持有；vanilla DOM 面板与 React
 * 面板都通过事件镜像这份列表。 */
export interface GeoAgentConversationEntry {
  readonly id: string;
  readonly role: 'system' | 'user' | 'assistant' | 'tool' | 'error';
  readonly content: string;
  /** assistant 条目带 markdown，走净化后的 markdown 渲染管线；其余条目按纯文本渲染。 */
  readonly markdown?: boolean;
}

/** 应用于会话列表的增量变更（追加、更新或整体重置）。 */
export interface GeoAgentConversationChange {
  type: 'append' | 'update' | 'reset';
  entry?: GeoAgentConversationEntry;
}

/** 面板状态徽标当前展示的文本与类别。 */
export interface GeoAgentStatusState {
  text: string;
  /** 空闲徽标为 'connected' | 'setup'；瞬态徽标为 'error' 等。 */
  kind: string;
  /** 正在展示瞬态状态（Running、Copied 等）时为 true。 */
  transient: boolean;
}

/** 设置区内展示的瞬态配置提示。 */
export interface GeoAgentNoteState {
  text: string;
  kind: 'success' | 'error' | 'info' | null;
}

/** React 包装控件的 props：在 {@link GeoAgentControlOptions} 之上额外要求
 * 地图实例，并可选监听状态变化。 */
export interface GeoAgentControlReactProps extends GeoAgentControlOptions {
  map: Map;
  onStateChange?: (state: GeoAgentState) => void;
}

/** 控件对外派发的事件名：折叠、展开与状态变更。 */
export type GeoAgentControlEvent = 'collapse' | 'expand' | 'statechange';

/** 控件事件回调签名：携带事件类型与最新状态快照。 */
export type GeoAgentControlEventHandler = (event: {
  type: GeoAgentControlEvent;
  state: GeoAgentState;
}) => void;
