import { beforeEach, describe, expect, it, vi } from 'vitest';
import L from 'leaflet';
import {
  GeoAgentCore,
  codeExecutionPrompt,
  engineCapabilityPrompt,
} from '../src/lib/core/GeoAgentCore';

function createMockMap() {
  const container = document.createElement('div');
  container.style.width = '800px';
  container.style.height = '600px';
  document.body.appendChild(container);
  const map = {
    getContainer: () => container,
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    map: map as never,
    container,
    cleanup: () => container.remove(),
  };
}

describe('GeoAgentCore providers', () => {
  it('exposes the two compatible providers only', () => {
    const core = new GeoAgentCore();
    expect(Object.keys(core.providerConfigs())).toEqual([
      'openai-compatible',
      'anthropic-compatible',
    ]);
  });

  it('requires a base URL for both compatible providers', () => {
    const core = new GeoAgentCore();
    expect(core.providerConfig('openai-compatible').requiresBaseUrl).toBe(true);
    expect(core.providerConfig('anthropic-compatible').requiresBaseUrl).toBe(true);
    expect(core.providerConfig('openai-compatible').baseUrlPlaceholder).toBe(
      'https://host/v1',
    );
    expect(core.providerConfig('anthropic-compatible').baseUrlPlaceholder).toBe(
      'https://host',
    );
    expect(core.providerConfig('anthropic-compatible').defaultModel).toBe(
      'claude-opus-4-8',
    );
    // The OpenAI-compatible endpoint has no universal default model.
    expect(core.providerConfig('openai-compatible').defaultModel).toBe('');
  });

  it('honors per-provider default model overrides', () => {
    const core = new GeoAgentCore({
      defaultModel: {
        'anthropic-compatible': 'claude-custom',
        'openai-compatible': 'gpt-custom',
      },
    });
    expect(core.providerConfig('anthropic-compatible').defaultModel).toBe(
      'claude-custom',
    );
    expect(core.providerConfig('openai-compatible').defaultModel).toBe(
      'gpt-custom',
    );
  });
});

