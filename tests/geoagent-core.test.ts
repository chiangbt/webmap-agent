import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeoAgentCore } from '../src/lib/core/GeoAgentCore';

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
  it('exposes the five supported providers without google/bedrock', () => {
    const core = new GeoAgentCore();
    expect(Object.keys(core.providerConfigs())).toEqual([
      'openai-responses',
      'openai-chat',
      'anthropic',
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
  });

  it('honors per-provider default model overrides', () => {
    const core = new GeoAgentCore({
      defaultModel: { anthropic: 'claude-custom', 'openai-responses': 'gpt-custom' },
    });
    expect(core.providerConfig('anthropic').defaultModel).toBe('claude-custom');
    expect(core.providerConfig('openai-responses').defaultModel).toBe('gpt-custom');
    expect(core.providerConfig('openai-chat').defaultModel).toBe('gpt-5.5');
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
    expect(core.isConfigured()).toBe(true);
    expect(
      sessionStorage.getItem('geoagent.maplibre.openai-responses.api_key'),
    ).toBe('sk-half-typed');
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
      sessionStorage.getItem('geoagent.maplibre.baseUrl.openai-compatible'),
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

  it('persists the provider choice and reloads its stored settings', () => {
    sessionStorage.setItem('geoagent.switch.anthropic.api_key', 'stored-ant');
    const core = new GeoAgentCore({ storagePrefix: 'geoagent.switch' });
    core.switchProvider('anthropic');
    expect(core.getState().providerId).toBe('anthropic');
    expect(core.getState().modelId).toBe('claude-opus-4-8');
    expect(core.getCommittedApiKey()).toBe('stored-ant');
    expect(sessionStorage.getItem('geoagent.switch.provider')).toBe('anthropic');
    core.dispose();
  });
});

describe('GeoAgentCore conversation', () => {
  let mapContext: ReturnType<typeof createMockMap>;

  beforeEach(() => {
    sessionStorage.clear();
    mapContext = createMockMap();
  });

  it('records a ready entry on attach and clears with a system entry', () => {
    const core = new GeoAgentCore({ apiKeys: { 'openai-responses': 'sk-test' } });
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
    const core = new GeoAgentCore({ apiKeys: { 'openai-responses': 'sk-test' } });
    core.attach(mapContext.map);
    const markdown = core.conversationMarkdown();
    expect(markdown).toBe(
      '## System\n\nBrowser-only Strands MapLibre agent ready.',
    );
    core.dispose();
    mapContext.cleanup();
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

  it('emits setup and connected statuses as the key is committed', () => {
    const core = new GeoAgentCore();
    const statuses: string[] = [];
    core.onStatus((status) => statuses.push(`${status.kind}:${status.text}`));
    core.attach(mapContext.map);

    expect(statuses[0]).toBe('setup:Setup required');
    core.commitApiKey('sk-test');
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
      sessionStorage.getItem('geoagent.maplibre.earthEngine.projectId'),
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
