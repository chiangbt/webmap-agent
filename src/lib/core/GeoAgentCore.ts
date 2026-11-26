import { cloneSnapshot } from '../utils/snapshot';
/**
 * 无头引擎 GeoAgentCore 的实现：provider 配置与 sessionStorage 持久化、
 * Strands agent 生命周期、会话/状态/提示三路订阅流、system prompt 组装，
 * 以及 prompt 历史。自身不持有任何 DOM，由命令式控件与 React 面板分别渲染。
 */
import {
  Agent,
  type AgentStreamEvent,
  type Model,
  type Tool,
} from '@strands-agents/sdk';
import { t, type GeoAgentMessageKey } from '../i18n';
import { fetchBoundedText } from '../utils/request';
import { resolveMapContainer } from './map-container';
import { validateMapBinding, type GeoAgentMapFor, type GeoAgentMapKind, type GeoAgentOptionsFor } from './map-binding';
import { DEFAULT_BASEMAPS, type GeoAgentTools } from './tools/geoagent-tools';
import { createGeoAgentTools } from './tools/tools-factory';
import type {
  GeoAgentConversationChange,
  GeoAgentConversationEntry,
  GeoAgentControlEvent,
  GeoAgentControlEventHandler,
  GeoAgentControlOptions,
  GeoAgentNoteState,
  GeoAgentProviderConfig,
  GeoAgentProviderId,
  GeoAgentState,
  GeoAgentStatusState,
} from './types';

/** 未指定 defaultProvider 时使用的默认 provider。 */
const DEFAULT_PROVIDER: GeoAgentProviderId = 'openai-compatible';
/** sessionStorage 键的默认前缀。 */
const DEFAULT_STORAGE_PREFIX = 'web-geoagent';
/** 会话持久化的容量上限（条目数），超出时丢弃最旧的条目。 */
const PERSISTED_CONVERSATION_LIMIT = 200;
/** 会话持久化写入的防抖间隔（毫秒），合并流式输出期间的密集更新。 */
const PERSIST_DEBOUNCE_MS = 300;

/**
 * 两个内置 provider 的基础配置（不含 storageKey——它依赖运行时的
 * storagePrefix）；defaultModel 会被宿主的 defaultModel 选项覆盖。
 */
const BASE_PROVIDER_CONFIGS: Record<
  GeoAgentProviderId,
  Omit<GeoAgentProviderConfig, 'storageKey'>
> = {
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI-Compatible (Custom)',
    keyLabel: 'API Key',
    keyPlaceholder: 'sk-... or token',
    // 无默认模型：自定义端点使用自己的模型名，由用户手动填写或从端点加载列表。
    defaultModel: '',
    requiresBaseUrl: true,
    baseUrlPlaceholder: 'https://host/v1',
  },
  'anthropic-compatible': {
    id: 'anthropic-compatible',
    label: 'Anthropic-Compatible (Custom)',
    keyLabel: 'Anthropic API Key',
    keyPlaceholder: 'sk-ant-... or token',
    defaultModel: 'claude-opus-4-8',
    requiresBaseUrl: true,
    baseUrlPlaceholder: 'https://host',
  },
};

/**
 * 浏览器地图 agent 的内置 system prompt 基础段：约定工具工作流（底图/滤镜
 * 工具的选择、Earth Engine 工具优先）、经纬度顺序差异，以及回复风格。
 */
const BROWSER_MAP_SYSTEM_PROMPT = `You are an AI assistant embedded in a browser web app with direct access to a live web map through dedicated browser tools.

Workflow guidance:
- Use browser map tools for map navigation, layer inspection, marker creation, GeoJSON display, layer visibility, feature queries, and screenshots.
- Use add_basemap for requests to add satellite imagery or another raster background, including Google satellite. Use change_basemap only when the user explicitly asks to replace the whole map style.
- When the user asks for Google Earth Engine data, GEE catalog data, SRTM from GEE, Sentinel/Landsat/MODIS/GEE assets, NDVI, or Earth Engine statistics, use the dedicated Earth Engine tools first.
- Do not silently replace a requested Earth Engine layer with unrelated public XYZ, terrain, or basemap tiles. If an Earth Engine tool fails, report the exact tool error and ask for the missing credential/project/asset detail.
- Coordinates in user-facing prompts are latitude/longitude, but browser map internals use longitude/latitude. Use the tool parameter names exactly.
- Do not ask the user to paste JavaScript or run Python for actions that the browser map tools can perform.
- Call search_place whenever the user asks to search for a place or address, or a map operation needs coordinates for a named place or address that has not already been resolved. This includes Chinese addresses, navigation, and adding markers. It searches Tianditu first when configured, followed by the ArcGIS geocoder. Use the result for the requested operation and mention the source. For a search-only request, report candidates without changing the map. If the result source is "llm" (no geocoder matched), only use coordinates you are confident about and state that the location is approximate.
- Keep responses concise and include layer names, locations, and tool results when useful.

Multi-step planning:
- When the user request needs three or more distinct operations (e.g. search a place, load data, render layers, compute statistics), first call create_plan with a short ordered list of steps (2-6 items), then call update_plan_step to mark each step in_progress when starting it and done or failed (with a short note) when finished.
- Do not create a plan for simple single-step requests. When every step is done or failed, summarize the outcome in your final answer.`;

/**
 * 追加到 system prompt 的引擎能力段落，让代理在调用任何工具“之前”就了解
 * 地图的能力边界，而不是事后靠运行时报错得知。maplibre-gl 返回空串——
 * 其能力已由基础 prompt 与完整工具清单描述。
 *
 * 导出仅供测试使用；参数为 `options.mapEngine?.kind`，ArcGIS 宿主另传
 * `options.mapEngine.viewKind`（'map' | 'scene'）。
 */
export function engineCapabilityPrompt(
  engineKind: string | undefined,
  arcgisViewKind?: 'map' | 'scene',
): string {
  // Leaflet：纯 2D 引擎——无 3D/地形/天空/3D 建筑，无截图；pitch/bearing 恒为 0。
  if (engineKind === 'leaflet') {
    return `The live map is rendered by Leaflet, a 2D-only engine. Leaflet cannot render 3D: there is no globe projection, no terrain, no sky, no 3D buildings (fill-extrusion), and no map screenshot; the corresponding tools are not available on this map. Camera pitch and bearing are always 0, and the projection is always Web Mercator. If the user asks for a 3D effect, explain that Leaflet does not support it and offer a 2D alternative instead of attempting workarounds.`;
  }
  // OpenLayers：本集成下为 2D 引擎——能力限制与 Leaflet 类似，bearing 跟随视图旋转。
  if (engineKind === 'openlayers') {
    return `The live map is rendered by OpenLayers, a 2D engine in this integration. It cannot render 3D here: there is no globe projection, no terrain, no sky, no 3D buildings (fill-extrusion), and no map screenshot; the corresponding tools are not available on this map. Camera pitch is always 0 (bearing follows the view rotation), and the projection is always Web Mercator. If the user asks for a 3D effect, explain that the OpenLayers engine does not support it and offer a 2D alternative instead of attempting workarounds.`;
  }
  // ArcGIS SceneView：3D 球体——地形/大气内建，add_terrain/set_sky 不适用；
  // 截图可用，GeoJSON 渲染为贴地的客户端 FeatureLayer，不支持 vector-tile。
  if (engineKind === 'arcgis' && arcgisViewKind === 'scene') {
    return `The live map is rendered by an ArcGIS SceneView — a 3D globe. Terrain comes from the scene's ground elevation layers and the atmosphere is built in, so add_terrain/set_sky are not applicable and will report errors. Camera bearing follows the camera heading and pitch follows the camera tilt; screenshot_map IS supported and composites the globe. GeoJSON renders as client-side FeatureLayers draped on the globe; vector-tile sources are not supported. fly_to moves the camera while keeping its tilt. For SceneView-specific camera work (heading/tilt targets), write ArcGIS Maps SDK code with run_maplibre_script.`;
  }
  // ArcGIS MapView：2D 引擎——无 3D 但支持截图；GeoJSON 渲染为逐要素符号的
  // FeatureLayer，不支持 vector-tile 与 image source。
  if (engineKind === 'arcgis') {
    return `The live map is rendered by the ArcGIS Maps SDK for JavaScript (MapView, a 2D engine). It cannot render 3D here: there is no globe projection, no terrain, no sky, and no 3D buildings (fill-extrusion); the corresponding tools report errors. Camera pitch is always 0 (bearing follows the view rotation), and the projection is Web Mercator. GeoJSON renders as client-side FeatureLayers with per-feature symbols; vector-tile and image sources are not supported. Map screenshots ARE supported on this engine (screenshot_map composites the view). If the user asks for a 3D effect, explain that the ArcGIS MapView engine does not support it and offer a 2D alternative instead of attempting workarounds.`;
  }
  // Mapbox GL JS：仅 sky 工具不可用（Mapbox 经 style layer 绘制天空）。
  if (engineKind === 'mapbox') {
    return `The live map is rendered by Mapbox GL JS. Sky specification tools are not supported by Mapbox GL JS (it draws sky through a style layer) and will report an error.`;
  }
  return '';
}

/**
 * system prompt 的代码执行段落。按引擎感知生成：代码片段拿到的绑定与模型
 * 应写的 API 因引擎而异——Leaflet 下代码拿到真实的 L.Map 与 L 命名空间，
 * OpenLayers 下拿到真实的 ol/Map 与 ol 命名空间，此时写 MapLibre 调用会失败。
 *
 * 导出仅供测试使用；参数为 `options.mapEngine?.kind`。
 */
