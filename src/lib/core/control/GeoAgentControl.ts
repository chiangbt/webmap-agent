/**
 * 命令式 MapLibre 控件 GeoAgentControl：包装无头引擎 GeoAgentCore，渲染
 * 浮动聊天面板（切换按钮、设置区、聊天日志、拖拽手柄），并把全部用户交互
 * 转发给核心。配置、agent 与会话均由 core 持有。
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { IControl, Map as MapLibreMap } from 'maplibre-gl';
import { GeoAgentCore } from '../GeoAgentCore';
import { resolveMapContainer } from '../map-container';
import type { GeoAgentTools } from '../tools/geoagent-tools';
import type {
  GeoAgentControlEvent,
  GeoAgentControlEventHandler,
  GeoAgentControlOptions,
  GeoAgentConversationEntry,
  GeoAgentProviderId,
  GeoAgentState,
  GeoAgentStatusState,
} from '../types';

/** 浮动面板内部 DOM 元素的引用集合，由 createPanel 构建后缓存，供各渲染/同步方法直接访问。 */
interface GeoAgentUi {
  status: HTMLSpanElement;
  settingsDetails: HTMLDetailsElement;
  providerSelect: HTMLSelectElement;
  apiKeyLabel: HTMLSpanElement;
  apiKeyInput: HTMLInputElement;
  baseUrlLabel: HTMLLabelElement;
  baseUrlInput: HTMLInputElement;
  modelIdInput: HTMLInputElement;
  modelSuggestions: HTMLUListElement;
  loadModelsButton: HTMLButtonElement;
  configNote: HTMLDivElement;
  earthEngineDetails: HTMLDetailsElement;
  earthEngineClientIdInput: HTMLInputElement;
  earthEngineProjectIdInput: HTMLInputElement;
  earthEngineStatus: HTMLDivElement;
  permissionRow: HTMLDivElement;
  allowCodeInput: HTMLInputElement;
  allowDestructiveInput: HTMLInputElement;
  log: HTMLDivElement;
  form: HTMLFormElement;
  prompt: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  copyButton: HTMLButtonElement;
  resizeHandleLeft: HTMLDivElement;
  resizeHandleRight: HTMLDivElement;
  closeButton: HTMLButtonElement;
}

/** 面板可拖拽调整尺寸的角：左下或右下。 */
type PanelResizeCorner = 'bottom-left' | 'bottom-right';

/**
 * 命令式 MapLibre 控件，包装 {@link GeoAgentCore}。核心负责配置、agent 与
 * 会话；本类渲染浮动面板（切换按钮、设置区、聊天日志、resize 手柄），
 * 并把每个用户交互转发给核心。
 */
export class GeoAgentControl implements IControl {
  /** 无头引擎核心：配置、agent 与会话都在这里，控件只做渲染与转发。 */
  private readonly core: GeoAgentCore;
  /** onAdd 传入的地图实例。 */
  private map?: MapLibreMap;
  /** 地图 DOM 容器，用于面板定位与拖拽钳制。 */
  private mapContainer?: HTMLElement;
  /** IControl 根容器（包含切换按钮，返回给 MapLibre 停靠）。 */
  private container?: HTMLElement;
  /** 浮动面板根元素（挂在地图容器上，而非 IControl 容器里）。 */
  private panel?: HTMLElement;
  /** 面板内部元素的引用集合。 */
  private ui?: GeoAgentUi;
  /** window resize 监听器，用于重算面板位置。 */
  private resizeHandler: (() => void) | null = null;
  /** 地图 resize 监听器，用于重算面板位置。 */
  private mapResizeHandler: (() => void) | null = null;
  /** 拖拽调整尺寸过程中的 mousemove 监听器。 */
  private panelResizeMoveHandler: ((e: MouseEvent) => void) | null = null;
  /** 拖拽结束的 mouseup 监听器。 */
  private panelResizeUpHandler: (() => void) | null = null;
  // 每个控件实例唯一的自增计数，保证多个控件共存于同一页面时，模型输入框的
  // aria-controls 仍指向它自己的建议列表。
  private static instanceCount = 0;
  /** 模型建议列表（ul）的元素 id，与输入框的 aria-controls 配对。 */
  private readonly modelListId = `geoagent-model-list-${(GeoAgentControl.instanceCount += 1)}`;
  // 自定义建议下拉所用的已加载模型名列表。刻意不用原生 <datalist>：在 Chrome
  // 中点击模型字段弹出长列表的原生 datalist 弹层会让渲染进程卡死。
  private modelOptions: string[] = [];
  // 当前高亮建议的下标（-1 = 无），以及下拉里当前渲染的值（过滤后的子集）。
  private activeSuggestion = -1;
  private renderedSuggestions: string[] = [];
  /** 输入框失焦后延迟关闭建议列表的定时器（给点击建议留时间）。 */
  private suggestionBlurTimer: ReturnType<typeof setTimeout> | null = null;
  // 上一次控件刷新时 agent 是否已配置完成；用于在配置首次完成时收起设置区。
  private wasConfigured = false;
  // 流式 markdown 渲染的合帧缓冲：entryId → 最新内容。每个文本增量都全量
  // 重跑 marked + DOMPurify 是 O(n²)，合帧成每帧最多渲染一轮（取每个条目
  // 的最新内容）。
  private pendingMarkdownUpdates = new globalThis.Map<string, string>();
  /** 尚未触发的 markdown 合帧句柄；null 表示没有排队的渲染。 */
  private markdownFlushHandle: number | null = null;

  /**
   * 构造命令式控件：选项原样交给 GeoAgentCore 保存并归一化。
   *
   * @param options 控件可配置项，全部可省略
   */
  constructor(options: GeoAgentControlOptions = {}) {
    this.core = new GeoAgentCore(options);
  }

  /** 选项存放在 core 中；引擎挂载辅助函数会读写其中的 `position`。 */
  private get options(): GeoAgentCore['options'] {
    return this.core.options;
  }

  /** 内部状态的活引用（未拷贝），供渲染侧读取。 */
  private get state(): GeoAgentState {
    return this.core.peekState();
  }

  /** 核心中与引擎绑定的工具集；挂载前为 undefined。 */
  get tools(): GeoAgentTools | undefined {
    return this.core.getTools();
  }

