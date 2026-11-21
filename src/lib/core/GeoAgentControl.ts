import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { IControl, Map as MapLibreMap } from 'maplibre-gl';
import { GeoAgentCore } from './GeoAgentCore';
import type { GeoAgentTools } from './geoagent-tools';
import type {
  GeoAgentControlEvent,
  GeoAgentControlEventHandler,
  GeoAgentControlOptions,
  GeoAgentConversationEntry,
  GeoAgentProviderId,
  GeoAgentState,
  GeoAgentStatusState,
} from './types';

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
  clearButton: HTMLButtonElement;
  copyButton: HTMLButtonElement;
  resizeHandleLeft: HTMLDivElement;
  resizeHandleRight: HTMLDivElement;
  closeButton: HTMLButtonElement;
}

type PanelResizeCorner = 'bottom-left' | 'bottom-right';

/**
 * Imperative MapLibre control wrapping {@link GeoAgentCore}. The core owns
 * configuration, the agent, and the conversation; this class renders the
 * floating panel (toggle button, settings, chat log, resize handles) and
 * forwards every user interaction to the core.
 */
export class GeoAgentControl implements IControl {
  private readonly core: GeoAgentCore;
  private map?: MapLibreMap;
  private mapContainer?: HTMLElement;
  private container?: HTMLElement;
  private panel?: HTMLElement;
  private ui?: GeoAgentUi;
  private resizeHandler: (() => void) | null = null;
  private mapResizeHandler: (() => void) | null = null;
  private panelResizeMoveHandler: ((e: MouseEvent) => void) | null = null;
  private panelResizeUpHandler: (() => void) | null = null;
  // Unique per control instance so the model input's aria-controls points at its
  // own suggestion list even when several controls share a page.
  private static instanceCount = 0;
  private readonly modelListId = `geoagent-model-list-${(GeoAgentControl.instanceCount += 1)}`;
  // Loaded model names backing the custom suggestion dropdown. A native
  // <datalist> is intentionally avoided: clicking the model field to open
  // Chrome's native datalist popup with a long list hangs the renderer.
  private modelOptions: string[] = [];
  // Index of the highlighted suggestion (-1 = none), and the values currently
  // rendered in the dropdown (the filtered subset).
  private activeSuggestion = -1;
  private renderedSuggestions: string[] = [];
  private suggestionBlurTimer: ReturnType<typeof setTimeout> | null = null;
  // Whether the agent was configured at the last control refresh, used to fold
  // the settings section away the first time setup completes.
  private wasConfigured = false;

  constructor(options: GeoAgentControlOptions = {}) {
    this.core = new GeoAgentCore(options);
  }

  /** Options live in the core; engine attach helpers read/mutate `position`. */
  private get options(): GeoAgentCore['options'] {
    return this.core.options;
  }

  /** Live (uncopied) state for render-side reads. */
  private get state(): GeoAgentState {
    return this.core.peekState();
  }

  /** The core's engine-bound tools, or undefined before mounting. */
  get tools(): GeoAgentTools | undefined {
    return this.core.getTools();
  }

  onAdd(map: MapLibreMap): HTMLElement {
    this.map = map;
    // MapLibre/Mapbox/Leaflet hosts expose getContainer(); OpenLayers maps
    // expose getTargetElement() instead — accept either so the expanded panel
    // has a container to live in on every engine.
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
    this.container = this.createContainer();
    this.panel = this.createPanel();
    this.mapContainer.appendChild(this.panel);
    // Subscribe before attach so no core event is missed, then render the
    // snapshots (status badge, ready log entry) that fired during attach.
    this.subscribeCoreEvents();
    this.core.attach(map);
    this.setupEventListeners();
    // Start the settings expanded only when setup is still needed; once the
    // agent is configured the section collapses so the chat has more room (the
    // status badge keeps showing the connection state either way).
    if (this.ui) {
      this.wasConfigured = this.core.isConfigured();
      this.ui.settingsDetails.open = !this.wasConfigured;
      this.syncUiFromState();
      this.ui.apiKeyInput.value = this.core.getCommittedApiKey();
    }
    this.updateControls();

    if (!this.state.collapsed) {
      this.panel.classList.add('expanded');
      requestAnimationFrame(() => this.updatePanelPosition());
    }

    return this.container;
  }

  onRemove(): void {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.mapResizeHandler && this.map) {
      this.map.off('resize', this.mapResizeHandler);
      this.mapResizeHandler = null;
    }
    this.stopPanelResize();
    if (this.suggestionBlurTimer !== null) {
      clearTimeout(this.suggestionBlurTimer);
      this.suggestionBlurTimer = null;
    }
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

  getState(): GeoAgentState {
    return this.core.getState();
  }