export function codeExecutionPrompt(
  engineKind: string | undefined,
  arcgisViewKind?: 'map' | 'scene',
): string {
  // 基础声明：该工具在页面上下文执行任意 JS，不是安全边界，仅限本地受信场景。
  const base = `Browser JavaScript code execution is enabled for this local session. This tool runs arbitrary JavaScript in the page context and is not a safety boundary; treat it as a trusted, local-only escape hatch.`;
  // 护栏：代码只做地图操作，不碰凭据、storage、无关 DOM 与大范围网络请求。
  const guardrails = `Keep code focused on map operations, and avoid credential handling, storage access, unrelated DOM manipulation, or broad network operations.`;
  // Leaflet：作用域注入真实的 L.Map 与 L 命名空间，要求模型写 Leaflet API。
  if (engineKind === 'leaflet') {
    return `${base}

When no dedicated browser map tool can perform the requested operation, write a short JavaScript snippet and run it with run_maplibre_script. The snippet executes in the browser with these names in scope: map (the real Leaflet L.Map), L (the Leaflet namespace), and helpers. Write Leaflet API code — this map is not MapLibre, and MapLibre calls will fail. ${guardrails}`;
  }
  // OpenLayers：作用域注入真实的 ol/Map 与 ol 命名空间对象。
  if (engineKind === 'openlayers') {
    return `${base}

When no dedicated browser map tool can perform the requested operation, write a short JavaScript snippet and run it with run_maplibre_script. The snippet executes in the browser with these names in scope: map (the real OpenLayers ol/Map), ol (the OpenLayers namespace object), and helpers. Write OpenLayers API code — this map is not MapLibre, and MapLibre calls will fail. ${guardrails}`;
  }
  // ArcGIS：按 viewKind 注入真实的 MapView/SceneView 与经 mapEngine 传入的 esri 类。
  if (engineKind === 'arcgis') {
    const viewName = arcgisViewKind === 'scene' ? 'ArcGIS SceneView' : 'ArcGIS MapView';
    return `${base}

When no dedicated browser map tool can perform the requested operation, write a short JavaScript snippet and run it with run_maplibre_script. The snippet executes in the browser with these names in scope: map (the real ${viewName}), esri (the namespace classes passed via mapEngine), and helpers. Write ArcGIS Maps SDK code — this map is not MapLibre, and MapLibre calls will fail. ${guardrails}`;
  }
  // MapLibre/Mapbox：注入 map 与对应的全局命名空间（maplibregl / mapboxgl）。
  const api = engineKind === 'mapbox' ? 'Mapbox GL JS' : 'MapLibre GL JS';
  const namespaceName = engineKind === 'mapbox' ? 'mapboxgl' : 'maplibregl';
  return `${base}

When no dedicated browser map tool can perform the requested ${api} operation, write a short JavaScript snippet and run it with run_maplibre_script. The snippet executes in the browser with these names in scope: map, ${namespaceName}, and helpers. Prefer ${api} API calls, ${guardrails.toLowerCase()}`;
}

/** 从 sessionStorage 读取值；不可用（如隐私模式）或键不存在时返回 null。 */
function storageGet(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 向 sessionStorage 写入值；失败静默忽略。 */
function storageSet(key: string, value: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // 忽略隐私模式等受限浏览器环境下的 storage 写入失败。
  }
}

/** 从 sessionStorage 移除值；失败静默忽略。 */
function storageRemove(key: string): void {
  try {
    globalThis.sessionStorage?.removeItem(key);
  } catch {
    // 忽略隐私模式等受限浏览器环境下的 storage 写入失败。
  }
}

/** 从 localStorage 读取值；不可用（如隐私模式）或键不存在时返回 null。 */
function localGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 向 localStorage 写入值；失败静默忽略（隐私模式、配额超限等）。 */
function localSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // 忽略受限浏览器环境下的写入失败。
  }
}

/** 从 localStorage 移除值；失败静默忽略。 */
function localRemove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // 忽略受限浏览器环境下的移除失败。
  }
}

/** 返回第一个 trim 后非空的值；全部为空时返回空字符串。 */
function firstValue(...values: Array<string | undefined | null>): string {
  return values.find((value) => value?.trim())?.trim() ?? '';
}

/**
 * 解析某 provider 的默认模型。
 *
 * @param providerId provider 标识
 * @param defaultModel 宿主的 defaultModel 选项：全局字符串、按 provider 的
 *   映射，或 undefined
 * @returns 生效的默认模型 ID；宿主值缺省或为空时回退到 provider 自身默认值
 */
function defaultModelFor(
  providerId: GeoAgentProviderId,
  defaultModel: GeoAgentControlOptions['defaultModel'],
): string {
  const providerDefault = BASE_PROVIDER_CONFIGS[providerId].defaultModel;
  if (defaultModel === undefined) {
    return providerDefault;
  }
  // 空字符串（或空的按 provider 条目）表示“宿主没有默认模型”（如未设置的
  // 环境变量），回退到 provider 自身默认值。
  if (typeof defaultModel === 'string') {
    return defaultModel || providerDefault;
  }
  return defaultModel[providerId] || providerDefault;
}

/** 把角色名转成“首字母大写、其余小写”的展示标题（如 markdown 导出用）。 */
function markdownHeading(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
}

/** 日志消息用的地图引擎展示名，按 `mapEngine.kind` 索引。 */
const ENGINE_LABELS: Record<string, string> = {
  maplibre: 'MapLibre',
  mapbox: 'Mapbox GL JS',
  leaflet: 'Leaflet',
  openlayers: 'OpenLayers',
  arcgis: 'ArcGIS Maps SDK',
};

/** 会话条目自增计数器，用于生成模块内唯一的 entry id。 */
let conversationEntryCount = 0;

/** 生成下一个会话条目 id（形如 geoagent-entry-N）。 */
function generateEntryId(): string {
  conversationEntryCount += 1;
  return `geoagent-entry-${conversationEntryCount}`;
}

/** 会话变更订阅回调：携带增量变更与全量条目快照。 */
type ConversationHandler = (
  change: GeoAgentConversationChange,
  entries: GeoAgentConversationEntry[],
) => void;
/** 状态徽标变更订阅回调。 */
type StatusHandler = (status: GeoAgentStatusState) => void;
/** 配置提示变更订阅回调。 */
type NoteHandler = (note: GeoAgentNoteState) => void;

/** 通用事件（collapse/expand/statechange）到处理器集合的映射表。 */
type EventHandlersMap = globalThis.Map<
  GeoAgentControlEvent,
  Set<GeoAgentControlEventHandler>
>;

/**
 * 无头 GeoAgent 引擎：provider 配置与持久化、Strands agent 生命周期、
 * 会话状态与 prompt 历史——自身不持有任何 DOM。命令式面板
 * {@link GeoAgentControl} 与 React 面板 {@link GeoAgentPanel} 都从这份核心
 * 渲染。
 *
 * 生命周期：先以选项构造，再调用 {@link attach} 绑定地图（`mapEngine` 支持
 * 的任意引擎），随后通过各 setter 方法驱动，结束时调用 {@link dispose}。
 * 会话、状态徽标与配置提示的变更分别经 `onConversation` / `onStatus` /
 * `onNote` 订阅推送。
 */