  /** MapLibre IControl 生命周期：构建控件容器与浮动面板并接入核心。 */
  onAdd(map: MapLibreMap): HTMLElement {
    this.map = map;
    // MapLibre/Mapbox/Leaflet 宿主暴露 getContainer()；OpenLayers 地图暴露
    // getTargetElement()；ArcGIS MapView 暴露 `container` 属性——
    // resolveMapContainer 全部兼容，保证展开后的面板在每种引擎下都有宿主容器。
    const mapContainer = resolveMapContainer(map);
    if (!mapContainer) {
      throw new Error(
        'GeoAgentControl: the map exposes neither getContainer() nor getTargetElement() nor a container element; cannot mount the agent panel.',
      );
    }
    this.mapContainer = mapContainer;
    this.container = this.createContainer();
    this.panel = this.createPanel();
    // 浮动面板直接挂在地图容器上，随地图缩放定位，而非放进 IControl 停靠容器。
    this.mapContainer.appendChild(this.panel);
    // 先订阅核心事件再 attach，保证不漏掉任何事件；attach 期间触发的快照
    // （状态徽标、就绪日志条目）随后即被渲染出来。
    this.subscribeCoreEvents();
    this.core.attach(map);
    this.setupEventListeners();
    // 仅当仍需配置时让设置区初始展开；配置完成后该区自动收起，给聊天留出
    // 更多空间（无论哪种情况状态徽标都会展示连接状态）。
    if (this.ui) {
      this.wasConfigured = this.core.isConfigured();
      this.ui.settingsDetails.open = !this.wasConfigured;
      this.syncUiFromState();
      this.ui.apiKeyInput.value = this.core.getCommittedApiKey();
    }
    this.updateControls();

    if (!this.state.collapsed) {
      this.panel.classList.add('expanded');
      // 延后一帧再定位：等面板完成布局后测量按钮与容器的位置才准确。
      requestAnimationFrame(() => this.updatePanelPosition());
    }

    return this.container;
  }