  setState(newState: Partial<GeoAgentState>): void {
    this.core.setState(newState);
    // The core clamped the values; mirror them onto the floating panel.
    if (newState.panelWidth !== undefined && this.panel) {
      this.panel.style.width = `${this.state.panelWidth}px`;
    }
    if (newState.panelHeight !== undefined && this.panel) {
      this.panel.style.height = `${this.state.panelHeight}px`;
    }
  }

  toggle(): void {
    this.core.toggle();
  }

  expand(): void {
    this.core.expand();
  }

  collapse(): void {
    this.core.collapse();
  }

  on(event: GeoAgentControlEvent, handler: GeoAgentControlEventHandler): void {
    this.core.on(event, handler);
  }

  off(event: GeoAgentControlEvent, handler: GeoAgentControlEventHandler): void {
    this.core.off(event, handler);
  }

  getMap(): MapLibreMap | undefined {
    return this.core.getMap();
  }

  getContainer(): HTMLElement | undefined {
    return this.container;
  }

  getPanel(): HTMLElement | undefined {
    return this.panel;
  }

  // ------------------------------------------------------------ core events

  /** Render the conversation/status/note streams and state changes from the core. */
  private subscribeCoreEvents(): void {
    this.core.onConversation((change, entries) => {
      if (!this.ui) {
        return;
      }
      if (change.type === 'reset') {
        this.ui.log.replaceChildren();
      } else if (change.type === 'append' && change.entry) {
        this.appendLogEntry(change.entry);
      } else if (change.type === 'update' && change.entry) {
        this.updateLogEntry(change.entry);
      }
      // Keep the copy button in sync with the rendered conversation.
      this.ui.copyButton.disabled = entries.length === 0;
    });
    this.core.onStatus((status) => this.renderStatus(status));
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

  private renderStatus(status: GeoAgentStatusState): void {
    if (!this.ui) {
      return;
    }
    this.ui.status.textContent = status.text;
    this.ui.status.className = `geoagent-status ${status.kind}`.trim();
  }

  // -------------------------------------------------------------- panel DOM

  private createContainer(): HTMLElement {
    const container = document.createElement('div');
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
          <button class="geoagent-clear secondary" type="button">${this.core.translate('clearButton')}</button>
        </div>
      </form>
    `;

    const resizeHandleLeft = this.createResizeHandle('bottom-left');
    const resizeHandleRight = this.createResizeHandle('bottom-right');

    panel.append(header, content, resizeHandleLeft, resizeHandleRight);
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
      clearButton: this.requiredElement(content, '.geoagent-clear'),
      copyButton: this.requiredElement(content, '.geoagent-copy'),
      resizeHandleLeft,
      resizeHandleRight,
      closeButton,
    };
    this.ui.permissionRow.hidden = !this.options.showPermissionToggles;
    this.setupEarthEngineControls();
    this.populateProviderOptions();
    this.wireUiEvents();
    this.syncUiFromState();
    return panel;
  }

  private requiredElement<T extends Element>(parent: ParentNode, selector: string): T {
    const element = parent.querySelector<T>(selector);
    if (!element) {
      throw new Error(`Missing required element: ${selector}`);
    }
    return element;
  }

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

  private setupEarthEngineControls(): void {
    if (!this.ui) {
      return;
    }
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
    this.ui.earthEngineDetails.open = (!oauthClientId && !accessToken) || !projectId;
    // Merge the settings into the core options before `attach` creates the
    // tools, so the tools observe the same values the panel shows.
    this.core.setEarthEngineSettings({ oauthClientId, projectId });
    this.renderEarthEngineStatus();
  }

  private renderEarthEngineStatus(): void {
    if (!this.ui || this.ui.earthEngineDetails.hidden) {
      return;
    }
    this.ui.earthEngineStatus.textContent = this.core.getEarthEngineStatusText();
  }

  // ------------------------------------------------------------- ui events

  private wireUiEvents(): void {
    const ui = this.ui;
    if (!ui) {
      return;
    }
    ui.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitPrompt();
    });
    ui.providerSelect.addEventListener('change', () => {
      const providerId = this.currentProviderId();
      this.core.switchProvider(providerId);
      // The committed key is provider-specific; show the newly loaded one.
      this.ui!.apiKeyInput.value = this.core.getCommittedApiKey();
      this.resetModelOptions();
    });
    // The key is saved (and the badge/connection re-evaluated) only when the
    // user commits it, not on every keystroke: a half-typed key must not flip
    // the badge to "Ready" or be written to storage. Commit happens on Enter or
    // when the field loses focus (the native `change` event).
    ui.apiKeyInput.addEventListener('input', () => {
      this.core.setApiKeyEdited(ui.apiKeyInput.value);
      this.updateControls();
    });
    ui.apiKeyInput.addEventListener('change', () => {
      this.core.commitApiKey(ui.apiKeyInput.value);
    });
    ui.apiKeyInput.addEventListener('keydown', (event) => {
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
    // The model field is a combobox backed by a custom suggestion dropdown
    // (geoagent-model-suggestions), not a native <datalist>: opening Chrome's
    // native datalist popup with a long model list hangs the renderer.
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
      // Delay so a click on a suggestion (which blurs the input first) is still
      // handled before the list is torn down.
      this.suggestionBlurTimer = setTimeout(
        () => this.closeModelSuggestions(),
        150,
      );
    });
    // mousedown (not click) so selecting fires before the input's blur, and
    // preventDefault keeps focus on the input.
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
    ui.clearButton.addEventListener('click', () => {
      this.core.clearConversation();
    });
    ui.copyButton.addEventListener('click', () => {
      void this.core.copyConversationAsMarkdown();
    });
    ui.cancelButton.addEventListener('click', () => this.core.cancelActiveRun());
  }

  /** Read the prompt field, start the run, and clear the field. */
  private submitPrompt(): void {
    if (!this.ui) {
      return;
    }
    const text = this.ui.prompt.value.trim();
    if (!text || this.state.busy) {
      return;
    }
    void this.core.sendPrompt(text);
    this.ui.prompt.value = '';
    this.updateControls();
  }

  private setupEventListeners(): void {
    // The panel stays open until the user explicitly closes it with the header
    // close button; clicking elsewhere on the page must not collapse it.
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

  private handlePromptHistoryKey(event: KeyboardEvent): void {
    if (!this.ui) {
      return;
    }
    const prompt = this.ui.prompt;
    const value =
      event.key === 'ArrowUp'
        ? this.core.historyUp(prompt.value, prompt.selectionStart, prompt.selectionEnd)
        : this.core.historyDown(prompt.value, prompt.selectionStart, prompt.selectionEnd);
    if (value === null) {
      return;
    }
    event.preventDefault();
    this.applyPromptHistoryValue(value);
  }

  // ----------------------------------------------------------- resize & pos

  private createResizeHandle(corner: PanelResizeCorner): HTMLDivElement {
    const handle = document.createElement('div');
    const side = corner === 'bottom-left' ? 'bl' : 'br';
    handle.className = `geoagent-panel-resize-handle geoagent-panel-resize-handle-${side}`;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-label', this.core.translate('resizeHandleLabel'));
    handle.addEventListener('mousedown', (event) => this.startPanelResize(event, corner));
    return handle;
  }

  private startPanelResize(event: MouseEvent, corner: PanelResizeCorner): void {
    if (!this.panel || !this.mapContainer) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    this.stopPanelResize();

    // The dragged corner moves the bottom edge plus one side edge; the opposite
    // (top + other side) corner must stay put. Re-anchor the panel to that fixed
    // corner so that changing width/height moves only the dragged edges via CSS,
    // which keeps the fixed corner stationary even when the size is clamped.
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
    const startWidth = panelRect.width || this.state.panelWidth;
    const startHeight =
      panelRect.height || this.state.panelHeight || this.options.panelMinHeight;
    // Dragging the left corner left, or the right corner right, grows the width.
    const widthDirection = corner === 'bottom-left' ? -1 : 1;

    // The dragged edges may not extend past the map container. (Skipped when the
    // map has no layout, e.g. in jsdom, where rects are all zero.)
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
    this.ui.baseUrlLabel.hidden = !provider.requiresBaseUrl;
    this.ui.allowCodeInput.checked = state.allowCodeExecution;
    this.ui.allowDestructiveInput.checked = state.allowDestructiveTools;
    this.renderEarthEngineStatus();
  }

  private currentProviderId(): GeoAgentProviderId {
    const providerId = this.ui?.providerSelect.value;
    return providerId && this.core.providerConfigs()[providerId as GeoAgentProviderId]
      ? (providerId as GeoAgentProviderId)
      : this.state.providerId;
  }

  // -------------------------------------------------------------- log DOM

  private appendLogEntry(entry: GeoAgentConversationEntry): void {
    if (!this.ui) {
      return;
    }
    const el = document.createElement('div');
    el.className = 'geoagent-entry';
    el.dataset.role = entry.role;
    el.dataset.markdown = entry.content;
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
      textEl.textContent = entry.content;
    }
    el.append(roleEl, textEl);
    this.ui.log.append(el);
    this.ui.log.scrollTop = this.ui.log.scrollHeight;
  }

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
    el.dataset.markdown = entry.content;
    const textEl = el.querySelector<HTMLElement>('.geoagent-text');
    if (textEl) {
      if (entry.markdown) {
        this.renderAssistantMarkdown(textEl, entry.content);
      } else {
        textEl.textContent = entry.content;
      }
    }
    this.ui.log.scrollTop = this.ui.log.scrollHeight;
  }

  private renderAssistantMarkdown(element: HTMLElement, markdown: string): void {
    const html = marked(markdown || '', {
      async: false,
      breaks: false,
      gfm: true,
    });
    element.innerHTML = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
    });
    for (const link of element.querySelectorAll('a')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }

  // ------------------------------------------------------------- controls

  private updateControls(): void {
    if (!this.ui) {
      return;
    }
    const state = this.core.peekState();
    const configured = this.core.isConfigured();
    // The prompt and Send button stay locked until the agent is configured, so
    // the user cannot draft or send a message that has nowhere to go.
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
    this.ui.clearButton.disabled = state.busy;
    // Fold the settings away the first time setup completes, so the chat gets
    // more room. Only act on the not-configured -> configured edge: never
    // auto-open, so a user who manually re-opens the section to tweak settings
    // is not fought on the next refresh.
    if (configured && !this.wasConfigured) {
      this.ui.settingsDetails.open = false;
    }
    this.wasConfigured = configured;
    // Refresh the idle badge without clobbering transient statuses, so config
    // edits flip Ready/Setup while the badge is not showing Running/Copied.
    this.core.applyIdleStatus();
  }

  // ------------------------------------------------------ model combobox UI

  private resetModelOptions(): void {
    this.populateModelOptions([]);
  }

  private populateModelOptions(models: string[]): void {
    const seen = new Set<string>();
    const options: string[] = [];
    for (const rawModel of models) {
      const model = rawModel.trim();
      if (!model || seen.has(model)) {
        continue;
      }
      seen.add(model);
      if (options.length < GeoAgentControl.MAX_SUGGESTIONS) {
        options.push(model);
      }
    }
    this.modelOptions = options;
    // Refresh the dropdown if it is open (e.g. the list just loaded while the
    // field is focused); otherwise leave it closed. Show the full list rather
    // than filtering by the default model already in the field.
    if (this.ui && !this.ui.modelSuggestions.hidden) {
      this.openModelSuggestions(false);
    }
  }

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
   * Open (or refresh) the custom model suggestion dropdown. With `useFilter`
   * (typing) the list narrows to the current input value; without it (focus,
   * arrow keys) the full local suggestion list is shown so the user can browse
   * even when the field already holds the default model.
   */
  private openModelSuggestions(useFilter = true): void {
    if (!this.ui) {
      return;
    }
    if (this.suggestionBlurTimer !== null) {
      clearTimeout(this.suggestionBlurTimer);
      this.suggestionBlurTimer = null;
    }
    const filtered = this.filterModelOptions(
      useFilter ? this.ui.modelIdInput.value : '',
    );
    if (filtered.length === 0) {
      this.closeModelSuggestions();
      return;
    }
    this.renderedSuggestions = filtered;
    this.activeSuggestion = -1;
    const list = this.ui.modelSuggestions;
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

  private selectModelSuggestion(value: string): void {
    if (!this.ui || !value) {
      return;
    }
    this.ui.modelIdInput.value = value;
    this.ui.modelIdInput.dispatchEvent(new Event('input', { bubbles: true }));
    this.closeModelSuggestions();
  }

  private handleModelKeydown(event: KeyboardEvent): void {
    if (!this.ui) {
      return;
    }
    if (event.key === 'Escape') {
      if (!this.ui.modelSuggestions.hidden) {
        event.stopPropagation();
        this.closeModelSuggestions();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (this.ui.modelSuggestions.hidden) {
        this.openModelSuggestions(false);
        if (this.ui.modelSuggestions.hidden) {
          return;
        }
      }
      event.preventDefault();
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
    if (event.key === 'Enter' && this.activeSuggestion >= 0) {
      event.preventDefault();
      this.selectModelSuggestion(this.renderedSuggestions[this.activeSuggestion]);
    }
  }

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

  private static readonly MAX_SUGGESTIONS = 100;

  // -------------------------------------------------------- floating layout

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

  private updatePanelPosition(): void {
    if (!this.container || !this.panel || !this.mapContainer) return;
    const button = this.container.querySelector('.geoagent-control-toggle');
    if (!button) return;

    const buttonRect = button.getBoundingClientRect();
    const mapRect = this.mapContainer.getBoundingClientRect();
    const position = this.getControlPosition();
    const buttonTop = buttonRect.top - mapRect.top;
    const buttonBottom = mapRect.bottom - buttonRect.bottom;
    const buttonLeft = buttonRect.left - mapRect.left;
    const buttonRight = mapRect.right - buttonRect.right;
    const panelGap = 5;

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