export class GeoAgentCore<K extends GeoAgentMapKind = 'maplibre'> {
  readonly mapEngineKind: K;
  /**
   * 归一化后的完整选项：缺省项已填默认值；仅 defaultModel、basemaps、
   * earthEngine、apiKeys、panelHeight、customTools、customSystemPrompt、
   * mapEngine 允许保持 undefined（工具层会自行兜底）。
   */
  readonly options: Required<
    Omit<
      GeoAgentControlOptions,
      | 'defaultModel'
      | 'basemaps'
      | 'geoJsonLimits'
      | 'earthEngine'
      | 'apiKeys'
      | 'panelHeight'
      | 'customTools'
      | 'customSystemPrompt'
      | 'placeSearch'
      | 'mapEngine'
    >
  > &
    Pick<
      GeoAgentControlOptions,
      | 'defaultModel'
      | 'basemaps'
      | 'geoJsonLimits'
      | 'earthEngine'
      | 'apiKeys'
      | 'panelHeight'
      | 'customTools'
      | 'customSystemPrompt'
      | 'placeSearch'
      // 无默认值：工具会回退到本包自带的 maplibre-gl。
      | 'mapEngine'
    >;
  /** 当前绑定的地图实例（attach 后存在；非 MapLibre 引擎时也由此字段承载）。 */
  private mapInstance?: GeoAgentMapFor<K>;
  private arcgisViewKind?: 'map' | 'scene';
  /** 地图 DOM 容器，用于面板高度钳制等布局计算。 */
  private mapContainer?: HTMLElement;
  /** 与当前地图绑定的工具集（attach 时创建，detach/重挂载时销毁）。 */
  private tools?: GeoAgentTools;
  /** 缓存的 Strands Agent 实例；配置变化后失效为 null，下次运行时重建。 */
  private agent: Agent | null = null;
  /** 创建当前 agent 时的配置签名，用于判断缓存实例是否仍然有效。 */
  private agentSignature = '';
  /** 流式输出进行中的 assistant 条目 id；null 表示本轮流式输出尚未开始。 */
  private streamingEntryId: string | null = null;
  /** 本轮流式输出累计的 assistant 文本。 */
  private streamingAssistantText = '';
  /**
   * 相邻工具调用的合并行条目 id；null 表示当前没有未定稿的合并组。
   * 运行中该行展示「正在执行工具（第 N 步）」，定稿后展开为逐条详情。
   */
  private toolRunEntryId: string | null = null;
  /** 当前合并组内已执行的工具名序列（按调用顺序）。 */
  private toolRunCalls: Array<{
    id?: string; name: string; startedAt: number; elapsedMs?: number;
    status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
    error?: string;
  }> = [];
  /** 会话条目列表（核心持有；UI 层经事件镜像，core 不依赖 UI）。 */
  private entries: GeoAgentConversationEntry[] = [];
  /** 已发送 prompt 的历史（ArrowUp/ArrowDown 导航用）。 */
  private promptHistory: string[] = [];
  /** 当前历史导航位置；-1 表示不在导航状态。 */
  private promptHistoryIndex = -1;
  /** 进入历史导航前输入框中的草稿，导航越过历史末尾时恢复。 */
  private promptHistoryDraft = '';
  /** 控件运行时状态（折叠、尺寸、provider、模型、权限开关等）。 */
  private state: GeoAgentState;
  /** 通用事件（collapse/expand/statechange）的订阅处理器集合。 */
  private eventHandlers: EventHandlersMap = new globalThis.Map();
  /** 会话变更订阅者。 */
  private conversationHandlers = new Set<ConversationHandler>();
  /** 状态徽标变更订阅者。 */
  private statusHandlers = new Set<StatusHandler>();
  /** 配置提示变更订阅者。 */
  private noteHandlers = new Set<NoteHandler>();
  /** 当前运行的中止控制器，用于取消进行中的模型请求。 */
  private activeAbortController: AbortController | null = null;
  /** 用户已请求取消但取消尚未落定的标记。 */
  private cancelRequested = false;
  // 代理实际使用的 API key。仅在用户提交 key 输入框（Enter 或失焦）时更新，
  // 不随每次键入更新，避免输入到一半的 key 把徽标翻成 "Ready" 或写入 storage。
  private committedApiKey = '';
  /** 配置提示自动隐藏的定时器。 */
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  /** 复制成功徽标恢复空闲状态的定时器。 */
  private statusCopyTimer: ReturnType<typeof setTimeout> | null = null;
  // 当前展示的空闲状态徽标类别（'connected' | 'setup'）；瞬态状态（Running、
  // Cancelled、Error、Copied）展示期间为 null。按类别而非文本比较，保证空闲
  // 状态在所有 locale 下都正常工作。
  private idleStatusKind: 'connected' | 'setup' | null = null;
  /** 当前状态徽标内容。 */
  private status: GeoAgentStatusState = {
    text: '',
    kind: '',
    transient: false,
  };
  /** 当前配置提示内容。 */
  private note: GeoAgentNoteState = { text: '', kind: null };
  /** 会话持久化的防抖定时器；null 表示没有排队中的写入。 */
  private conversationPersistTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 构造无头引擎：归一化选项（填默认值）并初始化 provider/model/baseUrl 等
   * 运行时状态；此时不触碰 DOM，也不创建工具与 agent。
   *
   * @param options 宿主传入的可配置项，全部可省略
   */
  constructor(options: GeoAgentOptionsFor<K> | ('maplibre' extends K ? undefined : never));
  constructor(...args: 'maplibre' extends K ? [] : [never]);
  constructor(options: GeoAgentControlOptions = {}) {
    this.mapEngineKind = (options.mapEngine?.kind ?? 'maplibre') as K;
    // 逐项补默认值，得到完整、可直接读取的 options（此后 core 内部不再判空）。
    this.options = {
      collapsed: options.collapsed ?? true,
      position: options.position ?? 'top-right',
      title: options.title ?? 'GeoAgent',
      locale: options.locale ?? 'en',
      panelWidth: options.panelWidth ?? 390,
      panelMinWidth: options.panelMinWidth ?? 320,
      panelMaxWidth: options.panelMaxWidth ?? 720,
      panelHeight: options.panelHeight,
      panelMinHeight: options.panelMinHeight ?? 320,
      panelMaxHeight: options.panelMaxHeight ?? 2000,
      className: options.className ?? '',
      defaultProvider: options.defaultProvider ?? DEFAULT_PROVIDER,
      storagePrefix: options.storagePrefix ?? DEFAULT_STORAGE_PREFIX,
      persistConversation: options.persistConversation ?? false,
      // 部署级兜底值（如宿主应用从 .env 注入）。
      defaultApiKey: options.defaultApiKey ?? '',
      defaultBaseUrl: options.defaultBaseUrl ?? '',
      // 任意 JS 执行工具默认关闭：new Function 并非安全沙箱，片段可访问
      // document/sessionStorage（含 API key）。宿主必须显式 opt-in。
      allowCodeExecutionDefault: options.allowCodeExecutionDefault ?? false,
      allowDestructiveToolsDefault: options.allowDestructiveToolsDefault ?? true,
      showPermissionToggles: options.showPermissionToggles ?? false,
      defaultModel: options.defaultModel,
      apiKeys: options.apiKeys,
      basemaps: options.basemaps,
      geoJsonLimits: options.geoJsonLimits,
      earthEngine: options.earthEngine,
      customTools: options.customTools,
      customSystemPrompt: options.customSystemPrompt,
      placeSearch: options.placeSearch,
      mapEngine: options.mapEngine,
    };
    // 初始 provider 优先取存储偏好；其余状态按该 provider 的存储值/默认值填充。
    const providerId = this.initialProviderId();
    this.state = {
      collapsed: this.options.collapsed,
      panelWidth: this.constrainPanelWidth(this.options.panelWidth),
      panelHeight:
        this.options.panelHeight !== undefined
          ? this.constrainPanelHeight(this.options.panelHeight)
          : undefined,
      busy: false,
      providerId,
      modelId: this.initialModelId(providerId),
      baseUrl: this.initialBaseUrl(providerId),
      allowCodeExecution: this.options.allowCodeExecutionDefault,
      allowDestructiveTools: this.options.allowDestructiveToolsDefault,
      data: {},
    };
    // 选项开启持久化时，从 localStorage 恢复上次会话条目。
    this.restorePersistedConversation();
  }

  // ---------------------------------------------------------------- 生命周期

  /**
   * 把核心绑定到地图。创建与引擎匹配的 agent 工具（地图经参数交给工具）、
   * 读取持久化的 provider 设置，并追加就绪/缺配置的系统日志条目。
   */
  attach(map: GeoAgentMapFor<K>): void {
    const arcgisViewKind = validateMapBinding(map, this.options.mapEngine);
    // MapLibre/Mapbox/Leaflet 宿主暴露 getContainer()；OpenLayers 地图暴露
    // getTargetElement()；ArcGIS MapView 暴露 `container` 属性——
    // resolveMapContainer 全部兼容，保证覆盖层与高度钳制在每种引擎下都有容器。
    const mapContainer = resolveMapContainer(map);
    if (!mapContainer) {
      throw new Error(
        'GeoAgentControl: the map exposes neither getContainer() nor getTargetElement() nor a container element; cannot mount the agent panel.',
      );
    }
    // 校验新实例后再解除旧绑定，错误的地图不影响当前运行。
    this.detach();
    // 创建工具集：权限开关经 getter 回调读取（工具每次调用都拿到最新值），
    // 工具产生的 data 变更合并回状态并广播 statechange。
    this.tools = createGeoAgentTools(map, {
      basemaps: { ...DEFAULT_BASEMAPS, ...this.options.basemaps },
      geoJsonLimits: this.options.geoJsonLimits,
      allowCodeExecution: () => this.state.allowCodeExecution,
      allowDestructiveTools: () => this.state.allowDestructiveTools,
      earthEngine: this.options.earthEngine,
      placeSearch: this.options.placeSearch,
      mapEngine: this.options.mapEngine,
      onStateDataChange: (data) => {
        this.state.data = { ...(this.state.data ?? {}), ...data };
        this.emit('statechange');
      },
    });
    this.mapInstance = map;
    this.mapContainer = mapContainer;
    this.arcgisViewKind = arcgisViewKind;
    this.loadProviderSettings();
    // 工具集已重建：强制失效缓存的 agent，避免旧 agent 继续持有已销毁的
    // 工具集（其签名不含 tools 标识，单靠签名比对不会触发重建）。
    this.invalidateAgent();
    this.applyIdleStatus(true);
    this.appendEntry('system', this.readyLogMessage());
  }

  /** 取消旧运行并解除地图绑定；保留会话与订阅，允许重新 attach。 */
  detach(): void {
    const hadBinding = !!this.tools || !!this.activeAbortController;
    this.activeAbortController?.abort();
    this.agent?.cancel();
    this.activeAbortController = null;
    this.cancelRequested = false;
    this.finalizeToolRun('cancelled');
    this.state.busy = false;
    this.streamingEntryId = null;
    this.streamingAssistantText = '';
    this.toolRunEntryId = null;
    this.toolRunCalls = [];
    this.invalidateAgent();
    this.tools?.destroy();
    this.tools = undefined;
    this.mapInstance = undefined;
    this.mapContainer = undefined;
    this.arcgisViewKind = undefined;
    if (hadBinding) {
      this.applyIdleStatus(true);
      this.emit('statechange');
    }
  }

  /** 完整销毁：中止进行中的运行、解除地图绑定、清空全部监听器与定时器。 */
  dispose(): void {
    this.eventHandlers.clear();
    this.conversationHandlers.clear();
    this.statusHandlers.clear();
    this.noteHandlers.clear();
    // detach 中止运行并销毁工具；先清监听器以免销毁时更新已卸载的 UI。
    this.detach();
    // 清掉两个可能仍在排队的定时器，避免销毁后回调触碰已清理的状态。
    if (this.noteTimer !== null) {
      clearTimeout(this.noteTimer);
      this.noteTimer = null;
    }
    if (this.statusCopyTimer !== null) {
      clearTimeout(this.statusCopyTimer);
      this.statusCopyTimer = null;
    }
    // 会话持久化的待写队列：销毁前立即落盘，避免丢最后一次变更。
    if (this.conversationPersistTimer !== null) {
      clearTimeout(this.conversationPersistTimer);
      this.conversationPersistTimer = null;
      this.persistConversationNow();
    }
    this.promptHistory = [];
    this.promptHistoryIndex = -1;
    this.promptHistoryDraft = '';
  }

  /** 返回当前绑定的地图实例；未 attach 时为 undefined。 */
  getMap(): GeoAgentMapFor<K> | undefined {
    return this.mapInstance;
  }

  /** 返回与引擎绑定的工具集；`attach` 之前为 undefined。 */
  getTools(): GeoAgentTools | undefined {
    return this.tools;
  }

  /** 返回内部 state 的活引用（未拷贝），供 UI 层在每次渲染时直接读取。 */
  peekState(): GeoAgentState {
    return this.state;
  }