describe('GeoAgentCore configuration state', () => {
  let mapContext: ReturnType<typeof createMockMap>;

  beforeEach(() => {
    sessionStorage.clear();
    mapContext = createMockMap();
  });

  it('is unconfigured until the API key is committed (typing is not enough)', () => {
    const core = new GeoAgentCore();
    core.attach(mapContext.map);
    expect(core.isConfigured()).toBe(false);
    core.setApiKeyEdited('sk-half-typed');
    expect(core.isConfigured()).toBe(false);
    core.commitApiKey('sk-half-typed');
    // The key alone is not enough: the compatible provider also needs a valid
    // base URL (the model id defaults to empty for openai-compatible).
    expect(core.isConfigured()).toBe(false);
    expect(
      sessionStorage.getItem('web-geoagent.openai-compatible.api_key'),
    ).toBe('sk-half-typed');
    core.setBaseUrl('https://llm.example.com/v1');
    core.setModelId('local-model');
    expect(core.isConfigured()).toBe(true);
    core.dispose();
    mapContext.cleanup();
  });

  it('requires a valid absolute base URL for the compatible providers', () => {
    const core = new GeoAgentCore({ defaultProvider: 'openai-compatible' });
    core.commitApiKey('sk-local');
    core.setModelId('local-model');
    expect(core.isConfigured()).toBe(false);

    core.setBaseUrl('relative/path');
    expect(core.isConfigured()).toBe(false);

    core.setBaseUrl('https://llm.example.com/v1');
    expect(core.isConfigured()).toBe(true);
    expect(
      sessionStorage.getItem('web-geoagent.baseUrl.openai-compatible'),
    ).toBe('https://llm.example.com/v1');
    core.dispose();
  });

  it('summarizes the missing configuration fields', () => {
    const core = new GeoAgentCore({ defaultProvider: 'openai-compatible' });
    const missing = core.missingConfigSummary();
    expect(missing).toContain('API Key');
    expect(missing).toContain('API base URL');
    expect(missing).toContain('model');

    core.commitApiKey('sk-local');
    core.setBaseUrl('https://llm.example.com/v1');
    core.setModelId('local-model');
    expect(core.missingConfigSummary()).toBe('');
    core.dispose();
  });

  it('falls back to the deployment defaults and lets storage win', () => {
    // With no stored values the env-injected defaults (defaultApiKey /
    // defaultBaseUrl / defaultModel) fully configure the agent.
    const envCore = new GeoAgentCore({
      defaultProvider: 'openai-compatible',
      defaultApiKey: 'env-key',
      defaultBaseUrl: 'https://env.example.com/v1',
      defaultModel: 'env-model',
    });
    envCore.attach(mapContext.map);
    expect(envCore.getCommittedApiKey()).toBe('env-key');
    expect(envCore.getState().baseUrl).toBe('https://env.example.com/v1');
    expect(envCore.getState().modelId).toBe('env-model');
    expect(envCore.isConfigured()).toBe(true);
    envCore.dispose();
    mapContext.cleanup();

    // Stored values win over the deployment defaults.
    sessionStorage.setItem('web-geoagent.stored.openai-compatible.api_key', 'stored-key');
    sessionStorage.setItem(
      'web-geoagent.stored.baseUrl.openai-compatible',
      'https://stored.example.com/v1',
    );
    sessionStorage.setItem('web-geoagent.stored.model.openai-compatible', 'stored-model');
    const storedCore = new GeoAgentCore({
      storagePrefix: 'web-geoagent.stored',
      defaultProvider: 'openai-compatible',
      defaultApiKey: 'env-key',
      defaultBaseUrl: 'https://env.example.com/v1',
      defaultModel: 'env-model',
    });
    storedCore.attach(mapContext.map);
    expect(storedCore.getCommittedApiKey()).toBe('stored-key');
    expect(storedCore.getState().baseUrl).toBe('https://stored.example.com/v1');
    expect(storedCore.getState().modelId).toBe('stored-model');
    storedCore.dispose();
    mapContext.cleanup();
  });

  it('persists the provider choice and reloads its stored settings', () => {
    sessionStorage.setItem(
      'geoagent.switch.anthropic-compatible.api_key',
      'stored-ant',
    );
    const core = new GeoAgentCore({ storagePrefix: 'geoagent.switch' });
    core.switchProvider('anthropic-compatible');
    expect(core.getState().providerId).toBe('anthropic-compatible');
    expect(core.getState().modelId).toBe('claude-opus-4-8');
    expect(core.getCommittedApiKey()).toBe('stored-ant');
    expect(sessionStorage.getItem('geoagent.switch.provider')).toBe(
      'anthropic-compatible',
    );
    core.dispose();
  });
});