  /** IControl 生命周期：解绑全部监听器、销毁核心并移除 DOM。 */
  onRemove(): void {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.mapResizeHandler && this.map) {
      this.map.off('resize', this.mapResizeHandler);
      this.mapResizeHandler = null;
    }
    // 拖拽进行中也要摘掉 document 级的 mousemove/mouseup 监听。
    this.stopPanelResize();
    if (this.suggestionBlurTimer !== null) {
      clearTimeout(this.suggestionBlurTimer);
      this.suggestionBlurTimer = null;
    }
    // 取消尚未触发的 markdown 合帧渲染。
    if (this.markdownFlushHandle !== null) {
      cancelAnimationFrame(this.markdownFlushHandle);
      this.markdownFlushHandle = null;
    }
    this.pendingMarkdownUpdates.clear();
    this.core.dispose();
    this.panel?.parentNode?.removeChild(this.panel);
    this.container?.parentNode?.removeChild(this.container);
    this.map = undefined;
    this.mapContainer = undefined;
    this.container = undefined;
    this.panel = undefined;
    this.ui = undefined;
    this.modelOptions = [];
    this.renderedSuggestions = [];
    this.activeSuggestion = -1;
    this.wasConfigured = false;
  }

  /** 返回状态快照（含 data 的浅拷贝）。 */
  getState(): GeoAgentState {
    return this.core.getState();
  }

  /** 合并部分状态，并把经核心钳制后的面板尺寸镜像到浮动面板上。 */
  setState(newState: Partial<GeoAgentState>): void {
    this.core.setState(newState);
    // 核心已把尺寸钳制到合法区间；这里把最终值同步到浮动面板。
    if (newState.panelWidth !== undefined && this.panel) {
      this.panel.style.width = `${this.state.panelWidth}px`;
    }
    if (newState.panelHeight !== undefined && this.panel) {
      this.panel.style.height = `${this.state.panelHeight}px`;
    }
  }

  /** 切换面板折叠状态。 */
  toggle(): void {
    this.core.toggle();
  }

  /** 展开面板；已展开时无操作。 */
  expand(): void {
    this.core.expand();
  }

  /** 折叠面板；已折叠时无操作。 */
  collapse(): void {
    this.core.collapse();
  }

  /** 订阅通用事件（collapse/expand/statechange）。 */
  on(event: GeoAgentControlEvent, handler: GeoAgentControlEventHandler): void {
    this.core.on(event, handler);
  }

  /** 取消通用事件订阅。 */
  off(event: GeoAgentControlEvent, handler: GeoAgentControlEventHandler): void {
    this.core.off(event, handler);
  }

  /** 返回当前绑定的地图实例。 */
  getMap(): MapLibreMap | undefined {
    return this.core.getMap();
  }

  /** 返回 IControl 根容器（含切换按钮）。 */
  getContainer(): HTMLElement | undefined {
    return this.container;
  }

  /** 返回浮动面板根元素。 */
  getPanel(): HTMLElement | undefined {
    return this.panel;
  }

  // ------------------------------------------------------------ 核心事件

  /** 订阅核心的会话/状态/提示流与状态变化事件并渲染到面板 DOM。 */
  private subscribeCoreEvents(): void {
    // 会话按增量类型渲染：reset 清空重挂，append/update 定点增改。
    this.core.onConversation((change, entries) => {
      if (!this.ui) {
        return;
      }
      if (change.type === 'reset') {
        this.ui.log.replaceChildren();
        // 缓冲里的条目 DOM 已整体拆除：清空待渲染缓冲，避免渲染到失效 id。
        this.pendingMarkdownUpdates.clear();
      } else if (change.type === 'append' && change.entry) {
        this.appendLogEntry(change.entry);
      } else if (change.type === 'update' && change.entry) {
        this.updateLogEntry(change.entry);
      }
      // 复制按钮随已渲染的会话内容联动：没有条目时禁用。
      this.ui.copyButton.disabled = entries.length === 0;
    });
    this.core.onStatus((status) => this.renderStatus(status));
    // 配置提示：有文本按 kind 着色展示，无文本隐藏并清空。
    this.core.onNote((note) => {
      if (!this.ui) {
        return;
      }
      if (note.text) {
        this.ui.configNote.textContent = note.text;
        this.ui.configNote.className = `geoagent-config-note ${note.kind ?? ''}`.trim();
        this.ui.configNote.hidden = false;
      } else {
        this.ui.configNote.hidden = true;
        this.ui.configNote.textContent = '';
      }
    });
    this.core.on('collapse', () => {
      this.panel?.classList.remove('expanded');
    });
    this.core.on('expand', () => {
      this.panel?.classList.add('expanded');
      this.updatePanelPosition();
    });
    this.core.on('statechange', () => {
      this.syncUiFromState();
      this.updateControls();
    });
  }

  /** 把核心推送的状态徽标渲染到头部状态区。 */
  private renderStatus(status: GeoAgentStatusState): void {
    if (!this.ui) {
      return;
    }
    this.ui.status.textContent = status.text;
    // kind 直接拼进 class，CSS 由此区分 connected/setup/error 等样式。
    this.ui.status.className = `geoagent-status ${status.kind}`.trim();
  }

  // -------------------------------------------------------------- 面板 DOM

  /** 创建 IControl 根容器与折叠状态下的切换按钮（内联 SVG 图标）。 */
  private createContainer(): HTMLElement {
    const container = document.createElement('div');
    // 复用 MapLibre 官方 ctrl 样式类获得默认外观，附加自定义类与宿主 className。
    container.className = `maplibregl-ctrl maplibregl-ctrl-group geoagent-control${
      this.options.className ? ` ${this.options.className}` : ''
    }`;

    const toggleButton = document.createElement('button');
    toggleButton.className = 'geoagent-control-toggle';
    toggleButton.type = 'button';
    toggleButton.title = this.options.title;
    toggleButton.setAttribute('aria-label', this.options.title);
    toggleButton.setAttribute('aria-expanded', String(!this.state.collapsed));
    toggleButton.innerHTML = `
      <span class="geoagent-control-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 6V3"></path>
          <path d="M9 3h6"></path>
          <rect x="4" y="6" width="16" height="12" rx="4"></rect>
          <path d="M8 18 6 21v-3"></path>
          <path d="M9 12h.01"></path>
          <path d="M15 12h.01"></path>
          <path d="M9 15h6"></path>
        </svg>
      </span>
    `;
    toggleButton.addEventListener('click', () => this.toggle());
    container.appendChild(toggleButton);
    return container;
  }

  /**
   * 创建浮动面板 DOM：头部（标题/状态徽标/关闭按钮）、设置区、Earth Engine
   * 区、权限开关行、聊天日志与输入表单，以及两个 resize 手柄；随后收集元素
   * 引用、装配 Earth Engine 控件并绑定事件。
   */
  private createPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'geoagent-panel';
    panel.style.width = `${this.state.panelWidth}px`;
    if (this.state.panelHeight !== undefined) {
      panel.style.height = `${this.state.panelHeight}px`;
    }

    const header = document.createElement('div');
    header.className = 'geoagent-panel-header';

    const title = document.createElement('span');
    title.className = 'geoagent-panel-title';
    title.textContent = this.options.title;

    const headerActions = document.createElement('div');
    headerActions.className = 'geoagent-title-actions';

    const status = document.createElement('span');
    status.className = 'geoagent-status connected';
    status.textContent = this.core.translate('statusReady');

    const closeButton = document.createElement('button');
    closeButton.className = 'geoagent-icon-button';
    closeButton.type = 'button';
    closeButton.title = this.core.translate('closeButtonLabel');
    closeButton.setAttribute('aria-label', this.core.translate('closeButtonLabel'));
    closeButton.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 6 6 18"></path>
        <path d="m6 6 12 12"></path>
      </svg>
    `;
    closeButton.addEventListener('click', () => this.collapse());

    headerActions.append(status, closeButton);
    header.append(title, headerActions);

    const content = document.createElement('div');
    content.className = 'geoagent-panel-content';
    content.innerHTML = `
      <details class="geoagent-settings">
        <summary>${this.core.translate('settingsSummary')}</summary>
        <div class="geoagent-settings-grid">
          <label>
            ${this.core.translate('providerLabel')}
            <select class="geoagent-provider"></select>
          </label>
          <label>
            <span class="geoagent-api-key-label">${this.core.translate('apiKeyLabelGeneric')}</span>
            <input class="geoagent-api-key" type="password" autocomplete="off" placeholder="sk-..." />
          </label>
          <label class="geoagent-base-url-row" hidden>
            ${this.core.translate('baseUrlLabel')}
            <input class="geoagent-base-url" autocomplete="off" placeholder="https://host/v1" />
          </label>
          <label class="geoagent-model-cell">
            ${this.core.translate('modelLabel')}
            <div class="geoagent-model-row">
              <input class="geoagent-model-id" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${this.modelListId}" />
              <button class="geoagent-load-models secondary" type="button">${this.core.translate('useLatestButton')}</button>
            </div>
            <ul class="geoagent-model-suggestions" id="${this.modelListId}" role="listbox" hidden></ul>
          </label>
          <div class="geoagent-config-note" aria-live="polite" hidden></div>
        </div>
      </details>

      <details class="geoagent-earth-engine">
        <summary>${this.core.translate('earthEngineSummary')}</summary>
        <input class="geoagent-ee-client-id" type="hidden" />
        <div class="geoagent-earth-engine-grid">
          <label>
            ${this.core.translate('earthEngineProjectLabel')}
            <input class="geoagent-ee-project-id" autocomplete="off" placeholder="Earth Engine project" />
          </label>
        </div>
        <div class="geoagent-earth-engine-status"></div>
      </details>

      <div class="geoagent-toggle-row" aria-label="${this.core.translate('permissionRowLabel')}">
        <label class="geoagent-checkbox-row">
          <input class="geoagent-allow-code" type="checkbox" />
          <span>${this.core.translate('permissionCodeLabel')}</span>
        </label>
        <label class="geoagent-checkbox-row">
          <input class="geoagent-allow-destructive" type="checkbox" />
          <span>${this.core.translate('permissionDestructiveLabel')}</span>
        </label>
      </div>

      <div class="geoagent-log" aria-live="polite"></div>

      <form class="geoagent-form">
        <label>
          ${this.core.translate('promptLabel')}
          <textarea class="geoagent-prompt" placeholder="${this.core.translate('promptPlaceholder')}"></textarea>
        </label>
        <div class="geoagent-actions">
          <button class="geoagent-send" type="submit" disabled>${this.core.translate('sendButton')}</button>
          <button class="geoagent-cancel secondary" type="button" disabled>${this.core.translate('cancelButton')}</button>
          <button class="geoagent-copy secondary" type="button">${this.core.translate('copyMarkdownButton')}</button>
        </div>
      </form>
    `;

    const resizeHandleLeft = this.createResizeHandle('bottom-left');
    const resizeHandleRight = this.createResizeHandle('bottom-right');

    panel.append(header, content, resizeHandleLeft, resizeHandleRight);
    // 按选择器收集全部交互元素的强类型引用；任何一个缺失都立即抛错。
    this.ui = {
      status,
      settingsDetails: this.requiredElement(content, '.geoagent-settings'),
      providerSelect: this.requiredElement(content, '.geoagent-provider'),
      apiKeyLabel: this.requiredElement(content, '.geoagent-api-key-label'),
      apiKeyInput: this.requiredElement(content, '.geoagent-api-key'),
      baseUrlLabel: this.requiredElement(content, '.geoagent-base-url-row'),
      baseUrlInput: this.requiredElement(content, '.geoagent-base-url'),
      modelIdInput: this.requiredElement(content, '.geoagent-model-id'),
      modelSuggestions: this.requiredElement(content, '.geoagent-model-suggestions'),
      loadModelsButton: this.requiredElement(content, '.geoagent-load-models'),
      configNote: this.requiredElement(content, '.geoagent-config-note'),
      earthEngineDetails: this.requiredElement(content, '.geoagent-earth-engine'),
      earthEngineClientIdInput: this.requiredElement(content, '.geoagent-ee-client-id'),
      earthEngineProjectIdInput: this.requiredElement(content, '.geoagent-ee-project-id'),
      earthEngineStatus: this.requiredElement(content, '.geoagent-earth-engine-status'),
      permissionRow: this.requiredElement(content, '.geoagent-toggle-row'),
      allowCodeInput: this.requiredElement(content, '.geoagent-allow-code'),
      allowDestructiveInput: this.requiredElement(content, '.geoagent-allow-destructive'),
      log: this.requiredElement(content, '.geoagent-log'),
      form: this.requiredElement(content, '.geoagent-form'),
      prompt: this.requiredElement(content, '.geoagent-prompt'),
      sendButton: this.requiredElement(content, '.geoagent-send'),
      cancelButton: this.requiredElement(content, '.geoagent-cancel'),
      copyButton: this.requiredElement(content, '.geoagent-copy'),
      resizeHandleLeft,
      resizeHandleRight,
      closeButton,
    };
    // 权限开关行默认隐藏，只有宿主显式开启才展示。
    this.ui.permissionRow.hidden = !this.options.showPermissionToggles;
    this.setupEarthEngineControls();
    this.populateProviderOptions();
    this.wireUiEvents();
    this.syncUiFromState();
    return panel;
  }

  /** 按 selector 查找元素并断言类型；缺失时抛错，使模板与代码不一致尽早暴露。 */
  private requiredElement<T extends Element>(parent: ParentNode, selector: string): T {
    const element = parent.querySelector<T>(selector);
    if (!element) {
      throw new Error(`Missing required element: ${selector}`);
    }
    return element;
  }

  /** 用核心的 provider 配置填充 provider 下拉框选项。 */
  private populateProviderOptions(): void {
    if (!this.ui) {
      return;
    }
    this.ui.providerSelect.replaceChildren();
    for (const provider of Object.values(this.core.providerConfigs())) {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.label;
      this.ui.providerSelect.appendChild(option);
    }
  }

  /** 装配 Earth Engine 设置区：按凭据完整度决定展开状态，并同步配置进核心。 */
  private setupEarthEngineControls(): void {
    if (!this.ui) {
      return;
    }
    // 宿主未提供配置或显式 enabled=false 时整块隐藏。
    const enabled =
      !!this.options.earthEngine && this.options.earthEngine.enabled !== false;
    this.ui.earthEngineDetails.hidden = !enabled;
    if (!enabled) {
      return;
    }
    const oauthClientId = this.options.earthEngine?.oauthClientId?.trim() ?? '';
    const accessToken = this.options.earthEngine?.accessToken?.trim() ?? '';
    const projectId = this.core.getEarthEngineProjectId();
    this.ui.earthEngineClientIdInput.value = oauthClientId;
    this.ui.earthEngineProjectIdInput.value = projectId;
    // 缺凭据或缺 project id 时默认展开该区，引导用户补全。
    this.ui.earthEngineDetails.open = (!oauthClientId && !accessToken) || !projectId;
    // 在 `attach` 创建工具之前把设置合并进核心选项，保证工具观察到的值
    // 与面板展示的一致。
    this.core.setEarthEngineSettings({ oauthClientId, projectId });
    this.renderEarthEngineStatus();
  }

  /** 把核心计算的 Earth Engine 状态文案渲染到设置区（区块隐藏时跳过）。 */
  private renderEarthEngineStatus(): void {
    if (!this.ui || this.ui.earthEngineDetails.hidden) {
      return;
    }
    this.ui.earthEngineStatus.textContent = this.core.getEarthEngineStatusText();
  }

  // ------------------------------------------------------------- UI 事件

  /** 为面板全部交互元素绑定事件监听（表单提交、设置编辑、模型建议、快捷键）。 */
  private wireUiEvents(): void {
    const ui = this.ui;
    if (!ui) {
      return;
    }
    ui.form.addEventListener('submit', (event) => {
      // 阻止表单默认提交导致的页面刷新，改走核心的发送流程。
      event.preventDefault();
      this.submitPrompt();
    });
    ui.providerSelect.addEventListener('change', () => {
      const providerId = this.currentProviderId();
      this.core.switchProvider(providerId);
      // 已提交的 key 按 provider 隔离；切换后展示新 provider 载入的 key。
      this.ui!.apiKeyInput.value = this.core.getCommittedApiKey();
      this.resetModelOptions();
    });
    // API key 只在用户提交（Enter 或失焦）时保存并重估徽标/连接状态，不随
    // 每次键入保存：输入到一半的 key 不能把徽标翻成 "Ready" 或写入 storage。
    // 提交时机为 Enter 或字段失焦（原生 `change` 事件）。
    ui.apiKeyInput.addEventListener('input', () => {
      this.core.setApiKeyEdited(ui.apiKeyInput.value);
      this.updateControls();
    });
    ui.apiKeyInput.addEventListener('change', () => {
      this.core.commitApiKey(ui.apiKeyInput.value);
    });
    ui.apiKeyInput.addEventListener('keydown', (event) => {
      // Enter 直接提交；排除输入法组合中的 Enter，避免中文输入法误提交。
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        this.core.commitApiKey(ui.apiKeyInput.value);
      }
    });
    ui.baseUrlInput.addEventListener('input', () => {
      this.core.setBaseUrl(ui.baseUrlInput.value);
      this.updateControls();
    });
    ui.loadModelsButton.addEventListener('click', () => {
      this.core.applyLatestModel();
      this.closeModelSuggestions();
    });
    // 模型字段是由自定义建议下拉（geoagent-model-suggestions）支撑的 combobox，
    // 不用原生 <datalist>：Chrome 打开长列表的原生 datalist 弹层会卡死渲染进程。
    ui.modelIdInput.addEventListener('input', () => {
      this.core.setModelId(ui.modelIdInput.value);
      this.updateControls();
      this.openModelSuggestions();
    });
    ui.modelIdInput.addEventListener('focus', () =>
      this.openModelSuggestions(false),
    );
    ui.modelIdInput.addEventListener('keydown', (event) =>
      this.handleModelKeydown(event),
    );
    ui.modelIdInput.addEventListener('blur', () => {
      // 延迟关闭，让“点击建议项”（点击会先触发输入框 blur）仍能被处理，
      // 之后列表才被拆除。
      this.suggestionBlurTimer = setTimeout(
        () => this.closeModelSuggestions(),
        150,
      );
    });
    // 用 mousedown（而非 click）：选择动作先于输入框 blur 触发，preventDefault
    // 让焦点留在输入框上。
    ui.modelSuggestions.addEventListener('mousedown', (event) => {
      const item = (event.target as HTMLElement).closest('li[data-value]');
      if (!item) {
        return;
      }
      event.preventDefault();
      this.selectModelSuggestion(item.getAttribute('data-value') ?? '');
    });
    ui.earthEngineProjectIdInput.addEventListener('input', () => {
      this.core.setEarthEngineSettings({ projectId: ui.earthEngineProjectIdInput.value });
      this.renderEarthEngineStatus();
    });
    ui.allowCodeInput.addEventListener('change', () => {
      this.core.setAllowCodeExecution(ui.allowCodeInput.checked);
    });
    ui.allowDestructiveInput.addEventListener('change', () => {
      this.core.setAllowDestructiveTools(ui.allowDestructiveInput.checked);
    });
    ui.prompt.addEventListener('input', () => this.updateControls());
    ui.prompt.addEventListener('keydown', (event) => {
      // Ctrl+Enter：在光标处插入换行并手动派发 input 事件以刷新按钮状态。
      if (event.key === 'Enter' && event.ctrlKey && !event.isComposing) {
        event.preventDefault();
        ui.prompt.setRangeText(
          '\n',
          ui.prompt.selectionStart,
          ui.prompt.selectionEnd,
          'end',
        );
        ui.prompt.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      // 无修饰键的 Enter：发送消息；同样排除输入法组合中的 Enter。
      if (
        event.key === 'Enter' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.isComposing
      ) {
        event.preventDefault();
        this.submitPrompt();
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        this.handlePromptHistoryKey(event);
      }
    });
    ui.copyButton.addEventListener('click', () => {
      void this.core.copyConversationAsMarkdown();
    });
    ui.cancelButton.addEventListener('click', () => this.core.cancelActiveRun());
  }

  /** 读取 prompt 输入框内容、启动运行并清空输入框。 */
  private submitPrompt(): void {
    if (!this.ui) {
      return;
    }
    const text = this.ui.prompt.value.trim();
    // 空文本或已有运行在途时直接忽略。
    if (!text || this.state.busy) {
      return;
    }
    void this.core.sendPrompt(text);
    this.ui.prompt.value = '';
    this.updateControls();
  }

  /** 绑定 window/地图 resize 监听，保证面板停靠位置随布局变化重算。 */
  private setupEventListeners(): void {
    // 面板保持展开直到用户用头部关闭按钮显式收起；点击页面其他区域不得折叠它。
    this.resizeHandler = () => {
      if (!this.state.collapsed) {
        this.updatePanelPosition();
      }
    };
    window.addEventListener('resize', this.resizeHandler);

    this.mapResizeHandler = () => {
      if (!this.state.collapsed) {
        this.updatePanelPosition();
      }
    };
    this.map?.on('resize', this.mapResizeHandler);
  }

  /** 把历史 prompt 回填到输入框并移动光标到末尾（下一帧执行以保证已渲染）。 */
  private applyPromptHistoryValue(value: string): void {
    if (!this.ui) {
      return;
    }
    this.ui.prompt.value = value;
    this.updateControls();
    requestAnimationFrame(() => {
      this.ui?.prompt.setSelectionRange(value.length, value.length);
    });
  }

  /** 处理 prompt 输入框的 ArrowUp/ArrowDown：经核心查询历史并回填。 */
  private handlePromptHistoryKey(event: KeyboardEvent): void {
    if (!this.ui) {
      return;
    }
    const prompt = this.ui.prompt;
    const value =
      event.key === 'ArrowUp'
        ? this.core.historyUp(prompt.value, prompt.selectionStart, prompt.selectionEnd)
        : this.core.historyDown(prompt.value, prompt.selectionStart, prompt.selectionEnd);
    // 返回 null 表示导航不适用（多行编辑等），放行默认行为。
    if (value === null) {
      return;
    }
    event.preventDefault();
    this.applyPromptHistoryValue(value);
  }

  // ----------------------------------------------------------- 尺寸与定位

  /** 创建指定角的 resize 手柄（div，role=separator，mousedown 开始拖拽）。 */
  private createResizeHandle(corner: PanelResizeCorner): HTMLDivElement {
    const handle = document.createElement('div');
    const side = corner === 'bottom-left' ? 'bl' : 'br';
    handle.className = `geoagent-panel-resize-handle geoagent-panel-resize-handle-${side}`;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-label', this.core.translate('resizeHandleLabel'));
    handle.addEventListener('mousedown', (event) => this.startPanelResize(event, corner));
    return handle;
  }

  /** 开始拖拽调整面板尺寸：重新锚定固定角并挂载 document 级监听。 */
  private startPanelResize(event: MouseEvent, corner: PanelResizeCorner): void {
    if (!this.panel || !this.mapContainer) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    // 防御：上一次拖拽尚未正常收尾时先清理旧监听。
    this.stopPanelResize();

    // 拖拽的角会移动底边加一条侧边；对角（顶边 + 另一侧边）必须保持不动。
    // 把面板重新锚定到那个固定角，让宽度/高度变化只经 CSS 移动被拖拽的边，
    // 即使尺寸被钳制，固定角也能保持静止。
    const panelRect = this.panel.getBoundingClientRect();
    const mapRect = this.mapContainer.getBoundingClientRect();

    this.panel.style.top = `${panelRect.top - mapRect.top}px`;
    this.panel.style.bottom = '';
    if (corner === 'bottom-left') {
      this.panel.style.right = `${mapRect.right - panelRect.right}px`;
      this.panel.style.left = '';
    } else {
      this.panel.style.left = `${panelRect.left - mapRect.left}px`;
      this.panel.style.right = '';
    }

    const startX = event.clientX;
    const startY = event.clientY;
    // getBoundingClientRect 为 0（jsdom 等无布局环境）时回退到状态里的尺寸。
    const startWidth = panelRect.width || this.state.panelWidth;
    const startHeight =
      panelRect.height || this.state.panelHeight || this.options.panelMinHeight;
    // 拖左下角向左、或拖右下角向右时，宽度增大。
    const widthDirection = corner === 'bottom-left' ? -1 : 1;

    // 被拖拽的边不能越过地图容器（地图没有布局时跳过该限制，如 jsdom 中
    // 所有 rect 均为 0）。
    const gap = 8;
    const hasLayout = mapRect.width > 0 && mapRect.height > 0;
    const maxWidth = !hasLayout
      ? Number.POSITIVE_INFINITY
      : corner === 'bottom-left'
        ? panelRect.right - mapRect.left - gap
        : mapRect.right - panelRect.left - gap;
    const maxHeight = !hasLayout
      ? Number.POSITIVE_INFINITY
      : mapRect.bottom - panelRect.top - gap;

    this.panel.classList.add('resizing');
    document.body.classList.add('geoagent-panel-resizing');

    this.panelResizeMoveHandler = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      // 按位移方向换算新尺寸并夹在上限内；min/max 的其余钳制由核心的
      // setState -> constrainPanel 完成。
      const width = Math.min(
        maxWidth,
        startWidth + (moveEvent.clientX - startX) * widthDirection,
      );
      const height = Math.min(
        maxHeight,
        startHeight + (moveEvent.clientY - startY),
      );
      this.setState({ panelWidth: width, panelHeight: height });
    };
    this.panelResizeUpHandler = () => this.stopPanelResize();

    document.addEventListener('mousemove', this.panelResizeMoveHandler);
    document.addEventListener('mouseup', this.panelResizeUpHandler);
  }

  /** 结束拖拽：摘除 document 级监听并清理 resizing 样式类。 */
  private stopPanelResize(): void {
    if (this.panelResizeMoveHandler) {
      document.removeEventListener('mousemove', this.panelResizeMoveHandler);
      this.panelResizeMoveHandler = null;
    }
    if (this.panelResizeUpHandler) {
      document.removeEventListener('mouseup', this.panelResizeUpHandler);
      this.panelResizeUpHandler = null;
    }
    this.panel?.classList.remove('resizing');
    document.body.classList.remove('geoagent-panel-resizing');
  }

  /** 把核心状态镜像到面板控件：provider、模型、key 标签、base URL、权限开关等。 */
  private syncUiFromState(): void {
    if (!this.ui || !this.container) {
      return;
    }
    const state = this.core.peekState();
    const provider = this.core.providerConfig(state.providerId);
    const toggleButton = this.container.querySelector<HTMLButtonElement>('.geoagent-control-toggle');
    toggleButton?.setAttribute('aria-expanded', String(!state.collapsed));
    this.ui.providerSelect.value = state.providerId;
    this.ui.modelIdInput.value = state.modelId;
    this.ui.modelIdInput.placeholder =
      provider.defaultModel || this.core.translate('modelNamePlaceholder');
    this.ui.apiKeyLabel.textContent = this.core.localizedApiKeyLabel(state.providerId);
    this.ui.apiKeyInput.placeholder = provider.keyPlaceholder;
    this.ui.baseUrlInput.value = state.baseUrl;
    this.ui.baseUrlInput.placeholder = provider.baseUrlPlaceholder || 'https://host/v1';
    // base URL 行只对要求 base URL 的兼容型 provider 展示。
    this.ui.baseUrlLabel.hidden = !provider.requiresBaseUrl;
    this.ui.allowCodeInput.checked = state.allowCodeExecution;
    this.ui.allowDestructiveInput.checked = state.allowDestructiveTools;
    this.renderEarthEngineStatus();
  }

  /** 读取下拉框当前选中的 provider，校验合法后返回；非法时回退到当前状态值。 */
  private currentProviderId(): GeoAgentProviderId {
    const providerId = this.ui?.providerSelect.value;
    return providerId && this.core.providerConfigs()[providerId as GeoAgentProviderId]
      ? (providerId as GeoAgentProviderId)
      : this.state.providerId;
  }

  // -------------------------------------------------------------- 日志 DOM

  /** 向聊天日志追加一条会话条目（角色标签 + 内容），并滚动到底部。 */
  private appendLogEntry(entry: GeoAgentConversationEntry): void {
    if (!this.ui) {
      return;
    }
    const el = document.createElement('div');
    el.className = 'geoagent-entry';
    el.dataset.role = entry.role;
    // entry id 写进 dataset，供增量更新时按 id 定位该条 DOM。
    el.dataset.entryId = entry.id;
    const roleEl = document.createElement('div');
    roleEl.className = 'geoagent-role';
    roleEl.textContent = this.core.roleLabel(entry.role);
    const textEl = document.createElement('div');
    textEl.className = 'geoagent-text';
    if (entry.markdown) {
      textEl.classList.add('markdown');
      this.renderAssistantMarkdown(textEl, entry.content);
    } else {
      // 普通条目用 textContent 渲染，天然转义任何 HTML。
      textEl.textContent = entry.content;
    }
    el.append(roleEl, textEl);
    this.ui.log.append(el);
    this.ui.log.scrollTop = this.ui.log.scrollHeight;
  }

  /** 按 entry id 定位既有日志条目并更新其内容（流式输出时反复调用）。 */
  private updateLogEntry(entry: GeoAgentConversationEntry): void {
    if (!this.ui) {
      return;
    }
    const el = this.ui.log.querySelector<HTMLElement>(
      `.geoagent-entry[data-entry-id="${entry.id}"]`,
    );
    if (!el) {
      return;
    }
    const textEl = el.querySelector<HTMLElement>('.geoagent-text');
    if (textEl) {
      if (entry.markdown) {
        // markdown 条目在流式期间被高频增量更新：缓冲最新内容，合帧成
        // 每帧至多一轮渲染，避免对累计全文逐 delta 重跑净化管线。
        this.pendingMarkdownUpdates.set(entry.id, entry.content);
        this.scheduleMarkdownFlush();
      } else {
        textEl.textContent = entry.content;
      }
    }
    this.ui.log.scrollTop = this.ui.log.scrollHeight;
  }

  /** 安排一次合帧渲染；已有排队渲染时合并（缓冲里总是最新内容）。 */
  private scheduleMarkdownFlush(): void {
    if (this.markdownFlushHandle !== null) {
      return;
    }
    this.markdownFlushHandle = requestAnimationFrame(() => {
      this.markdownFlushHandle = null;
      this.flushPendingMarkdown();
    });
  }

  /** 渲染合帧缓冲里的全部条目内容；条目 DOM 已被拆除（reset 等）时跳过。 */
  private flushPendingMarkdown(): void {
    if (!this.ui || this.pendingMarkdownUpdates.size === 0) {
      return;
    }
    for (const [entryId, content] of Array.from(this.pendingMarkdownUpdates)) {
      this.pendingMarkdownUpdates.delete(entryId);
      const textEl = this.ui.log.querySelector<HTMLElement>(
        `.geoagent-entry[data-entry-id="${entryId}"] .geoagent-text`,
      );
      if (textEl) {
        this.renderAssistantMarkdown(textEl, content);
      }
    }
  }

  /** 把 markdown 渲染为经过净化的 HTML：marked 转换 + DOMPurify 白名单过滤。 */
  private renderAssistantMarkdown(element: HTMLElement, markdown: string): void {
    const html = marked(markdown || '', {
      async: false,
      breaks: false,
      gfm: true,
    });
    // 模型输出不可信，仅保留 HTML profile 允许的标签/属性。
    element.innerHTML = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
    });
    // 链接统一新窗口打开并加 noopener/noreferrer，防 reverse tabnabbing。
    for (const link of element.querySelectorAll('a')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }

  // ------------------------------------------------------------- 控件刷新

  /** 按最新配置与 busy 状态刷新全部按钮/输入框的可用性与提示。 */
  private updateControls(): void {
    if (!this.ui) {
      return;
    }
    const state = this.core.peekState();
    const configured = this.core.isConfigured();
    // 配置完成前 prompt 输入框与 Send 按钮保持锁定，避免用户写下无处发送的消息。
    const blocked = !configured;
    this.ui.prompt.disabled = state.busy || blocked;
    this.ui.prompt.placeholder = blocked
      ? this.core.blockedPromptHint(configured)
      : this.core.translate('promptPlaceholder');
    this.ui.sendButton.disabled =
      state.busy || !this.ui.prompt.value.trim() || blocked;
    if (!blocked) {
      this.ui.sendButton.removeAttribute('title');
    } else {
      this.ui.sendButton.title = this.core.sendBlockedHint();
    }
    this.ui.loadModelsButton.disabled =
      state.busy || !this.core.providerConfig(state.providerId).defaultModel;
    this.ui.cancelButton.disabled = !state.busy || this.core.isCancelRequested();
    // 配置首次完成时收起设置区，给聊天腾出空间。只在“未配置 -> 已配置”的
    // 边沿动作：绝不自动展开，避免与手动重新打开设置区调整的用户打架。
    if (configured && !this.wasConfigured) {
      this.ui.settingsDetails.open = false;
    }
    this.wasConfigured = configured;
    // 刷新空闲徽标但不覆盖瞬态状态：配置编辑能在徽标未展示 Running/Copied
    // 时翻转 Ready/Setup。
    this.core.applyIdleStatus();
  }

  // ------------------------------------------------------ 模型 combobox UI

  /** 清空本地模型建议列表并收起下拉。 */
  private resetModelOptions(): void {
    this.populateModelOptions([]);
  }

  /** 填充本地模型建议：去重、去空并截断到 MAX_SUGGESTIONS，必要时刷新下拉。 */
  private populateModelOptions(models: string[]): void {
    const seen = new Set<string>();
    const options: string[] = [];
    for (const rawModel of models) {
      const model = rawModel.trim();
      // 跳过空项与重复项；超出上限的尾部项直接丢弃。
      if (!model || seen.has(model)) {
        continue;
      }
      seen.add(model);
      if (options.length < GeoAgentControl.MAX_SUGGESTIONS) {
        options.push(model);
      }
    }
    this.modelOptions = options;
    // 下拉已打开时（如字段聚焦期间列表刚加载完成）就地刷新；否则保持关闭。
    // 展示完整列表而不是按字段里已有的默认模型过滤。
    if (this.ui && !this.ui.modelSuggestions.hidden) {
      this.openModelSuggestions(false);
    }
  }

  /** 按查询串过滤本地建议（大小写不敏感的包含匹配）；空查询返回全部。 */
  private filterModelOptions(query: string): string[] {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? this.modelOptions.filter((model) =>
          model.toLowerCase().includes(needle),
        )
      : this.modelOptions;
    return matches.slice(0, GeoAgentControl.MAX_SUGGESTIONS);
  }

  /**
   * 打开（或刷新）自定义模型建议下拉。`useFilter` 为 true（键入中）时列表
   * 按当前输入值收窄；为 false（聚焦、方向键）时展示完整本地建议列表，
   * 即使字段里已填默认模型也能浏览。
   */
  private openModelSuggestions(useFilter = true): void {
    if (!this.ui) {
      return;
    }
    // 取消尚未触发的 blur 关闭定时器，避免列表刚打开就被收起。
    if (this.suggestionBlurTimer !== null) {
      clearTimeout(this.suggestionBlurTimer);
      this.suggestionBlurTimer = null;
    }
    const filtered = this.filterModelOptions(
      useFilter ? this.ui.modelIdInput.value : '',
    );
    // 无可展示项时直接收起，而不是打开一个空列表。
    if (filtered.length === 0) {
      this.closeModelSuggestions();
      return;
    }
    this.renderedSuggestions = filtered;
    this.activeSuggestion = -1;
    const list = this.ui.modelSuggestions;
    // 全量重建列表项；每项带 role=option 与稳定 id，供 aria-activedescendant 引用。
    list.replaceChildren(
      ...filtered.map((model, index) => {
        const item = document.createElement('li');
        item.className = 'geoagent-model-suggestion';
        item.setAttribute('role', 'option');
        item.dataset.value = model;
        item.id = `${this.modelListId}-opt-${index}`;
        item.textContent = model;
        return item;
      }),
    );
    list.hidden = false;
    this.ui.modelIdInput.setAttribute('aria-expanded', 'true');
  }

  /** 收起建议下拉：清空列表 DOM 与高亮状态，并同步 combobox 的 aria 状态。 */
  private closeModelSuggestions(): void {
    if (this.suggestionBlurTimer !== null) {
      clearTimeout(this.suggestionBlurTimer);
      this.suggestionBlurTimer = null;
    }
    this.renderedSuggestions = [];
    this.activeSuggestion = -1;
    if (this.ui) {
      this.ui.modelSuggestions.hidden = true;
      this.ui.modelSuggestions.replaceChildren();
      this.ui.modelIdInput.setAttribute('aria-expanded', 'false');
      this.ui.modelIdInput.removeAttribute('aria-activedescendant');
    }
  }

  /** 选中某个模型建议：写入输入框并经 input 事件走正常的 setModelId 管线。 */
  private selectModelSuggestion(value: string): void {
    if (!this.ui || !value) {
      return;
    }
    this.ui.modelIdInput.value = value;
    // 派发 input 事件复用键入路径（持久化 + 失效 agent + 刷新控件）。
    this.ui.modelIdInput.dispatchEvent(new Event('input', { bubbles: true }));
    this.closeModelSuggestions();
  }

  /** 处理模型输入框按键：Escape 收起、方向键移动高亮、Enter 选中高亮项。 */
  private handleModelKeydown(event: KeyboardEvent): void {
    if (!this.ui) {
      return;
    }
    if (event.key === 'Escape') {
      if (!this.ui.modelSuggestions.hidden) {
        // 只吞掉收起下拉的 Escape，避免连带关闭外层设置 details。
        event.stopPropagation();
        this.closeModelSuggestions();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // 列表未打开时先以“不过滤”方式打开；仍打不开（无建议）则放行。
      if (this.ui.modelSuggestions.hidden) {
        this.openModelSuggestions(false);
        if (this.ui.modelSuggestions.hidden) {
          return;
        }
      }
      event.preventDefault();
      // 循环移动高亮：末尾再向下回到第 0 项，开头再向上回到最后一项。
      const last = this.renderedSuggestions.length - 1;
      if (event.key === 'ArrowDown') {
        this.activeSuggestion =
          this.activeSuggestion >= last ? 0 : this.activeSuggestion + 1;
      } else {
        this.activeSuggestion =
          this.activeSuggestion <= 0 ? last : this.activeSuggestion - 1;
      }
      this.highlightActiveSuggestion();
      return;
    }
    // Enter 仅在有高亮项时选中；否则放行默认行为。
    if (event.key === 'Enter' && this.activeSuggestion >= 0) {
      event.preventDefault();
      this.selectModelSuggestion(this.renderedSuggestions[this.activeSuggestion]);
    }
  }

  /** 高亮当前建议项：切换样式类、滚动到可见并更新 aria-activedescendant。 */
  private highlightActiveSuggestion(): void {
    if (!this.ui) {
      return;
    }
    const items =
      this.ui.modelSuggestions.querySelectorAll<HTMLLIElement>('li');
    items.forEach((item, index) => {
      const active = index === this.activeSuggestion;
      item.classList.toggle('active', active);
      if (active) {
        item.scrollIntoView({ block: 'nearest' });
        this.ui?.modelIdInput.setAttribute('aria-activedescendant', item.id);
      }
    });
  }

  /** 建议下拉的最大条目数。 */
  private static readonly MAX_SUGGESTIONS = 100;

  // -------------------------------------------------------- 浮动布局

  /** 推断控件实际停靠的角：读容器父元素的 maplibregl-ctrl-* 类；读不到时回退到选项值。 */
  private getControlPosition():
    | 'top-left'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-right' {
    const parent = this.container?.parentElement;
    if (!parent) return this.options.position;
    if (parent.classList.contains('maplibregl-ctrl-top-left')) return 'top-left';
    if (parent.classList.contains('maplibregl-ctrl-top-right')) return 'top-right';
    if (parent.classList.contains('maplibregl-ctrl-bottom-left')) return 'bottom-left';
    if (parent.classList.contains('maplibregl-ctrl-bottom-right')) return 'bottom-right';
    return this.options.position;
  }

  /** 把展开后的面板定位到切换按钮旁边（按停靠角计算 top/bottom/left/right）。 */
  private updatePanelPosition(): void {
    if (!this.container || !this.panel || !this.mapContainer) return;
    const button = this.container.querySelector('.geoagent-control-toggle');
    if (!button) return;

    // 以地图容器为定位基准计算按钮到四边的距离（面板是 absolutely 定位在
    // 地图容器内的）。
    const buttonRect = button.getBoundingClientRect();
    const mapRect = this.mapContainer.getBoundingClientRect();
    const position = this.getControlPosition();
    const buttonTop = buttonRect.top - mapRect.top;
    const buttonBottom = mapRect.bottom - buttonRect.bottom;
    const buttonLeft = buttonRect.left - mapRect.left;
    const buttonRight = mapRect.right - buttonRect.right;
    const panelGap = 5;

    // 先清空四边定位，再按停靠角只写两条边，避免旧值与新值叠加出错误布局。
    this.panel.style.top = '';
    this.panel.style.bottom = '';
    this.panel.style.left = '';
    this.panel.style.right = '';

    switch (position) {
      case 'top-left':
        this.panel.style.top = `${buttonTop + buttonRect.height + panelGap}px`;
        this.panel.style.left = `${buttonLeft}px`;
        break;
      case 'top-right':
        this.panel.style.top = `${buttonTop + buttonRect.height + panelGap}px`;
        this.panel.style.right = `${buttonRight}px`;
        break;
      case 'bottom-left':
        this.panel.style.bottom = `${buttonBottom + buttonRect.height + panelGap}px`;
        this.panel.style.left = `${buttonLeft}px`;
        break;
      case 'bottom-right':
        this.panel.style.bottom = `${buttonBottom + buttonRect.height + panelGap}px`;
        this.panel.style.right = `${buttonRight}px`;
        break;
    }
  }
}