  // ------------------------------------------------------------------ 事件

  /** 订阅通用事件（collapse/expand/statechange）。 */
  on(event: GeoAgentControlEvent, handler: GeoAgentControlEventHandler): void {
    // 按事件名惰性建集合；同一 handler 会被 Set 去重。
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /** 取消通用事件订阅。 */
  off(event: GeoAgentControlEvent, handler: GeoAgentControlEventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /** 订阅会话变更流（append/update/reset 增量 + 全量条目快照）。 */
  onConversation(handler: ConversationHandler): void {
    this.conversationHandlers.add(handler);
  }

  /** 取消会话变更订阅。 */
  offConversation(handler: ConversationHandler): void {
    this.conversationHandlers.delete(handler);
  }

  /** 订阅状态徽标变更流。 */
  onStatus(handler: StatusHandler): void {
    this.statusHandlers.add(handler);
  }

  /** 取消状态徽标订阅。 */
  offStatus(handler: StatusHandler): void {
    this.statusHandlers.delete(handler);
  }

  /** 订阅配置提示变更流。 */
  onNote(handler: NoteHandler): void {
    this.noteHandlers.add(handler);
  }

  /** 取消配置提示订阅。 */
  offNote(handler: NoteHandler): void {
    this.noteHandlers.delete(handler);
  }

  /** 向对应事件的全部订阅者派发（附最新状态快照）。 */
  private emit(event: GeoAgentControlEvent): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) {
      return;
    }
    handlers.forEach((handler) => handler({ type: event, state: this.getState() }));
  }

  /** 向会话订阅者广播增量变更；每次都附上全量条目快照便于整体重绘。 */
  private emitConversation(change: GeoAgentConversationChange): void {
    this.conversationHandlers.forEach((handler) => handler({ ...change }, this.getConversation()));
  }

  /** 向状态订阅者广播最新徽标内容。 */
  private emitStatus(): void {
    const status = this.getStatus();
    this.statusHandlers.forEach((handler) => handler(status));
  }

  /** 向配置提示订阅者广播最新提示内容（拷贝快照）。 */
  private emitNote(): void {
    const note = { ...this.note };
    this.noteHandlers.forEach((handler) => handler(note));
  }

  // ------------------------------------------------------------------- 状态

  /** 独立复制 data 的普通对象/数组；SDK/DOM 实例等不透明句柄保留引用。 */
  getState(): GeoAgentState {
    return {
      ...this.state,
      data: cloneSnapshot(this.state.data ?? {}),
    };
  }

  /**
   * 合并部分状态。面板尺寸值会被钳制；provider、model 与代码执行开关的
   * 变化会使缓存的 agent 失效；折叠变化会派发 expand/collapse 事件。
   * DOM 副作用归 UI 层负责。
   */
  setState(newState: Partial<GeoAgentState>): void {
    if (
      newState.providerId !== undefined &&
      !Object.prototype.hasOwnProperty.call(BASE_PROVIDER_CONFIGS, newState.providerId)
    ) {
      return;
    }
    const providerChanged =
      newState.providerId !== undefined && newState.providerId !== this.state.providerId;
    // 先基于旧值记录两类变化：折叠翻转（要发事件）、agent 相关配置变化（要失效缓存）。
    const collapsedChanged =
      newState.collapsed !== undefined && newState.collapsed !== this.state.collapsed;
    const agentInvalidating =
      (newState.providerId !== undefined && newState.providerId !== this.state.providerId) ||
      (newState.modelId !== undefined && newState.modelId !== this.state.modelId) ||
      (newState.allowCodeExecution !== undefined &&
        newState.allowCodeExecution !== this.state.allowCodeExecution);
    if (providerChanged) {
      this.state.providerId = newState.providerId!;
      storageSet(`${this.options.storagePrefix}.provider`, this.state.providerId);
      this.loadProviderSettings();
      this.hideNote();
    }
    // 显式 model/baseUrl 覆盖新 provider 的默认值，凭据始终取新 provider。
    this.state = { ...this.state, ...newState,
      ...(newState.data !== undefined ? { data: cloneSnapshot(newState.data) } : {}),
    };
    // 尺寸值先经 clamp，保证面板尺寸永远落在 min/max 区间内。
    if (newState.panelWidth !== undefined) {
      this.state.panelWidth = this.constrainPanelWidth(newState.panelWidth);
    }
    if (newState.panelHeight !== undefined) {
      this.state.panelHeight = this.constrainPanelHeight(newState.panelHeight);
    }
    if (collapsedChanged) {
      if (this.state.collapsed) {
        this.emit('collapse');
      } else {
        this.emit('expand');
      }
    }
    if (agentInvalidating) {
      this.invalidateAgent();
    }
    if (providerChanged) this.applyIdleStatus(true);
    this.emit('statechange');
  }

  /** 切换面板折叠状态。 */
  toggle(): void {
    this.setState({ collapsed: !this.state.collapsed });
  }

  /** 展开面板；已展开时无操作。 */
  expand(): void {
    if (this.state.collapsed) {
      this.toggle();
    }
  }

  /** 折叠面板；已折叠时无操作。 */
  collapse(): void {
    if (!this.state.collapsed) {
      this.toggle();
    }
  }

  // -------------------------------------------------------------- i18n 文案

  /** 按本核心的 locale 返回本地化 UI 文案。 */
  translate(key: GeoAgentMessageKey, params?: Record<string, string | number>): string {
    return t(this.options.locale, key, params);
  }

  /** 会话日志角色的展示标签，遵循核心的 locale；未知角色回退为首字母大写。 */
  roleLabel(role: string): string {
    const known: Record<string, GeoAgentMessageKey> = {
      system: 'roleSystem',
      user: 'roleUser',
      assistant: 'roleAssistant',
      tool: 'roleTool',
      error: 'roleError',
    };
    const key = known[role];
    return key ? this.translate(key) : markdownHeading(role);
  }

  /** 指定 provider 的本地化 API key 字段标签。 */
  localizedApiKeyLabel(providerId: GeoAgentProviderId): string {
    const key: GeoAgentMessageKey =
      providerId === 'anthropic-compatible'
        ? 'keyLabelAnthropic'
        : 'keyLabelGeneric';
    return this.translate(key);
  }

  /** 输入框被锁定时 prompt 字段展示的占位提示（列出还缺哪些配置项）。 */
  blockedPromptHint(configured: boolean): string {
    const missing = configured ? '' : this.missingConfigSummary();
    return missing
      ? this.translate('hintAddMissingToStart', { missing })
      : this.translate('hintConfigureProvider');
  }

  /** 配置未完成时 Send 按钮的 tooltip 提示。 */
  sendBlockedHint(): string {
    const missing = this.missingConfigSummary();
    return missing
      ? this.translate('hintAddMissingToSend', { missing })
      : this.translate('hintConfigRequiredToSend');
  }

  // -------------------------------------------------------------- provider 配置

  /** 返回两个内置 provider 的完整配置（含按 storagePrefix 派生的 storageKey）。 */
  providerConfigs(): Record<GeoAgentProviderId, GeoAgentProviderConfig> {
    return {
      'openai-compatible': this.providerConfig('openai-compatible'),
      'anthropic-compatible': this.providerConfig('anthropic-compatible'),
    };
  }

  /** 返回单个 provider 的配置：基础配置 + 派生 storageKey + 生效的默认模型。 */
  providerConfig(providerId: GeoAgentProviderId): GeoAgentProviderConfig {
    const base = BASE_PROVIDER_CONFIGS[providerId];
    return {
      ...base,
      // API key 的 sessionStorage 键按 provider 隔离，避免切换 provider 时串键。
      storageKey: `${this.options.storagePrefix}.${providerId}.api_key`,
      defaultModel: defaultModelFor(providerId, this.options.defaultModel),
    };
  }

  /** 当前 provider 的 API key 标签与 placeholder（供输入框装饰）。 */
  currentApiKeyChrome(): { label: string; placeholder: string } {
    const provider = this.providerConfig(this.state.providerId);
    return {
      label: this.localizedApiKeyLabel(provider.id),
      placeholder: provider.keyPlaceholder,
    };
  }

  /** 初始 provider：优先取 sessionStorage 中已保存的偏好，无效时用宿主默认值。 */
  private initialProviderId(): GeoAgentProviderId {
    const storedProvider = storageGet(`${this.options.storagePrefix}.provider`);
    if (storedProvider && storedProvider in BASE_PROVIDER_CONFIGS) {
      return storedProvider as GeoAgentProviderId;
    }
    return this.options.defaultProvider;
  }

  /** 初始模型 ID：存储值优先，其次宿主 defaultModel，最后 provider 默认值。 */
  private initialModelId(providerId: GeoAgentProviderId): string {
    return (
      storageGet(this.modelStorageKey(providerId)) ||
      defaultModelFor(providerId, this.options.defaultModel)
    );
  }

  /** 某 provider 的模型 ID 在 sessionStorage 中的键。 */
  private modelStorageKey(providerId: GeoAgentProviderId): string {
    return `${this.options.storagePrefix}.model.${providerId}`;
  }

  /** 某 provider 的 base URL 在 sessionStorage 中的键。 */
  private baseUrlStorageKey(providerId: GeoAgentProviderId): string {
    return `${this.options.storagePrefix}.baseUrl.${providerId}`;
  }

  /** 初始 base URL：存储值优先，其次宿主的 defaultBaseUrl 兜底。 */
  private initialBaseUrl(providerId: GeoAgentProviderId): string {
    return (
      storageGet(this.baseUrlStorageKey(providerId)) ||
      this.options.defaultBaseUrl
    );
  }

  /** Earth Engine 项目 ID 在 sessionStorage 中的键。 */
  private earthEngineProjectIdStorageKey(): string {
    return `${this.options.storagePrefix}.earthEngine.projectId`;
  }