describe('GeoAgentCore conversation', () => {
  let mapContext: ReturnType<typeof createMockMap>;

  beforeEach(() => {
    sessionStorage.clear();
    mapContext = createMockMap();
  });

  describe('adjacent tool-call grouping', () => {
    function handleStream(core: InstanceType<typeof GeoAgentCore>) {
      return (event: unknown) =>
        (
          core as unknown as {
            handleAgentStreamEvent: (e: unknown) => string | undefined;
          }
        ).handleAgentStreamEvent(event);
    }

    function toolEntries(core: InstanceType<typeof GeoAgentCore>) {
      return (core as unknown as { entries: { role: string; content: string }[] })
        .entries.filter((entry) => entry.role === 'tool');
    }

    it('merges adjacent tool calls into one entry and expands details at the end', () => {
      const core = new GeoAgentCore();
      core.attach(mapContext.map);
      const handle = handleStream(core);

      handle({ type: 'beforeToolCallEvent', toolUse: { name: 'move_map' } });
      handle({ type: 'beforeToolCallEvent', toolUse: { name: 'add_marker' } });
      handle({ type: 'beforeToolCallEvent', toolUse: { name: 'add_marker' } });
      // 三个相邻调用只产生一行合并记录，且步数持续更新。
      expect(toolEntries(core)).toHaveLength(1);
      expect(toolEntries(core)[0].content).toBe('Running tool add_marker (step 3)');

      handle({ type: 'agentResultEvent', result: { toString: () => 'done' } });
      // 整轮结束后同一行展开为逐条详情。
      expect(toolEntries(core)).toHaveLength(1);
      expect(toolEntries(core)[0].content).toBe(
        'Completed 3 tool calls:\n1. move_map\n2. add_marker\n3. add_marker',
      );
      core.dispose();
      mapContext.cleanup();
    });

    it('starts a new group when streaming text appears between tool calls', () => {
      const core = new GeoAgentCore();
      core.attach(mapContext.map);
      const handle = handleStream(core);

      handle({ type: 'beforeToolCallEvent', toolUse: { name: 'zoom_to' } });
      handle({
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'textDelta', text: 'Let me check.' },
        },
      });
      handle({ type: 'beforeToolCallEvent', toolUse: { name: 'query_features' } });
      handle({ type: 'beforeToolCallEvent', toolUse: { name: 'query_features' } });
      handle({ type: 'agentResultEvent', result: { toString: () => 'ok' } });

      const entries = toolEntries(core);
      // 文本增量断开了合并组：前后各一行，分别展开各自步数的详情。
      expect(entries).toHaveLength(2);
      expect(entries[0].content).toBe('Completed 1 tool calls:\n1. zoom_to');
      expect(entries[1].content).toBe(
        'Completed 2 tool calls:\n1. query_features\n2. query_features',
      );
      core.dispose();
      mapContext.cleanup();
    });
  });

  it('records a ready entry on attach and clears with a system entry', () => {
    const core = new GeoAgentCore({
      defaultProvider: 'anthropic-compatible',
      apiKeys: { 'anthropic-compatible': 'sk-test' },
    });
    const changes: string[] = [];
    core.onConversation((change, entries) => {
      changes.push(`${change.type}:${entries.length}`);
    });
    core.attach(mapContext.map);

    // attach appends the ready log entry.
    expect(changes).toEqual(['append:1']);
    expect(core.getConversation()[0].role).toBe('system');

    core.clearConversation();
    expect(core.getConversation().map((entry) => entry.role)).toEqual(['system']);
    expect(core.getConversation()[0].content).toContain('Chat cleared');
    core.dispose();
    mapContext.cleanup();
  });

  it('exports the conversation as markdown with capitalized roles', () => {
    sessionStorage.setItem(
      'web-geoagent.baseUrl.anthropic-compatible',
      'https://gateway.example.com',
    );
    const core = new GeoAgentCore({
      defaultProvider: 'anthropic-compatible',
      apiKeys: { 'anthropic-compatible': 'sk-test' },
    });
    core.attach(mapContext.map);
    const markdown = core.conversationMarkdown();
    expect(markdown).toBe(
      '## System\n\nBrowser-only Strands agent ready (MapLibre).',
    );
    core.dispose();
    mapContext.cleanup();
  });

  it('names the actual map engine in the ready entry', () => {
    sessionStorage.setItem(
      'web-geoagent.baseUrl.anthropic-compatible',
      'https://gateway.example.com',
    );
    // A minimal Leaflet-flavored map: the shim constructor walks the existing
    // layers and registers a zoomend listener.
    const leafletMap = {
      getContainer: () => mapContext.container,
      eachLayer: (_cb: (layer: unknown) => void) => {},
      whenReady: (cb: () => void) => {
        cb();
      },
      _loaded: true,
      on: () => {},
      off: () => {},
    };
    const core = new GeoAgentCore({
      defaultProvider: 'anthropic-compatible',
      apiKeys: { 'anthropic-compatible': 'sk-test' },
      mapEngine: { kind: 'leaflet', namespace: L as unknown as Record<string, unknown> },
    });
    core.attach(leafletMap as never);
    expect(core.conversationMarkdown()).toBe(
      '## System\n\nBrowser-only Strands agent ready (Leaflet).',
    );
    core.dispose();
  });

  it('keeps prompt history across prompts and navigates with drafts', async () => {
    const core = new GeoAgentCore();
    // sendPrompt without an attached map fails synchronously into the error
    // path, but the prompt is still remembered — enough to drive history.
    await core.sendPrompt('first question');
    await core.sendPrompt('second question');

    expect(core.historyUp('', 0, 0)).toBe('second question');
    expect(core.historyUp('second question', 15, 15)).toBe('first question');
    expect(core.historyDown('first question', 14, 14)).toBe('second question');
    expect(core.historyDown('second question', 15, 15)).toBe('');
    expect(core.historyDown('', 0, 0)).toBeNull();
    core.dispose();
  });

  it('refuses history navigation across multiline carets', async () => {
    const core = new GeoAgentCore();
    await core.sendPrompt('only line');
    // caret on the second line of a multiline draft: ArrowUp must not navigate
    expect(core.historyUp('line one\nline two', 18, 18)).toBeNull();
    // ArrowDown with no active navigation is a no-op
    expect(core.historyDown('line one\nline two', 0, 0)).toBeNull();
    core.dispose();
  });
});

