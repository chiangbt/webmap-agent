import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeoAgentCore } from '../src/lib/core/GeoAgentCore';

function createMockMap() {
  const container = document.createElement('div');
  container.style.width = '800px';
  container.style.height = '600px';
  document.body.appendChild(container);
  const map = {
    getContainer: () => container,
    getStyle: () => ({ layers: [] }),
    on: vi.fn(),
    off: vi.fn(),
  };
  return { map: map as never, container, cleanup: () => container.remove() };
}

describe('conversation persistence', () => {
  let mapContext: ReturnType<typeof createMockMap>;

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.useFakeTimers();
    mapContext = createMockMap();
  });

  afterEach(() => {
    vi.useRealTimers();
    mapContext.cleanup();
  });

  it('persists entries and restores them into a new core', () => {
    const first = new GeoAgentCore({ persistConversation: true, storagePrefix: 'p' });
    first.attach(mapContext.map);
    expect(first.getConversation().length).toBeGreaterThan(0);
    vi.advanceTimersByTime(400);
    const stored = localStorage.getItem('p.conversation');
    expect(stored).toBeTruthy();

    const second = new GeoAgentCore({ persistConversation: true, storagePrefix: 'p' });
    expect(second.getConversation()).toEqual(first.getConversation());
    second.dispose();
    first.dispose();
  });

  it('clears the persisted conversation on clearConversation', () => {
    const core = new GeoAgentCore({ persistConversation: true, storagePrefix: 'c' });
    core.attach(mapContext.map);
    vi.advanceTimersByTime(400);
    expect(localStorage.getItem('c.conversation')).toBeTruthy();
    core.clearConversation();
    expect(localStorage.getItem('c.conversation')).toBeNull();
    core.dispose();
  });

  it('ignores corrupted persisted JSON', () => {
    localStorage.setItem('x.conversation', '{broken');
    const core = new GeoAgentCore({ persistConversation: true, storagePrefix: 'x' });
    expect(core.getConversation()).toEqual([]);
    core.dispose();
  });

  it('does not persist by default', () => {
    const core = new GeoAgentCore({ storagePrefix: 'off' });
    core.attach(mapContext.map);
    vi.advanceTimersByTime(1000);
    expect(localStorage.getItem('off.conversation')).toBeNull();
    core.dispose();
  });
});

describe('fetchAvailableModels', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires key and base URL before fetching', async () => {
    const core = new GeoAgentCore();
    await expect(core.fetchAvailableModels()).rejects.toThrow(/API/);
    core.dispose();
  });

  it('fetches OpenAI-compatible models with bearer auth', async () => {
    const core = new GeoAgentCore();
    core.setBaseUrl('https://api.example.com/v1/');
    core.commitApiKey('sk-test');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'm2' }, { id: 'm1' }, 'bad' ] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const models = await core.fetchAvailableModels();
    expect(models).toEqual(['m1', 'm2']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    core.dispose();
  });

  it('fetches Anthropic-compatible models with x-api-key at /v1/models', async () => {
    const core = new GeoAgentCore({ defaultProvider: 'anthropic-compatible' });
    core.setBaseUrl('https://gw.example.com');
    core.commitApiKey('sk-ant');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'claude-x' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const models = await core.fetchAvailableModels();
    expect(models).toEqual(['claude-x']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gw.example.com/v1/models');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant');
    core.dispose();
  });

  it('surfaces HTTP failures as localized errors', async () => {
    const core = new GeoAgentCore();
    core.setBaseUrl('https://api.example.com/v1');
    core.commitApiKey('sk-test');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    await expect(core.fetchAvailableModels()).rejects.toThrow(/403/);
    core.dispose();
  });
});