  /**
   * 从 sessionStorage 读取当前 provider 的持久化设置（模型、已提交 API key、
   * base URL）。宿主传入的 `apiKeys` 与部署级 `defaultApiKey`/`defaultBaseUrl`
   * 兜底值（如宿主从 .env 注入）填补 storage 缺失的部分，且这里不会把它们
   * 写入 storage。
   */
  loadProviderSettings(): void {
    const provider = this.providerConfig(this.state.providerId);
    // 宿主 key 优先级：provider 专属 apiKeys > 部署级 defaultApiKey；
    // 仅当 storage 没有保存过 key 时才作为 committedApiKey 生效。
    const initialApiKey =
      this.options.apiKeys?.[provider.id]?.trim() ||
      this.options.defaultApiKey;
    this.state.modelId =
      storageGet(this.modelStorageKey(provider.id)) || provider.defaultModel;
    this.committedApiKey = storageGet(provider.storageKey) || initialApiKey;
    this.state.baseUrl = this.initialBaseUrl(provider.id);
  }

  /** 切换 provider：持久化选择并重新加载该 provider 的存储设置。 */
  switchProvider(providerId: GeoAgentProviderId): void {
    this.setState({ providerId });
  }

  /** 设置模型 ID：写入/清除存储，失效 agent 并刷新空闲徽标。 */
  setModelId(value: string): void {
    const modelId = value.trim();
    this.state.modelId = modelId;
    // 空值视为“清除已保存模型”，从 storage 移除而不是存空串。
    if (modelId) {
      storageSet(this.modelStorageKey(this.state.providerId), modelId);
    } else {
      storageRemove(this.modelStorageKey(this.state.providerId));
    }
    this.invalidateAgent();
    // 刷新空闲徽标（瞬态状态展示期间是 no-op），与命令式面板
    // updateControls() -> applyIdleStatus() 的链路保持一致。
    this.applyIdleStatus();
    this.emit('statechange');
  }

  /** 设置 base URL：写入/清除存储，失效 agent 并刷新空闲徽标。 */
  setBaseUrl(value: string): void {
    const baseUrl = value.trim();
    this.state.baseUrl = baseUrl;
    // 与模型 ID 相同的约定：清空输入即移除存储值。
    if (baseUrl) {
      storageSet(this.baseUrlStorageKey(this.state.providerId), baseUrl);
    } else {
      storageRemove(this.baseUrlStorageKey(this.state.providerId));
    }
    this.invalidateAgent();
    this.applyIdleStatus();
    this.emit('statechange');
  }

  /** 切换代码执行工具开关；该配置影响 system prompt，需失效缓存的 agent。 */
  setAllowCodeExecution(checked: boolean): void {
    this.state.allowCodeExecution = checked;
    this.invalidateAgent();
    this.emit('statechange');
  }

  /** 切换破坏性工具开关；工具经回调实时读取该值，无需失效 agent。 */
  setAllowDestructiveTools(checked: boolean): void {
    this.state.allowDestructiveTools = checked;
    this.emit('statechange');
  }

  /** 响应 API key 输入框的编辑中状态，但不提交（不写 storage、不生效）。 */
  setApiKeyEdited(value: string): void {
    const apiKey = value.trim();
    // 与已提交值不同的非空输入提示按 Enter 保存；清空输入则收起提示。
    if (apiKey && apiKey !== this.committedApiKey) {
      this.showNote(this.translate('notePressEnterToSaveKey'), 'info', false);
    } else if (!apiKey) {
      this.hideNote();
    }
  }

  /** 提交（持久化）输入的 API key 并刷新连接状态。 */
  commitApiKey(value: string): void {
    const apiKey = value.trim();
    // 幂等：与已提交值相同（React 面板每次 blur 都会提交）时不重写
    // storage、不失效 agent、不重复弹提示。
    if (apiKey === this.committedApiKey) {
      return;
    }
    this.committedApiKey = apiKey;
    const storageKey = this.providerConfig(this.state.providerId).storageKey;
    // 有值写入 storage；清空则移除，回到宿主兜底值/空的状态。
    if (apiKey) {
      storageSet(storageKey, apiKey);
    } else {
      storageRemove(storageKey);
    }
    this.invalidateAgent();
    if (apiKey) {
      this.showNote(this.translate('noteApiKeySaved'), 'success', true);
    } else {
      this.hideNote();
    }
    // key 提交可能改变 Ready/Setup 结论，强制刷新空闲徽标。
    this.applyIdleStatus(true);
    this.emit('statechange');
  }

  /** 代理实际使用的 API key（已提交值，而非输入框的实时内容）。 */
  getCommittedApiKey(): string {
    return this.committedApiKey;
  }

  /** 应用当前 provider 的默认模型（“Use latest” 按钮）。无默认模型时提示并返回 false。 */
  applyLatestModel(): boolean {
    const latestModel = this.providerConfig(this.state.providerId).defaultModel;
    // 自定义端点没有内置默认模型，提示用户手填模型 ID。
    if (!latestModel) {
      this.showNote(this.translate('noteEnterCustomModelId'), 'info', true);
      return false;
    }
    this.setModelId(latestModel);
    this.showNote(
      this.translate('noteUsingLatestModel', { model: latestModel }),
      'success',
      true,
    );
    return true;
  }