describe('GeoAgentCore status', () => {
  let mapContext: ReturnType<typeof createMockMap>;

  beforeEach(() => {
    sessionStorage.clear();
    mapContext = createMockMap();
  });

  it('emits setup and connected statuses as the configuration completes', () => {
    const core = new GeoAgentCore();
    const statuses: string[] = [];
    core.onStatus((status) => statuses.push(`${status.kind}:${status.text}`));
    core.attach(mapContext.map);

    expect(statuses[0]).toBe('setup:Setup required');
    // The key alone is not enough for the compatible provider: the badge only
    // flips to Ready once base URL and model are set too.
    core.commitApiKey('sk-test');
    core.setBaseUrl('https://llm.example.com/v1');
    core.setModelId('local-model');
    expect(statuses[statuses.length - 1]).toBe('connected:Ready');
    expect(core.getStatus().transient).toBe(false);
    core.dispose();
    mapContext.cleanup();
  });

  it('reports the earth engine status from options and project id', () => {
    // Without Earth Engine options there are no credentials at all.
    const core = new GeoAgentCore();
    expect(core.getEarthEngineStatusText()).toContain('OAuth Client ID');

    const eeCore = new GeoAgentCore({ earthEngine: { oauthClientId: 'client' } });
    expect(eeCore.getEarthEngineStatusText()).toContain('project ID');
    eeCore.setEarthEngineSettings({ projectId: 'my-project' });
    expect(
      sessionStorage.getItem('web-geoagent.earthEngine.projectId'),
    ).toBe('my-project');
    expect(eeCore.getEarthEngineStatusText()).toContain('configured');
    eeCore.dispose();
    core.dispose();
  });

  it('dispose clears listeners and aborts the run state', () => {
    const core = new GeoAgentCore();
    const onStatus = vi.fn();
    core.onStatus(onStatus);
    core.attach(mapContext.map);
    core.dispose();
    core.commitApiKey('sk-after-dispose');
    expect(onStatus).toHaveBeenCalledTimes(1); // only the attach-time status
  });
});

describe('engine-aware system prompt parts', () => {
  it('states the 2D capability boundary before any tool call', () => {
    const leaflet = engineCapabilityPrompt('leaflet');
    expect(leaflet).toMatch(/Leaflet, a 2D-only engine/);
    expect(leaflet).toMatch(
      /no globe projection, no terrain, no sky, no 3D buildings/,
    );
    expect(leaflet).toMatch(/no map screenshot/);

    const openlayers = engineCapabilityPrompt('openlayers');
    expect(openlayers).toMatch(/OpenLayers, a 2D engine/);
    expect(openlayers).toMatch(
      /no globe projection, no terrain, no sky, no 3D buildings/,
    );
    // OpenLayers keeps a real bearing through the view rotation.
    expect(openlayers).toMatch(/bearing follows the view rotation/);
    expect(openlayers).not.toMatch(/bearing are always 0/);

    // MapLibre needs no capability paragraph; Mapbox only warns about sky.
    expect(engineCapabilityPrompt('maplibre')).toBe('');
    expect(engineCapabilityPrompt(undefined)).toBe('');
    expect(engineCapabilityPrompt('mapbox')).toMatch(/Sky specification tools/);
  });

  it('names the real snippet bindings per engine in the code prompt', () => {
    expect(codeExecutionPrompt('leaflet')).toMatch(
      /map \(the real Leaflet L\.Map\), L \(the Leaflet namespace\)/,
    );
    expect(codeExecutionPrompt('leaflet')).toMatch(/not MapLibre/);
    expect(codeExecutionPrompt('openlayers')).toMatch(
      /map \(the real OpenLayers ol\/Map\), ol \(the OpenLayers namespace object\)/,
    );
    expect(codeExecutionPrompt('maplibre')).toMatch(/map, maplibregl, and helpers/);
    expect(codeExecutionPrompt('mapbox')).toMatch(/map, mapboxgl, and helpers/);
    expect(codeExecutionPrompt('mapbox')).not.toMatch(/maplibregl/);
    expect(codeExecutionPrompt('leaflet')).not.toMatch(/maplibregl/);
  });
});
