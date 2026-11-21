import {
  Agent,
  type AgentStreamEvent,
  type Model,
  type Tool,
} from '@strands-agents/sdk';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { t, type GeoAgentMessageKey } from '../i18n';
import { DEFAULT_BASEMAPS, MapLibreAgentTools } from './maplibre-tools';
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

const DEFAULT_PROVIDER: GeoAgentProviderId = 'openai-responses';
const DEFAULT_STORAGE_PREFIX = 'geoagent.maplibre';

const BASE_PROVIDER_CONFIGS: Record<
  GeoAgentProviderId,
  Omit<GeoAgentProviderConfig, 'storageKey'>
> = {
  'openai-responses': {
    id: 'openai-responses',
    label: 'OpenAI Responses',
    keyLabel: 'OpenAI API Key',
    keyPlaceholder: 'sk-...',
    defaultModel: 'gpt-5.5',
  },
  'openai-chat': {
    id: 'openai-chat',
    label: 'OpenAI Chat',
    keyLabel: 'OpenAI API Key',
    keyPlaceholder: 'sk-...',
    defaultModel: 'gpt-5.5',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    keyLabel: 'Anthropic API Key',
    keyPlaceholder: 'sk-ant-...',
    defaultModel: 'claude-opus-4-8',
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI-Compatible (Custom)',
    keyLabel: 'API Key',
    keyPlaceholder: 'sk-... or token',
    // No default model: custom endpoints expose their own model names, so the
    // user enters one or loads the list from the endpoint.
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

const BROWSER_MAPLIBRE_SYSTEM_PROMPT = `You are an AI assistant embedded in a browser web app with direct access to a live MapLibre map through dedicated browser tools.

Workflow guidance:
- Use browser map tools for map navigation, layer inspection, marker creation, GeoJSON display, layer visibility, feature queries, and screenshots.
- Use add_basemap for requests to add satellite imagery or another raster background, including Google satellite. Use change_basemap only when the user explicitly asks to replace the whole map style.
- When the user asks for Google Earth Engine data, GEE catalog data, SRTM from GEE, Sentinel/Landsat/MODIS/GEE assets, NDVI, or Earth Engine statistics, use the dedicated Earth Engine tools first.
- Do not silently replace a requested Earth Engine layer with unrelated public XYZ, terrain, or basemap tiles. If an Earth Engine tool fails, report the exact tool error and ask for the missing credential/project/asset detail.
- Coordinates in user-facing prompts are latitude/longitude, but browser map internals use longitude/latitude. Use the tool parameter names exactly.
- Do not ask the user to paste JavaScript or run Python for actions that the browser map tools can perform.
- Keep responses concise and include layer names, locations, and tool results when useful.`;

const BROWSER_MAPLIBRE_CODE_SYSTEM_PROMPT = `Browser JavaScript code execution is enabled for this local session. This tool runs arbitrary JavaScript in the page context and is not a safety boundary; treat it as a trusted, local-only escape hatch.

When no dedicated browser map tool can perform the requested MapLibre operation, write a short JavaScript snippet and run it with run_maplibre_script. The snippet executes in the browser with these names in scope: map, maplibregl, and helpers. Prefer MapLibre GL JS API calls, keep code focused on map operations, and avoid credential handling, storage access, unrelated DOM manipulation, or broad network operations.`;

function storageGet(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // Ignore storage failures in private or restricted browser contexts.
  }
}

function storageRemove(key: string): void {
  try {
    globalThis.sessionStorage?.removeItem(key);
  } catch {
    // Ignore storage failures in private or restricted browser contexts.
  }
}

function firstValue(...values: Array<string | undefined | null>): string {
  return values.find((value) => value?.trim())?.trim() ?? '';
}

function defaultModelFor(
  providerId: GeoAgentProviderId,
  defaultModel: GeoAgentControlOptions['defaultModel'],
): string {
  if (typeof defaultModel === 'string') {
    return defaultModel;
  }
  return defaultModel?.[providerId] ?? BASE_PROVIDER_CONFIGS[providerId].defaultModel;
}

function markdownHeading(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
}

let conversationEntryCount = 0;

function generateEntryId(): string {
  conversationEntryCount += 1;
  return `geoagent-entry-${conversationEntryCount}`;
}

type ConversationHandler = (
  change: GeoAgentConversationChange,
  entries: GeoAgentConversationEntry[],
) => void;
type StatusHandler = (status: GeoAgentStatusState) => void;
type NoteHandler = (note: GeoAgentNoteState) => void;

type EventHandlersMap = globalThis.Map<
  GeoAgentControlEvent,
  Set<GeoAgentControlEventHandler>
>;

/**
 * Headless GeoAgent engine: provider configuration and persistence, the
 * Strands agent lifecycle, conversation state, and prompt history — with no
 * DOM of its own. Both the imperative {@link GeoAgentControl} panel and the
 * React {@link GeoAgentPanel} render from this core.
 *
 * Lifecycle: construct with options, call {@link attach} with the map (any
 * engine supported by `mapEngine`), drive it through the setter methods, and
 * call {@link dispose} when done. Conversation, status-badge, and
 * configuration-note changes are delivered through the dedicated
 * `onConversation` / `onStatus` / `onNote` subscriptions.
 */
export class GeoAgentCore {
  readonly options: Required<
    Omit<
      GeoAgentControlOptions,
      | 'defaultModel'
      | 'basemaps'
      | 'earthEngine'
      | 'apiKeys'
      | 'panelHeight'
      | 'customTools'
      | 'customSystemPrompt'
      | 'mapEngine'
    >
  > &
    Pick<
      GeoAgentControlOptions,
      | 'defaultModel'
      | 'basemaps'
      | 'earthEngine'
      | 'apiKeys'
      | 'panelHeight'
      | 'customTools'
      | 'customSystemPrompt'
      // No default: the tools fall back to this package's own maplibre-gl.
      | 'mapEngine'
    >;
  private mapInstance?: MapLibreMap;
  private mapContainer?: HTMLElement;
  private tools?: MapLibreAgentTools;
  private agent: Agent | null = null;
  private agentSignature = '';
  private streamingEntryId: string | null = null;
  private streamingAssistantText = '';
  private entries: GeoAgentConversationEntry[] = [];
  private promptHistory: string[] = [];
  private promptHistoryIndex = -1;
  private promptHistoryDraft = '';
  private state: GeoAgentState;
  private eventHandlers: EventHandlersMap = new globalThis.Map();
  private conversationHandlers = new Set<ConversationHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private noteHandlers = new Set<NoteHandler>();
  private activeAbortController: AbortController | null = null;
  private cancelRequested = false;
  // The API key the agent actually uses. Updated only when the user commits the
  // key field (Enter or blur), never on every keystroke, so a half-typed key
  // does not flip the badge to "Ready" or get written to storage.
  private committedApiKey = '';
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private statusCopyTimer: ReturnType<typeof setTimeout> | null = null;
  // Kind of the currently displayed idle status badge ('connected' | 'setup'),
  // or null while a transient status (Running, Cancelled, Error, Copied) is
  // shown. Tracked by kind instead of comparing badge text so the idle status
  // keeps working in every locale.
  private idleStatusKind: 'connected' | 'setup' | null = null;
  private status: GeoAgentStatusState = {
    text: '',
    kind: '',
    transient: false,
  };
  private note: GeoAgentNoteState = { text: '', kind: null };

  constructor(options: GeoAgentControlOptions = {}) {
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
      allowCodeExecutionDefault: options.allowCodeExecutionDefault ?? true,
      allowDestructiveToolsDefault: options.allowDestructiveToolsDefault ?? true,
      showPermissionToggles: options.showPermissionToggles ?? false,
      defaultModel: options.defaultModel,
      apiKeys: options.apiKeys,
      basemaps: options.basemaps,
      earthEngine: options.earthEngine,
      customTools: options.customTools,
      customSystemPrompt: options.customSystemPrompt,
      mapEngine: options.mapEngine,
    };
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
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Wire the core to a map. Creates the engine-appropriate agent tools (the
   * map is handed to them through the constructor), loads the persisted
   * provider settings, and appends the ready/setup log entry.
   */
  attach(map: MapLibreMap): void {
    // Re-attaching (e.g. a React panel whose map instance changed) replaces the
    // previous tools binding instead of leaking it.
    if (this.tools) {
      this.tools.destroy();
      this.tools = undefined;
    }
    this.mapInstance = map;
    // MapLibre/Mapbox/Leaflet hosts expose getContainer(); OpenLayers maps
    // expose getTargetElement() instead — accept either so overlays and the
    // height clamping have a container on every engine.
    const containerSource = map as unknown as {
      getContainer?(): HTMLElement | undefined;
      getTargetElement?(): HTMLElement | null | undefined;
    };
    const mapContainer =
      containerSource.getContainer?.() ??
      containerSource.getTargetElement?.() ??
      undefined;
    if (!mapContainer) {
      throw new Error(
        'GeoAgentControl: the map exposes neither getContainer() nor getTargetElement(); cannot mount the agent panel.',
      );
    }
    this.mapContainer = mapContainer;
    this.tools = new MapLibreAgentTools(map, {
      basemaps: { ...DEFAULT_BASEMAPS, ...this.options.basemaps },
      allowCodeExecution: () => this.state.allowCodeExecution,
      allowDestructiveTools: () => this.state.allowDestructiveTools,
      earthEngine: this.options.earthEngine,
      mapEngine: this.options.mapEngine,
      onStateDataChange: (data) => {
        this.state.data = { ...(this.state.data ?? {}), ...data };
        this.emit('statechange');
      },
    });
    this.loadProviderSettings();
    this.applyIdleStatus(true);
    this.appendEntry('system', this.readyLogMessage());
  }

  /** Drop the map binding without touching the conversation or listeners. */
  detach(): void {
    this.tools?.destroy();
    this.tools = undefined;
    this.mapInstance = undefined;
    this.mapContainer = undefined;
  }

  /** Full teardown: abort any run, drop the map binding, clear all listeners. */
  dispose(): void {
    this.activeAbortController?.abort();
    this.agent?.cancel();
    this.activeAbortController = null;
    this.cancelRequested = false;
    this.agent = null;
    this.agentSignature = '';
    this.detach();
    if (this.noteTimer !== null) {
      clearTimeout(this.noteTimer);
      this.noteTimer = null;
    }
    if (this.statusCopyTimer !== null) {
      clearTimeout(this.statusCopyTimer);
      this.statusCopyTimer = null;
    }
    this.promptHistory = [];
    this.promptHistoryIndex = -1;
    this.promptHistoryDraft = '';
    this.eventHandlers.clear();
    this.conversationHandlers.clear();
    this.statusHandlers.clear();
    this.noteHandlers.clear();
  }

  getMap(): MapLibreMap | undefined {
    return this.mapInstance;
  }

  /** The engine-bound tools, or undefined before `attach`. */
  getTools(): MapLibreAgentTools | undefined {
    return this.tools;
  }

  /** Live (uncopied) state for UI layers that read it on every render. */
  peekState(): GeoAgentState {
    return this.state;
  }

  // ------------------------------------------------------------------ events

  on(event: GeoAgentControlEvent, handler: GeoAgentControlEventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: GeoAgentControlEvent, handler: GeoAgentControlEventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  onConversation(handler: ConversationHandler): void {
    this.conversationHandlers.add(handler);
  }

  offConversation(handler: ConversationHandler): void {
    this.conversationHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): void {
    this.statusHandlers.add(handler);
  }

  offStatus(handler: StatusHandler): void {
    this.statusHandlers.delete(handler);
  }

  onNote(handler: NoteHandler): void {
    this.noteHandlers.add(handler);
  }

  offNote(handler: NoteHandler): void {
    this.noteHandlers.delete(handler);
  }

  private emit(event: GeoAgentControlEvent): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) {
      return;
    }
    const eventData = { type: event, state: this.getState() };
    handlers.forEach((handler) => handler(eventData));
  }

  private emitConversation(change: GeoAgentConversationChange): void {
    const entries = this.getConversation();
    this.conversationHandlers.forEach((handler) => handler(change, entries));
  }

  private emitStatus(): void {
    const status = this.getStatus();
    this.statusHandlers.forEach((handler) => handler(status));
  }

  private emitNote(): void {
    const note = { ...this.note };
    this.noteHandlers.forEach((handler) => handler(note));
  }

  // ------------------------------------------------------------------- state

  getState(): GeoAgentState {
    return {
      ...this.state,
      data: { ...this.state.data },
    };
  }

  /**
   * Merge a partial state. Panel size values are clamped; provider, model, and
   * code-execution changes invalidate the cached agent; collapse changes emit
   * the expand/collapse events. DOM side effects belong to the UI layers.
   */
  setState(newState: Partial<GeoAgentState>): void {
    const collapsedChanged =
      newState.collapsed !== undefined && newState.collapsed !== this.state.collapsed;
    const agentInvalidating =
      (newState.providerId !== undefined && newState.providerId !== this.state.providerId) ||
      (newState.modelId !== undefined && newState.modelId !== this.state.modelId) ||
      (newState.allowCodeExecution !== undefined &&
        newState.allowCodeExecution !== this.state.allowCodeExecution);
    this.state = { ...this.state, ...newState };
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
    this.emit('statechange');
  }

  toggle(): void {
    this.setState({ collapsed: !this.state.collapsed });
  }

  expand(): void {
    if (this.state.collapsed) {
      this.toggle();
    }
  }

  collapse(): void {
    if (!this.state.collapsed) {
      this.toggle();
    }
  }

  // -------------------------------------------------------------- i18n texts

  /** Localized UI string for this core's locale. */
  translate(key: GeoAgentMessageKey, params?: Record<string, string | number>): string {
    return t(this.options.locale, key, params);
  }

  /** Display label for a chat log role, honoring the core's locale. */
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

  /** Localized API key field label for a provider. */
  localizedApiKeyLabel(providerId: GeoAgentProviderId): string {
    const key: GeoAgentMessageKey =
      providerId === 'anthropic' || providerId === 'anthropic-compatible'
        ? 'keyLabelAnthropic'
        : providerId === 'openai-compatible'
          ? 'keyLabelGeneric'
          : 'keyLabelOpenAI';
    return this.translate(key);
  }

  /** Placeholder hint shown in the prompt field while it is locked. */
  blockedPromptHint(configured: boolean): string {
    const missing = configured ? '' : this.missingConfigSummary();
    return missing
      ? this.translate('hintAddMissingToStart', { missing })
      : this.translate('hintConfigureProvider');
  }

  /** Tooltip for the Send button while configuration is incomplete. */
  sendBlockedHint(): string {
    const missing = this.missingConfigSummary();
    return missing
      ? this.translate('hintAddMissingToSend', { missing })
      : this.translate('hintConfigRequiredToSend');
  }

  // -------------------------------------------------------------- providers

  providerConfigs(): Record<GeoAgentProviderId, GeoAgentProviderConfig> {
    return {
      'openai-responses': this.providerConfig('openai-responses'),
      'openai-chat': this.providerConfig('openai-chat'),
      anthropic: this.providerConfig('anthropic'),
      'openai-compatible': this.providerConfig('openai-compatible'),
      'anthropic-compatible': this.providerConfig('anthropic-compatible'),
    };
  }

  providerConfig(providerId: GeoAgentProviderId): GeoAgentProviderConfig {
    const base = BASE_PROVIDER_CONFIGS[providerId];
    return {
      ...base,
      storageKey: `${this.options.storagePrefix}.${providerId}.api_key`,
      defaultModel: defaultModelFor(providerId, this.options.defaultModel),
    };
  }

  /** API key label + placeholder for the current provider (for input chrome). */
  currentApiKeyChrome(): { label: string; placeholder: string } {
    const provider = this.providerConfig(this.state.providerId);
    return {
      label: this.localizedApiKeyLabel(provider.id),
      placeholder: provider.keyPlaceholder,
    };
  }

  private initialProviderId(): GeoAgentProviderId {
    const storedProvider = storageGet(`${this.options.storagePrefix}.provider`);
    if (storedProvider && storedProvider in BASE_PROVIDER_CONFIGS) {
      return storedProvider as GeoAgentProviderId;
    }
    return this.options.defaultProvider;
  }

  private initialModelId(providerId: GeoAgentProviderId): string {
    return (
      storageGet(this.modelStorageKey(providerId)) ||
      defaultModelFor(providerId, this.options.defaultModel)
    );
  }

  private modelStorageKey(providerId: GeoAgentProviderId): string {
    return `${this.options.storagePrefix}.model.${providerId}`;
  }

  private baseUrlStorageKey(providerId: GeoAgentProviderId): string {
    return `${this.options.storagePrefix}.baseUrl.${providerId}`;
  }

  private initialBaseUrl(providerId: GeoAgentProviderId): string {
    return storageGet(this.baseUrlStorageKey(providerId)) || '';
  }

  private earthEngineProjectIdStorageKey(): string {
    return `${this.options.storagePrefix}.earthEngine.projectId`;
  }

  /**
   * Load the persisted settings (model, committed API key, base URL) for the
   * current provider from sessionStorage. Host-supplied `apiKeys` act as the
   * fallback and are never written to storage here.
   */
  loadProviderSettings(): void {
    const provider = this.providerConfig(this.state.providerId);
    const initialApiKey = this.options.apiKeys?.[provider.id]?.trim() ?? '';
    this.state.modelId =
      storageGet(this.modelStorageKey(provider.id)) || provider.defaultModel;
    this.committedApiKey = storageGet(provider.storageKey) || initialApiKey;
    this.state.baseUrl = this.initialBaseUrl(provider.id);
  }

  /** Switch providers: persist the choice and reload its stored settings. */
  switchProvider(providerId: GeoAgentProviderId): void {
    if (!(providerId in BASE_PROVIDER_CONFIGS)) {
      return;
    }
    storageSet(`${this.options.storagePrefix}.provider`, providerId);
    this.state.providerId = providerId;
    this.loadProviderSettings();
    this.invalidateAgent();
    this.hideNote();
    this.applyIdleStatus(true);
    this.emit('statechange');
  }

  setModelId(value: string): void {
    const modelId = value.trim();
    this.state.modelId = modelId;
    if (modelId) {
      storageSet(this.modelStorageKey(this.state.providerId), modelId);
    } else {
      storageRemove(this.modelStorageKey(this.state.providerId));
    }
    this.invalidateAgent();
    this.emit('statechange');
  }

  setBaseUrl(value: string): void {
    const baseUrl = value.trim();
    this.state.baseUrl = baseUrl;
    if (baseUrl) {
      storageSet(this.baseUrlStorageKey(this.state.providerId), baseUrl);
    } else {
      storageRemove(this.baseUrlStorageKey(this.state.providerId));
    }
    this.invalidateAgent();
    this.emit('statechange');
  }

  setAllowCodeExecution(checked: boolean): void {
    this.state.allowCodeExecution = checked;
    this.invalidateAgent();
    this.emit('statechange');
  }

  setAllowDestructiveTools(checked: boolean): void {
    this.state.allowDestructiveTools = checked;
    this.emit('statechange');
  }

  /** React to an in-progress edit of the API key without committing it. */
  setApiKeyEdited(value: string): void {
    const apiKey = value.trim();
    if (apiKey && apiKey !== this.committedApiKey) {
      this.showNote(this.translate('notePressEnterToSaveKey'), 'info', false);
    } else if (!apiKey) {
      this.hideNote();
    }
  }

  /** Persist the typed API key and refresh the connection state. */
  commitApiKey(value: string): void {
    const apiKey = value.trim();
    this.committedApiKey = apiKey;
    const storageKey = this.providerConfig(this.state.providerId).storageKey;
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
    this.applyIdleStatus(true);
    this.emit('statechange');
  }

  /** The API key the agent actually uses (committed value, not live input). */
  getCommittedApiKey(): string {
    return this.committedApiKey;
  }

  /** Apply the current provider's default model ("Use latest" button). */
  applyLatestModel(): boolean {
    const latestModel = this.providerConfig(this.state.providerId).defaultModel;
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

  // ------------------------------------------------------------ earth engine

  /**
   * Merge Earth Engine settings (host OAuth client id, user project id),
   * persist the project id, and push the merged options to the tools. Called
   * during panel setup (before `attach` creates the tools) and on edits.
   */
  setEarthEngineSettings(patch: { oauthClientId?: string; projectId?: string }): void {
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
      if (projectId) {
        storageSet(this.earthEngineProjectIdStorageKey(), projectId);
      } else {
        storageRemove(this.earthEngineProjectIdStorageKey());
      }
    }
    this.options.earthEngine = merged;
    this.tools?.updateEarthEngineOptions(merged);
    this.emit('statechange');
  }

  /** Initial project id for the Earth Engine field (storage wins over options). */
  getEarthEngineProjectId(): string {
    return firstValue(
      storageGet(this.earthEngineProjectIdStorageKey()),
      this.options.earthEngine?.projectId,
    );
  }

  /** Localized Earth Engine status line for the settings section. */
  getEarthEngineStatusText(): string {
    const oauthClientId = firstValue(this.options.earthEngine?.oauthClientId);
    const accessToken = this.options.earthEngine?.accessToken?.trim();
    const projectId = this.options.earthEngine?.projectId?.trim() ?? '';
    const earthEngine = this.state.data?.earthEngine as
      | { initialized?: boolean; layerCount?: number }
      | undefined;
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

  // --------------------------------------------------------- configured state

  /**
   * Whether the agent has everything it needs to run a prompt for the current
   * provider: a committed API key, a model id, and (for compatible providers)
   * a valid base URL.
   */
  isConfigured(): boolean {
    // Uses the committed key (not the live input) so typing a key does not flip
    // the badge to "Ready" before the user commits it.
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
   * Human-readable, comma-separated list of the configuration fields that are
   * still missing for the current provider (empty when fully configured).
   */
  missingConfigSummary(): string {
    const missing: string[] = [];
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

  private readyLogMessage(): string {
    if (this.isConfigured()) {
      return this.translate('logReady');
    }
    const missing = this.missingConfigSummary();
    return missing
      ? this.translate('logLoadedWithMissing', { missing })
      : this.translate('logLoaded');
  }

  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, '');
  }

  /**
   * Whether a custom base URL is an absolute http(s) URL. Relative values (e.g.
   * `api` or `/proxy`) would resolve against the app origin and leak the API key
   * to the wrong endpoint, so they are rejected.
   */
  private isValidBaseUrl(baseUrl: string): boolean {
    const trimmed = baseUrl.trim();
    if (!trimmed) {
      return false;
    }
    try {
      const url = new URL(trimmed);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ status badge

  getStatus(): GeoAgentStatusState {
    return { ...this.status };
  }

  private setStatusState(text: string, kind: string, transient: boolean): void {
    this.status = { text, kind, transient };
    this.emitStatus();
  }

  /**
   * Render the idle status badge from the current configuration and record its
   * kind. The idle status is recomputed from the configuration, so it flips
   * between ready/setup as the user fills in or clears credentials.
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
   * Render a transient status (Running, Cancelled, Error, Copied) and clear the
   * idle-kind tracking so the badge is not clobbered by configuration changes
   * until the next forced idle refresh.
   */
  private setTransientStatus(text: string, kind: string): void {
    this.setStatusState(text, kind, true);
    this.idleStatusKind = null;
  }

  /**
   * Refresh the idle status badge so it reflects whether the agent has the
   * credentials it needs. Transient run statuses (Running, Cancelled, Error,
   * Copied) are left untouched unless `force` is set, so this can be called
   * from configuration changes on every keystroke without clobbering them.
   */
  applyIdleStatus(force = false): void {
    // A forced refresh (run finished, copy timeout, mount) must win even while
    // `busy` is still set, otherwise the badge stays stuck on "Running" because
    // the post-run call happens before the finally block clears `busy`.
    if (this.state.busy && !force) {
      return;
    }
    if (!force && this.idleStatusKind === null) {
      return;
    }
    this.setIdleBadge();
  }

  // ----------------------------------------------------- configuration notes

  private showNote(
    text: string,
    kind: 'success' | 'error' | 'info',
    autoHide: boolean,
  ): void {
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

  private hideNote(): void {
    if (this.noteTimer !== null) {
      clearTimeout(this.noteTimer);
      this.noteTimer = null;
    }
    this.note = { text: '', kind: null };
    this.emitNote();
  }

  // ------------------------------------------------------------ conversation

  getConversation(): GeoAgentConversationEntry[] {
    return [...this.entries];
  }

  private appendEntry(
    role: GeoAgentConversationEntry['role'],
    content: string,
    markdown = false,
  ): GeoAgentConversationEntry {
    const entry: GeoAgentConversationEntry = markdown
      ? { id: generateEntryId(), role, content, markdown: true }
      : { id: generateEntryId(), role, content };
    this.entries.push(entry);
    this.emitConversation({ type: 'append', entry });
    return entry;
  }

  private updateEntry(id: string, content: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) {
      return;
    }
    entry.content = content;
    this.emitConversation({ type: 'update', entry });
  }

  /** Reset the conversation, invalidate the agent, and log the clear. */
  clearConversation(): void {
    if (this.state.busy) {
      return;
    }
    this.entries = [];
    this.streamingEntryId = null;
    this.streamingAssistantText = '';
    this.invalidateAgent();
    this.emitConversation({ type: 'reset' });
    this.appendEntry('system', this.translate('logChatCleared'));
  }

  /** Export the conversation as Markdown sections, one per entry. */
  conversationMarkdown(): string {
    return this.entries
      .map(
        (entry) =>
          `## ${markdownHeading(entry.role)}\n\n${entry.content.trim()}`,
      )
      .filter((section) => section.trim().length > 0)
      .join('\n\n');
  }

  /** Copy the conversation to the clipboard and flash the Copied badge. */
  async copyConversationAsMarkdown(): Promise<void> {
    const markdown = this.conversationMarkdown();
    if (!markdown) {
      return;
    }
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API is unavailable.');
      }
      await navigator.clipboard.writeText(markdown);
    } catch {
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
    this.statusCopyTimer = setTimeout(() => {
      this.statusCopyTimer = null;
      this.applyIdleStatus(true);
    }, 1200);
  }

  // ------------------------------------------------------------------ agent

  private invalidateAgent(): void {
    this.agent = null;
    this.agentSignature = '';
  }

  isCancelRequested(): boolean {
    return this.cancelRequested;
  }

  cancelActiveRun(): void {
    if (!this.state.busy || this.cancelRequested) {
      return;
    }
    this.cancelRequested = true;
    this.activeAbortController?.abort();
    this.agent?.cancel();
    this.setTransientStatus(this.translate('statusCancelling'), 'connected');
    this.appendEntry('system', this.translate('logCancelRequested'));
    this.emit('statechange');
  }

  private async createProviderModel(
    providerId: GeoAgentProviderId,
    modelId: string,
    apiKey: string,
    baseUrl: string,
  ): Promise<Model> {
    if (providerId === 'openai-responses' || providerId === 'openai-chat') {
      const { OpenAIModel } = await import('@strands-agents/sdk/models/openai');
      return new OpenAIModel({
        api: providerId === 'openai-responses' ? 'responses' : 'chat',
        modelId,
        apiKey,
        clientConfig: {
          dangerouslyAllowBrowser: true,
        },
      });
    }
    if (providerId === 'openai-compatible') {
      const { OpenAIModel } = await import('@strands-agents/sdk/models/openai');
      return new OpenAIModel({
        api: 'chat',
        modelId,
        apiKey,
        clientConfig: {
          dangerouslyAllowBrowser: true,
          baseURL: this.normalizeBaseUrl(baseUrl),
        },
      });
    }
    if (providerId === 'anthropic' || providerId === 'anthropic-compatible') {
      const { AnthropicModel } = await import('@strands-agents/sdk/models/anthropic');
      return new AnthropicModel({
        modelId,
        apiKey,
        // Anthropic-compatible gateways are pointable at a self-hosted base URL
        // the same way OpenAI-compatible endpoints are.
        clientConfig: {
          dangerouslyAllowBrowser: true,
          ...(providerId === 'anthropic-compatible'
            ? { baseURL: this.normalizeBaseUrl(baseUrl) }
            : {}),
        },
      });
    }
    throw new Error(`Unsupported browser provider: ${providerId}`);
  }

  private async getAgent(): Promise<Agent> {
    if (!this.tools) {
      throw new Error('GeoAgent control is not mounted.');
    }
    const provider = this.providerConfig(this.state.providerId);
    const apiKey = this.committedApiKey.trim();
    const modelId = this.state.modelId.trim();
    const baseUrl = this.state.baseUrl.trim();
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

    const systemPromptParts = [
      BROWSER_MAPLIBRE_SYSTEM_PROMPT,
      this.state.allowCodeExecution ? BROWSER_MAPLIBRE_CODE_SYSTEM_PROMPT : '',
      this.options.customSystemPrompt?.trim() ?? '',
    ].filter(Boolean);
    const systemPrompt = systemPromptParts.join('\n\n');
    const model = await this.createProviderModel(provider.id, modelId, apiKey, baseUrl);
    this.agent = new Agent({
      name: 'GeoAgent MapLibre Browser',
      model,
      systemPrompt,
      tools: [...this.tools.createTools(), ...this.resolveCustomTools()],
      printer: false,
      toolExecutor: 'sequential',
    });
    this.agentSignature = signature;
    return this.agent;
  }

  private resolveCustomTools(): Tool[] {
    const tools = this.options.customTools;
    if (!tools) {
      return [];
    }
    return (typeof tools === 'function' ? tools() : tools) as Tool[];
  }

  // ------------------------------------------------------------- run a prompt

  private appendAssistantDelta(text: string): void {
    if (!text) {
      return;
    }
    if (!this.streamingEntryId) {
      const entry = this.appendEntry('assistant', '', true);
      this.streamingEntryId = entry.id;
    }
    this.streamingAssistantText += text;
    this.updateEntry(this.streamingEntryId, this.streamingAssistantText);
  }

  private handleAgentStreamEvent(event: AgentStreamEvent): string | undefined {
    if (event.type === 'modelStreamUpdateEvent') {
      const modelEvent = event.event;
      if (
        modelEvent.type === 'modelContentBlockDeltaEvent' &&
        modelEvent.delta.type === 'textDelta'
      ) {
        this.appendAssistantDelta(modelEvent.delta.text);
      }
      return undefined;
    }

    if (event.type === 'beforeToolCallEvent') {
      this.appendEntry('tool', this.translate('logRunningTool', { tool: event.toolUse.name }));
      return undefined;
    }

    if (event.type === 'agentResultEvent') {
      return event.result.toString();
    }

    return undefined;
  }

  /**
   * Run a prompt through the agent. The text has already been read and cleared
   * by the UI layer; the core records it, streams the answer into a single
   * assistant entry, and owns the busy/cancel lifecycle.
   */
  async sendPrompt(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.state.busy) {
      return;
    }
    this.rememberPrompt(trimmed);
    this.appendEntry('user', trimmed);
    this.streamingEntryId = null;
    this.streamingAssistantText = '';
    this.state.busy = true;
    this.cancelRequested = false;
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.setTransientStatus(this.translate('statusRunning'), 'connected');
    this.emit('statechange');
    try {
      const activeAgent = await this.getAgent();
      let finalAnswer = '';
      for await (const event of activeAgent.stream(trimmed, {
        cancelSignal: abortController.signal,
      })) {
        finalAnswer = this.handleAgentStreamEvent(event) ?? finalAnswer;
      }
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
      const message = error instanceof Error ? error.message : String(error);
      if (abortController.signal.aborted) {
        this.appendEntry('assistant', this.translate('answerCancelled'), true);
        this.setTransientStatus(this.translate('statusCancelled'), 'connected');
      } else {
        this.appendEntry('error', message);
        this.setTransientStatus(this.translate('statusError'), 'error');
      }
    } finally {
      this.state.busy = false;
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
      this.cancelRequested = false;
      this.streamingEntryId = null;
      this.streamingAssistantText = '';
      this.emit('statechange');
    }
  }

  // ---------------------------------------------------------- prompt history

  private rememberPrompt(text: string): void {
    if (this.promptHistory[this.promptHistory.length - 1] !== text) {
      this.promptHistory.push(text);
    }
    this.promptHistoryIndex = -1;
    this.promptHistoryDraft = '';
  }

  /**
   * Previous prompt for ArrowUp navigation. Returns null when navigation does
   * not apply (no history, or the caret is not on the textarea's first line).
   */
  historyUp(value: string, selectionStart: number, _selectionEnd: number): string | null {
    if (this.promptHistory.length === 0) {
      return null;
    }
    const beforeSelection = value.slice(0, selectionStart);
    if (beforeSelection.includes('\n')) {
      return null;
    }
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
   * Next prompt for ArrowDown navigation. Returns null when navigation does
   * not apply (not currently navigating, or the caret is not on the last line;
   * a null past the end of history restores the in-progress draft).
   */
  historyDown(value: string, _selectionStart: number, selectionEnd: number): string | null {
    if (this.promptHistory.length === 0 || this.promptHistoryIndex === -1) {
      return null;
    }
    const afterSelection = value.slice(selectionEnd);
    if (afterSelection.includes('\n')) {
      return null;
    }
    this.promptHistoryIndex += 1;
    if (this.promptHistoryIndex >= this.promptHistory.length) {
      this.promptHistoryIndex = -1;
      return this.promptHistoryDraft;
    }
    return this.promptHistory[this.promptHistoryIndex];
  }

  // ------------------------------------------------------------- panel sizes

  private constrainPanelWidth(width: number): number {
    return Math.max(
      this.options.panelMinWidth,
      Math.min(this.options.panelMaxWidth, Math.round(width)),
    );
  }

  private constrainPanelHeight(height: number): number {
    // The map container is the practical ceiling, so the panel can be dragged
    // to nearly fill it (not just the option default).
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