  /**
   * 从当前 provider 的兼容端点拉取可用模型 ID 列表。
   * OpenAI 兼容端点走 `GET {base}/models`（Bearer 鉴权）；
   * Anthropic 兼容端点走 `GET {base}/v1/models`（x-api-key 鉴权）。
   * 请求带 15 秒超时与 2 MiB 响应上限；缺少 key 或 base URL、请求失败或
   * 响应不符合约定结构时，抛出本地化错误信息供面板直接展示。
   */
  async fetchAvailableModels(): Promise<string[]> {
    const providerId = this.state.providerId;
    const apiKey = this.committedApiKey.trim();
    const baseUrl = this.normalizeBaseUrl(this.state.baseUrl);
    if (!apiKey || !baseUrl) {
      throw new Error(this.translate('noteModelsNeedConfig'));
    }
    const url =
      providerId === 'anthropic-compatible'
        ? `${baseUrl}/v1/models`
        : `${baseUrl}/models`;
    const headers: Record<string, string> =
      providerId === 'anthropic-compatible'
        ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
        : { Authorization: `Bearer ${apiKey}` };
    let parsed: unknown;
    try {
      const text = await fetchBoundedText(url, {
        headers,
        timeoutMs: 15_000,
        maxBytes: 2 * 1024 * 1024,
        label: 'model list',
      });
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(
        this.translate('noteModelsLoadFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    const rows = (parsed as { data?: unknown })?.data;
    if (!Array.isArray(rows)) {
      throw new Error(this.translate('noteModelsEmpty'));
    }
    const ids = rows
      .map((row) => (row && typeof row === 'object' ? (row as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim());
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  }

  // ------------------------------------------------------------ Earth Engine

  /**
   * 合并 Earth Engine 设置（宿主 OAuth client id、用户 project id），持久化
   * project id，并把合并后的 options 推给工具。在面板装配阶段（`attach`
   * 创建工具之前）与后续编辑时都会调用。
   */
  setEarthEngineSettings(patch: { oauthClientId?: string; projectId?: string }): void {
    // 宿主未启用 Earth Engine 时忽略任何设置。
    if (!this.options.earthEngine) {
      return;
    }
    const merged = { ...this.options.earthEngine };
    if (patch.oauthClientId !== undefined) {
      merged.oauthClientId = patch.oauthClientId.trim();
    }
    if (patch.projectId !== undefined) {
      const projectId = patch.projectId.trim();
      merged.projectId = projectId;
      // project id 由用户填写，值得跨会话记住；清空则移除存储值。
      if (projectId) {
        storageSet(this.earthEngineProjectIdStorageKey(), projectId);
      } else {
        storageRemove(this.earthEngineProjectIdStorageKey());
      }
    }
    this.options.earthEngine = merged;
    // 工具尚不存在（attach 之前）时跳过；已存在则即时同步新配置。
    this.tools?.updateEarthEngineOptions(merged);
    this.emit('statechange');
  }

  /** Earth Engine 字段的初始 project id（storage 优先于 options）。 */
  getEarthEngineProjectId(): string {
    return firstValue(
      storageGet(this.earthEngineProjectIdStorageKey()),
      this.options.earthEngine?.projectId,
    );
  }

  /** 设置区内展示的本地化 Earth Engine 状态行。 */
  getEarthEngineStatusText(): string {
    const oauthClientId = firstValue(this.options.earthEngine?.oauthClientId);
    const accessToken = this.options.earthEngine?.accessToken?.trim();
    const projectId = this.options.earthEngine?.projectId?.trim() ?? '';
    // 工具运行后会把初始化结果写入 state.data.earthEngine，据此展示更详细的状态。
    const earthEngine = this.state.data?.earthEngine as
      | { initialized?: boolean; layerCount?: number }
      | undefined;
    // 状态优先级：无凭据 > 无 project id > 已初始化详情 > 已配置待初始化。
    if (!oauthClientId && !accessToken) {
      return this.translate('eeStatusNoCredentials');
    }
    if (!projectId) {
      return this.translate('eeStatusNoProject');
    }
    return earthEngine
      ? this.translate('eeStatusInitialized', {
          initialized: earthEngine.initialized ? this.translate('eeYes') : this.translate('eeNo'),
          count: earthEngine.layerCount ?? 0,
        })
      : this.translate('eeStatusConfigured');
  }

  // --------------------------------------------------------- 配置完备性

  /**
   * 当前 provider 是否已具备运行 prompt 的全部条件：已提交的 API key、
   * 模型 ID，以及（兼容型 provider）合法的 base URL。
   */
  isConfigured(): boolean {
    // 使用已提交 key（而非实时输入），避免键入到一半就把徽标翻成 "Ready"。
    if (!this.committedApiKey.trim() || !this.state.modelId.trim()) {
      return false;
    }
    if (
      this.providerConfig(this.state.providerId).requiresBaseUrl &&
      !this.isValidBaseUrl(this.state.baseUrl)
    ) {
      return false;
    }
    return true;
  }

  /**
   * 当前 provider 仍缺失的配置项的可读列表（逗号分隔）；配置齐全时为空串。
   */
  missingConfigSummary(): string {
    const missing: string[] = [];
    // 缺失项按“key → base URL → 模型”的顺序收集，与设置表单顺序一致。
    if (!this.committedApiKey.trim()) {
      missing.push(this.localizedApiKeyLabel(this.state.providerId));
    }
    if (
      this.providerConfig(this.state.providerId).requiresBaseUrl &&
      !this.isValidBaseUrl(this.state.baseUrl)
    ) {
      missing.push(this.translate('missingBaseUrl'));
    }
    if (!this.state.modelId.trim()) {
      missing.push(this.translate('missingModel'));
    }
    return missing.join(', ');
  }

  /** 当前实际使用的地图引擎名，供引擎感知的日志消息使用。 */
  private engineLabel(): string {
    const kind = this.options.mapEngine?.kind;
    return (kind && ENGINE_LABELS[kind]) || 'MapLibre';
  }

  /** attach 后追加的系统日志文案：按配置情况输出“就绪”或“缺哪些配置”。 */
  private readyLogMessage(): string {
    const engine = this.engineLabel();
    if (this.isConfigured()) {
      return this.translate('logReady', { engine });
    }
    const missing = this.missingConfigSummary();
    return missing
      ? this.translate('logLoadedWithMissing', { missing, engine })
      : this.translate('logLoaded', { engine });
  }

  /** 归一化 base URL：去首尾空格并移除末尾的全部斜杠。 */
  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, '');
  }

  /**
   * 判断自定义 base URL 是否为绝对 http(s) URL。相对值（如 `api` 或 `/proxy`）
   * 会按应用自身 origin 解析，导致 API key 泄漏给错误端点，因此直接拒绝。
   */
  private isValidBaseUrl(baseUrl: string): boolean {
    const trimmed = baseUrl.trim();
    if (!trimmed) {
      return false;
    }
    try {
      const url = new URL(trimmed);
      // https 一律放行；http 仅放行本机回环（本地 LLM 如 Ollama 的常见部署），
      // 其余 http 端点会明文传输 API key，直接拒绝。相对路径与非 http 协议同样拒绝。
      if (url.protocol === 'https:') {
        return true;
      }
      return (
        url.protocol === 'http:' &&
        (url.hostname === 'localhost' ||
          url.hostname === '127.0.0.1' ||
          url.hostname === '[::1]' ||
          url.hostname === '::1')
      );
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ 状态徽标

  /** 返回当前状态徽标内容的拷贝。 */
  getStatus(): GeoAgentStatusState {
    return { ...this.status };
  }

  /** 写入徽标内容并广播给订阅者。 */
  private setStatusState(text: string, kind: string, transient: boolean): void {
    this.status = { text, kind, transient };
    this.emitStatus();
  }

  /**
   * 按当前配置渲染空闲状态徽标并记录其类别。空闲状态由配置重算得出，
   * 用户填入或清空凭据时会在 Ready/Setup 之间切换。
   */
  private setIdleBadge(): void {
    if (this.isConfigured()) {
      this.setStatusState(this.translate('statusReady'), 'connected', false);
      this.idleStatusKind = 'connected';
    } else {
      this.setStatusState(this.translate('statusSetup'), 'setup', false);
      this.idleStatusKind = 'setup';
    }
  }

  /**
   * 渲染瞬态状态（Running、Cancelled、Error、Copied）并清空空闲类别记录，
   * 使配置变化在下一次强制空闲刷新之前不会覆盖掉该徽标。
   */
  private setTransientStatus(text: string, kind: string): void {
    this.setStatusState(text, kind, true);
    this.idleStatusKind = null;
  }

  /**
   * 刷新空闲状态徽标，使其反映代理是否已具备所需凭据。瞬态运行状态
   * （Running、Cancelled、Error、Copied）在未指定 `force` 时保持不动，
   * 因此可以安全地在每次键入的配置变化中调用而不覆盖它们。
   */
  applyIdleStatus(force = false): void {
    // 强制刷新（运行结束、复制超时、挂载）必须在 `busy` 尚未清零时也能生效，
    // 否则徽标会卡在 "Running"——因为运行后的刷新调用发生在 finally 清理
    // `busy` 之前。
    if (this.state.busy && !force) {
      return;
    }
    // 正在展示瞬态状态（idleStatusKind 为 null）且非强制时跳过，避免覆盖。
    if (!force && this.idleStatusKind === null) {
      return;
    }
    this.setIdleBadge();
  }

  // ----------------------------------------------------- 配置提示

  /** 展示配置提示；autoHide 为 true 时 5 秒后自动隐藏。 */
  private showNote(
    text: string,
    kind: 'success' | 'error' | 'info',
    autoHide: boolean,
  ): void {
    // 先取消可能仍在排队的上一条提示的隐藏定时器，避免新提示被提前清掉。
    if (this.noteTimer !== null) {
      clearTimeout(this.noteTimer);
      this.noteTimer = null;
    }
    this.note = { text, kind };
    this.emitNote();
    if (autoHide) {
      this.noteTimer = setTimeout(() => this.hideNote(), 5000);
    }
  }

  getNote(): GeoAgentNoteState {
    return { ...this.note };
  }

  /** 隐藏配置提示（清空内容并取消定时器）。 */
  private hideNote(): void {
    if (this.noteTimer !== null) {
      clearTimeout(this.noteTimer);
      this.noteTimer = null;
    }
    this.note = { text: '', kind: null };
    this.emitNote();
  }

  // ------------------------------------------------------------ 会话

  /** 会话条目在 localStorage 中的键。 */
  private conversationStorageKey(): string {
    return `${this.options.storagePrefix}.conversation`;
  }

  /**
   * 从 localStorage 恢复持久化的会话条目（仅在 persistConversation 开启时）。
   * 恢复时逐条校验条目形状，跳过损坏的数据，并把模块级条目计数器推进到
   * 已恢复的最大编号之后，保证新条目 id 不与恢复条目冲突。
   */
  private restorePersistedConversation(): void {
    if (!this.options.persistConversation) return;
    const raw = localGet(this.conversationStorageKey());
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      const list = (parsed as { entries?: unknown })?.entries;
      if (!Array.isArray(list)) return;
      const restored: GeoAgentConversationEntry[] = [];
      for (const item of list) {
        const record = item as Partial<GeoAgentConversationEntry> | null;
        const role = record?.role;
        if (
          !record ||
          typeof record.id !== 'string' ||
          typeof record.content !== 'string' ||
          (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'error')
        ) {
          continue;
        }
        restored.push(
          record.markdown === true
            ? { id: record.id, role, content: record.content, markdown: true }
            : { id: record.id, role, content: record.content },
        );
      }
      if (!restored.length) return;
      for (const entry of restored) {
        const match = /^geoagent-entry-(\d+)$/.exec(entry.id);
        if (match) conversationEntryCount = Math.max(conversationEntryCount, Number(match[1]));
      }
      this.entries = restored;
    } catch {
      // JSON 损坏时忽略持久化数据，从空白会话开始。
    }
  }

  /** 立即把当前会话条目写入 localStorage（persistConversation 开启时）。 */
  private persistConversationNow(): void {
    if (!this.options.persistConversation) return;
    const entries = this.entries.slice(-PERSISTED_CONVERSATION_LIMIT);
    localSet(this.conversationStorageKey(), JSON.stringify({ version: 1, entries }));
  }

  /** 防抖调度一次会话持久化写入，合并流式输出期间的密集更新。 */
  private schedulePersistConversation(): void {
    if (!this.options.persistConversation) return;
    if (this.conversationPersistTimer !== null) clearTimeout(this.conversationPersistTimer);
    this.conversationPersistTimer = setTimeout(() => {
      this.conversationPersistTimer = null;
      this.persistConversationNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** 返回独立数组，条目为只读冻结对象；未变更条目保持引用稳定以便 UI memo。 */
  getConversation(): GeoAgentConversationEntry[] {
    return [...this.entries];
  }

  /** 追加一条会话条目并广播 append 变更；markdown 条目在渲染层走净化管线。 */
  private appendEntry(
    role: GeoAgentConversationEntry['role'],
    content: string,
    markdown = false,
  ): GeoAgentConversationEntry {
    // markdown 标志只在需要时写入对象，保持普通条目形状最小。
    const entry: GeoAgentConversationEntry = markdown
      ? { id: generateEntryId(), role, content, markdown: true }
      : { id: generateEntryId(), role, content };
    Object.freeze(entry);
    this.entries.push(entry);
    this.emitConversation({ type: 'append', entry });
    this.schedulePersistConversation();
    return entry;
  }

  /** 按 id 更新既有条目的内容并广播 update 变更；条目不存在时静默跳过。 */
  private updateEntry(id: string, content: string): void {
    const index = this.entries.findIndex((candidate) => candidate.id === id);
    if (index < 0) return;
    // 更新生成新引用：一帧内多个条目变化时，React.memo 也能全部感知。
    const entry = Object.freeze({ ...this.entries[index], content });
    this.entries[index] = entry;
    this.emitConversation({ type: 'update', entry });
    this.schedulePersistConversation();
  }

  /** 清空会话、失效 agent，并记录“已清空”的系统日志；busy 期间拒绝清空。 */
  clearConversation(): void {
    if (this.state.busy) {
      return;
    }
    this.entries = [];
    this.streamingEntryId = null;
    this.streamingAssistantText = '';
    // agent 的消息历史与会话展示是两份状态，清空展示后同样要重建 agent，
    // 避免模型继续引用已被清空的历史。
    this.invalidateAgent();
    // 持久化开启时同步移除存储的会话，避免下次加载恢复已清空的内容。
    if (this.options.persistConversation) {
      if (this.conversationPersistTimer !== null) {
        clearTimeout(this.conversationPersistTimer);
        this.conversationPersistTimer = null;
      }
      localRemove(this.conversationStorageKey());
    }
    this.emitConversation({ type: 'reset' });
    this.appendEntry('system', this.translate('logChatCleared'));
  }

  /** 把会话导出为 Markdown：每个条目一个小节（## 角色标题 + 内容）。 */
  conversationMarkdown(): string {
    return this.entries
      .map(
        (entry) =>
          `## ${markdownHeading(entry.role)}\n\n${entry.content.trim()}`,
      )
      .filter((section) => section.trim().length > 0)
      .join('\n\n');
  }

  /** 把会话以 Markdown 复制到剪贴板，并短暂闪现 Copied 徽标。 */
  async copyConversationAsMarkdown(): Promise<void> {
    const markdown = this.conversationMarkdown();
    if (!markdown) {
      return;
    }
    try {
      // 优先使用异步 Clipboard API；不可用（非安全上下文等）时抛错走降级路径。
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API is unavailable.');
      }
      await navigator.clipboard.writeText(markdown);
    } catch {
      // 降级：用隐藏 textarea + execCommand 兼容旧环境完成复制。
      const textarea = document.createElement('textarea');
      textarea.value = markdown;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    this.setTransientStatus(this.translate('statusCopied'), 'connected');
    if (this.statusCopyTimer !== null) {
      clearTimeout(this.statusCopyTimer);
    }
    // 1.2 秒后强制恢复空闲徽标，让 Copied 状态自动消失。
    this.statusCopyTimer = setTimeout(() => {
      this.statusCopyTimer = null;
      this.applyIdleStatus(true);
    }, 1200);
  }

  // ------------------------------------------------------------------ agent

  /** 使缓存的 agent 失效；下次 getAgent 时按当前配置重建。 */
  private invalidateAgent(): void {
    this.agent = null;
    this.agentSignature = '';
  }

  /** 是否已有待落定的取消请求（用于禁用/启用 Cancel 按钮）。 */
  isCancelRequested(): boolean {
    return this.cancelRequested;
  }

  /** 请求取消进行中的运行：中止 HTTP 请求并终止 agent 任务。 */
  cancelActiveRun(): void {
    // 空闲中或取消已在途时无需重复处理。
    if (!this.state.busy || this.cancelRequested) {
      return;
    }
    this.cancelRequested = true;
    // 双通道取消：abort 掐断底层模型请求，cancel 终止 agent 的运行循环。
    this.activeAbortController?.abort();
    this.agent?.cancel();
    this.tools?.cancelPendingCommands();
    this.finalizeToolRun('cancelled');
    this.setTransientStatus(this.translate('statusCancelling'), 'connected');
    this.appendEntry('system', this.translate('logCancelRequested'));
    this.emit('statechange');
  }

  /**
   * 创建 provider 对应的模型客户端实例；模型实现按需动态加载，
   * 避免把未使用的 provider SDK 打进主包。
   */
  private async createProviderModel(
    providerId: GeoAgentProviderId,
    modelId: string,
    apiKey: string,
    baseUrl: string,
  ): Promise<Model> {
    if (providerId === 'openai-compatible') {
      const { OpenAIModel } = await import('@strands-agents/sdk/models/openai');
      return new OpenAIModel({
        api: 'chat',
        modelId,
        apiKey,
        clientConfig: {
          // 浏览器端直连需要显式放行 SDK 的“仅在服务端使用”限制。
          dangerouslyAllowBrowser: true,
          baseURL: this.normalizeBaseUrl(baseUrl),
        },
      });
    }
    if (providerId === 'anthropic-compatible') {
      const { AnthropicModel } = await import('@strands-agents/sdk/models/anthropic');
      return new AnthropicModel({
        modelId,
        apiKey,
        // Anthropic-compatible 网关同样可以指向自建 base URL，与
        // OpenAI-compatible 端点一致。
        clientConfig: {
          dangerouslyAllowBrowser: true,
          baseURL: this.normalizeBaseUrl(baseUrl),
        },
      });
    }
    throw new Error(`Unsupported browser provider: ${providerId}`);
  }

  /**
   * 取得可用的 Agent 实例：先校验配置完整性，再按配置签名复用或重建
   * （system prompt 也在此按引擎与权限开关组装）。
   */
  private async getAgent(signal: AbortSignal): Promise<Agent> {
    // 工具未创建说明尚未 attach，无法提供地图上下文。
    if (!this.tools) {
      throw new Error('GeoAgent control is not mounted.');
    }
    const provider = this.providerConfig(this.state.providerId);
    const apiKey = this.committedApiKey.trim();
    const modelId = this.state.modelId.trim();
    const baseUrl = this.state.baseUrl.trim();
    // 逐项校验并抛出本地化的错误信息，由 sendPrompt 落成会话里的 error 条目。
    if (!apiKey) {
      throw new Error(
        this.translate('errorApiKeyRequired', {
          keyLabel: this.localizedApiKeyLabel(provider.id),
        }),
      );
    }
    if (!modelId) {
      throw new Error(this.translate('errorModelIdRequired'));
    }
    if (provider.requiresBaseUrl && !this.isValidBaseUrl(baseUrl)) {
      throw new Error(this.translate('errorBaseUrlRequired'));
    }

    // 配置签名：签名一致即可复用缓存实例；key/model/baseUrl/权限任一变化都会
    // 触发重建（provider.requiresBaseUrl 为假时 base URL 不参与签名）。
    const signature = JSON.stringify({
      providerId: provider.id,
      modelId,
      baseUrl: provider.requiresBaseUrl ? baseUrl : '',
      apiKey,
      allowCodeExecution: this.state.allowCodeExecution,
    });
    if (this.agent && this.agentSignature === signature) {
      return this.agent;
    }

    // 解析引擎类型；ArcGIS 还需 viewKind 以区分 MapView/SceneView 的能力段落。
    const engineKind = this.options.mapEngine?.kind;
    const arcgisViewKind = this.arcgisViewKind;
    // system prompt 分段拼装：基础段 + 引擎能力段 + （启用时的）代码执行段 +
    // 宿主自定义段，过滤空段后以空行连接。
    const systemPromptParts = [
      BROWSER_MAP_SYSTEM_PROMPT,
      engineCapabilityPrompt(engineKind, arcgisViewKind),
      this.state.allowCodeExecution
        ? codeExecutionPrompt(engineKind, arcgisViewKind)
        : '',
      this.options.customSystemPrompt?.trim() ?? '',
    ].filter(Boolean);
    const systemPrompt = systemPromptParts.join('\n\n');
    const model = await this.createProviderModel(provider.id, modelId, apiKey, baseUrl);
    signal.throwIfAborted();
    this.agent = new Agent({
      name: 'Web GeoAgent Browser',
      model,
      systemPrompt,
      tools: [...this.tools.createTools(), ...this.resolveCustomTools()],
      // 关闭 SDK 自带的控制台打印；工具串行执行，保证地图操作的时序可预期。
      printer: false,
      toolExecutor: 'sequential',
    });
    this.agentSignature = signature;
    return this.agent;
  }

  /** 解析宿主的 customTools 选项：支持数组或返回数组的工厂函数。 */
  private resolveCustomTools(): Tool[] {
    const tools = this.options.customTools;
    if (!tools) {
      return [];
    }
    return (typeof tools === 'function' ? tools() : tools) as Tool[];
  }

  // ------------------------------------------------------------- 运行 prompt

  /** 把流式文本增量累加进同一条 assistant 条目；首个增量时才创建该条目。 */
  private appendAssistantDelta(text: string): void {
    if (!text) {
      return;
    }
    // 流式文本夹在工具调用之间说明代理在讲话：先定稿当前工具合并组，
    // 之后到来的工具调用会另起新组（保持“相邻调用合并”语义）。
    this.finalizeToolRun();
    // 本轮尚无流式条目时先创建一个空的 markdown assistant 条目占位。
    if (!this.streamingEntryId) {
      const entry = this.appendEntry('assistant', '', true);
      this.streamingEntryId = entry.id;
    }
    this.streamingAssistantText += text;
    // 每个增量都触发一次 update，UI 侧形成打字机效果。
    this.updateEntry(this.streamingEntryId, this.streamingAssistantText);
  }

  /**
   * 处理单条 agent 流事件：文本增量写入流式条目、工具调用前追加 tool 日志、
   * 结果事件返回最终答案文本；其余事件返回 undefined。
   */
  private handleAgentStreamEvent(event: AgentStreamEvent): string | undefined {
    if (event.type === 'modelStreamUpdateEvent') {
      const modelEvent = event.event;
      // 只关心文本增量（textDelta）；其他内容块类型（如工具参数）不进会话。
      if (
        modelEvent.type === 'modelContentBlockDeltaEvent' &&
        modelEvent.delta.type === 'textDelta'
      ) {
        this.appendAssistantDelta(modelEvent.delta.text);
      }
      return undefined;
    }

    if (event.type === 'beforeToolCallEvent') {
      // 相邻的工具调用合并进同一行：运行中只显示「正在执行工具（第 N 步）」，
      // 不逐个刷日志；整轮结束后再由 finalizeToolRun 展开逐条详情。
      // 同时封存当前流式文本条目：模型“边说边做”时，说话与工具调用按时序
      // 交错成多段，避免后续文本继续写入工具调用之前的那段，造成“答案在
      // 上、工具在下”的错位观感。
      this.streamingEntryId = null;
      this.streamingAssistantText = '';
      const name = event.toolUse.name;
      if (!this.toolRunEntryId) {
        const entry = this.appendEntry(
          'tool',
          this.translate('logRunningToolsGroup', { tool: name, step: 1 }),
        );
        this.toolRunEntryId = entry.id;
        this.toolRunCalls = [];
      } else {
        this.updateEntry(
          this.toolRunEntryId,
          this.translate('logRunningToolsGroup', {
            tool: name,
            step: this.toolRunCalls.length + 1,
          }),
        );
      }
      this.toolRunCalls.push({ id: event.toolUse.toolUseId, name, startedAt: Date.now(), status: 'running' });
      return undefined;
    }

    if (event.type === 'afterToolCallEvent') {
      const call = [...this.toolRunCalls].reverse().find((item) =>
        item.status === 'running' && (event.toolUse.toolUseId ? item.id === event.toolUse.toolUseId : item.name === event.toolUse.name),
      );
      if (!call) return undefined;
      let structuredError: string | undefined;
      for (const block of event.result?.content ?? []) {
        let value: unknown = block.type === 'jsonBlock' ? block.json : undefined;
        if (block.type === 'textBlock') {
          try { value = JSON.parse(block.text); } catch { /* ordinary text result */ }
        }
        if (value && typeof value === 'object' && (value as { success?: boolean }).success === false) {
          structuredError = String((value as { error?: unknown }).error ?? 'Tool reported success: false');
        }
      }
      const failed = !!event.error || event.result?.status === 'error' || !!structuredError;
      call.status = event.error?.name === 'AbortError' || this.cancelRequested ? 'cancelled' : failed ? 'failed' : event.result ? 'succeeded' : 'unknown';
      call.elapsedMs = Math.max(0, Date.now() - call.startedAt);
      if (failed) {
        const text = event.result?.content?.filter((block) => block.type === 'textBlock').map((block) => block.text).join(' ');
        call.error = (event.error?.message || event.result?.error?.message || structuredError || text || '').slice(0, 300);
      }
      this.renderToolRun();
      return undefined;
    }

    if (event.type === 'agentResultEvent') {
      // 最终答案到来时本轮工具已全部执行完，先把合并行展开成详情。
      this.finalizeToolRun();
      return event.result.toString();
    }

    return undefined;
  }

  /**
   * 按实际结果渲染工具调用明细：状态、耗时和错误摘要。
   * 缺少结果事件时保留“结果未知”，不能推断成功。
   */
  private renderToolRun(): void {
    if (!this.toolRunEntryId) return;
    const statusKeys = {
      running: 'logToolRunning', succeeded: 'logToolSucceeded', failed: 'logToolFailed',
      cancelled: 'logToolCancelled', unknown: 'logToolUnknown',
    } as const;
    const lines = [
      this.translate('logToolsEnded', { count: this.toolRunCalls.length }),
      ...this.toolRunCalls.map((call, index) => {
        const detail = this.translate(statusKeys[call.status]);
        const elapsed = call.elapsedMs === undefined ? '' : ` (${call.elapsedMs} ms)`;
        return `${index + 1}. ${call.name} — ${detail}${elapsed}${call.error ? `: ${call.error}` : ''}`;
      }),
    ];
    this.updateEntry(this.toolRunEntryId, lines.join('\n'));
  }

  private finalizeToolRun(pendingStatus: 'cancelled' | 'failed' | 'unknown' = 'unknown'): void {
    if (!this.toolRunEntryId) return;
    for (const call of this.toolRunCalls) {
      if (call.status === 'running') {
        call.status = pendingStatus;
        call.elapsedMs = Math.max(0, Date.now() - call.startedAt);
      }
    }
    this.renderToolRun();
    this.toolRunEntryId = null;
    this.toolRunCalls = [];
  }

  /**
   * 运行一条 prompt。文本此时已由 UI 层读取并清空；核心负责记录历史、
   * 把答案流式写入单条 assistant 条目，并掌管 busy/cancel 生命周期。
   */
  async sendPrompt(text: string): Promise<void> {
    const trimmed = text.trim();
    // 空文本或已有运行在途时直接忽略，避免并发运行互相干扰。
    if (!trimmed || this.state.busy) {
      return;
    }
    this.rememberPrompt(trimmed);
    this.appendEntry('user', trimmed);
    this.streamingEntryId = null;
    this.streamingAssistantText = '';
    this.toolRunEntryId = null;
    this.toolRunCalls = [];
    this.state.busy = true;
    this.cancelRequested = false;
    // 每次运行一个独立的 AbortController；挂在 core 上供 cancelActiveRun 使用。
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.setTransientStatus(this.translate('statusRunning'), 'connected');
    this.emit('statechange');
    try {
      const activeAgent = await this.getAgent(abortController.signal);
      abortController.signal.throwIfAborted();
      let finalAnswer = '';
      // 消费 agent 的异步事件流；handleAgentStreamEvent 返回的最终答案
      // 持续覆盖 finalAnswer（结果事件通常只有一条）。
      for await (const event of activeAgent.stream(trimmed, {
        cancelSignal: abortController.signal,
      })) {
        if (this.activeAbortController !== abortController) return;
        abortController.signal.throwIfAborted();
        finalAnswer = this.handleAgentStreamEvent(event) ?? finalAnswer;
      }
      // 取消时展示统一文案；否则优先取结果事件答案，回退到流式累计文本，
      // 再回退到“已完成”占位（纯工具运行、无文本输出的情形）。
      if (this.activeAbortController !== abortController) return;
      const answer = abortController.signal.aborted
        ? this.translate('answerCancelled')
        : finalAnswer || this.streamingAssistantText || this.translate('answerDone');
      if (this.streamingEntryId) {
        this.updateEntry(this.streamingEntryId, answer);
      } else {
        this.appendEntry('assistant', answer, true);
      }
      if (abortController.signal.aborted) {
        this.setTransientStatus(this.translate('statusCancelled'), 'connected');
      } else {
        this.applyIdleStatus(true);
      }
    } catch (error) {
      if (this.activeAbortController !== abortController) return;
      const message = error instanceof Error ? error.message : String(error);
      if (abortController.signal.aborted) {
        // 取消导致的异常不算错误：与成功路径一致，在已有流式条目上落定
        // 取消答复，而不是另起一条（否则已吐字的会话会出现"半截回答 +
        // 已取消"两条并存）。
        if (this.streamingEntryId) {
          this.updateEntry(this.streamingEntryId, this.translate('answerCancelled'));
        } else {
          this.appendEntry('assistant', this.translate('answerCancelled'), true);
        }
        this.setTransientStatus(this.translate('statusCancelled'), 'connected');
      } else {
        // 真实错误：会话追加 error 条目，徽标进入 error 状态。
        this.finalizeToolRun('unknown');
        this.appendEntry('error', message);
        this.setTransientStatus(this.translate('statusError'), 'error');
      }
    } finally {
      // 旧运行的 finally 不得清除重新绑定后新运行的状态。
      if (this.activeAbortController === abortController) {
        this.finalizeToolRun();
        this.state.busy = false;
        this.activeAbortController = null;
        this.cancelRequested = false;
        this.streamingEntryId = null;
        this.streamingAssistantText = '';
        this.emit('statechange');
      }
    }
  }

  // ---------------------------------------------------------- prompt 历史

  /** 记录一条已发送的 prompt：与上一条相同则去重，并重置导航状态。 */
  private rememberPrompt(text: string): void {
    if (this.promptHistory[this.promptHistory.length - 1] !== text) {
      this.promptHistory.push(text);
    }
    this.promptHistoryIndex = -1;
    this.promptHistoryDraft = '';
  }

  /**
   * ArrowUp 导航：返回上一条 prompt。导航不适用时返回 null（无历史，或
   * 光标不在 textarea 的第一行——多行编辑时让出方向键）。
   */
  historyUp(value: string, selectionStart: number, _selectionEnd: number): string | null {
    if (this.promptHistory.length === 0) {
      return null;
    }
    const beforeSelection = value.slice(0, selectionStart);
    // 光标前方已有换行说明不在首行，方向键交给正常的文本移动。
    if (beforeSelection.includes('\n')) {
      return null;
    }
    // 首次进入导航时保存当前草稿，供 ArrowDown 越过末尾时恢复。
    if (this.promptHistoryIndex === -1) {
      this.promptHistoryDraft = value;
    }
    this.promptHistoryIndex =
      this.promptHistoryIndex === -1
        ? this.promptHistory.length - 1
        : Math.max(0, this.promptHistoryIndex - 1);
    return this.promptHistory[this.promptHistoryIndex];
  }

  /**
   * ArrowDown 导航：返回下一条 prompt。导航不适用时返回 null（未处于导航
   * 状态，或光标不在最后一行）；越过历史末尾时返回 null 并恢复进行中的草稿。
   */
  historyDown(value: string, _selectionStart: number, selectionEnd: number): string | null {
    if (this.promptHistory.length === 0 || this.promptHistoryIndex === -1) {
      return null;
    }
    const afterSelection = value.slice(selectionEnd);
    // 光标后方还有换行说明不在最后一行，不劫持方向键。
    if (afterSelection.includes('\n')) {
      return null;
    }
    this.promptHistoryIndex += 1;
    if (this.promptHistoryIndex >= this.promptHistory.length) {
      // 越过末尾：退出导航状态并恢复进入导航前的草稿。
      this.promptHistoryIndex = -1;
      return this.promptHistoryDraft;
    }
    return this.promptHistory[this.promptHistoryIndex];
  }

  // ------------------------------------------------------------- 面板尺寸

  /** 把面板宽度钳制到 [panelMinWidth, panelMaxWidth] 区间（四舍五入到整数）。 */
  private constrainPanelWidth(width: number): number {
    return Math.max(
      this.options.panelMinWidth,
      Math.min(this.options.panelMaxWidth, Math.round(width)),
    );
  }

  /** 把面板高度钳制到 [panelMinHeight, 有效最大高度] 区间。 */
  private constrainPanelHeight(height: number): number {
    // 地图容器是实际上的上限，让面板能被拖到几乎填满地图
    // （而不只是 option 的默认最大值）。
    let max = this.options.panelMaxHeight;
    const mapHeight = this.mapContainer?.clientHeight ?? 0;
    if (mapHeight > 0) {
      max = Math.min(max, mapHeight - 20);
    }
    return Math.max(
      this.options.panelMinHeight,
      Math.min(max, Math.round(height)),
    );
  }
}
