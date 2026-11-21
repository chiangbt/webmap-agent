import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeoAgentCore } from '../src/lib/core/GeoAgentCore';
import { GeoAgentPanel } from '../src/lib/panel/GeoAgentPanel';

// jsdom lacks scrollIntoView, which Radix Select item focusing requires.
Element.prototype.scrollIntoView = vi.fn();

// The agent/model SDK is mocked so prompt runs stream deterministic text.
// vi.hoisted keeps the factories available to the hoisted vi.mock calls below.
const { streamMock, agentCancelMock, AgentMock } = vi.hoisted(() => {
  const streamEvents = [
    {
      type: 'modelStreamUpdateEvent',
      event: {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: 'Hello' },
      },
    },
    {
      type: 'modelStreamUpdateEvent',
      event: {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: ' answer' },
      },
    },
    { type: 'agentResultEvent', result: { toString: () => 'Hello answer' } },
  ];
  const streamMock = vi.fn(() =>
    (async function* () {
      for (const event of streamEvents) {
        yield event;
      }
    })(),
  );
  const agentCancelMock = vi.fn();
  const AgentMock = vi.fn().mockImplementation(() => ({
    stream: streamMock,
    cancel: agentCancelMock,
  }));
  return { streamMock, agentCancelMock, AgentMock };
});

vi.mock('@strands-agents/sdk', () => ({
  Agent: AgentMock,
  // maplibre-tools defines its tools with the runtime `tool()` helper; the
  // mocked Agent never inspects them, so a minimal stub is enough.
  tool: () => ({ name: 'fake-tool' }),
}));
vi.mock('@strands-agents/sdk/models/openai', () => ({
  OpenAIModel: class {},
}));

function createMockMap() {
  const container = document.createElement('div');
  container.style.width = '800px';
  container.style.height = '600px';
  document.body.appendChild(container);
  return {
    map: { getContainer: () => container, on: vi.fn(), off: vi.fn() } as never,
    cleanup: () => container.remove(),
  };
}

describe('GeoAgentPanel rendering', () => {
  beforeEach(() => {
    sessionStorage.clear();
    AgentMock.mockClear();
    streamMock.mockClear();
  });

  it('renders the header, status badge, and ready log entry', async () => {
    const { map, cleanup } = createMockMap();
    render(<GeoAgentPanel map={map} collapsed={false} />);

    expect(screen.getByTestId('geoagent-panel')).toBeTruthy();
    expect(screen.getByTestId('geoagent-status').textContent).toBe('Setup required');
    await waitFor(() => {
      expect(screen.getAllByTestId('geoagent-entry').length).toBe(1);
      expect(screen.getAllByTestId('geoagent-entry')[0].textContent).toContain(
        'Strands MapLibre agent loaded',
      );
    });
    cleanup();
  });

  it('hides the base URL field for direct providers and shows it for compatible ones', () => {
    const { map, cleanup } = createMockMap();
    const direct = render(<GeoAgentPanel map={map} collapsed={false} />);
    expect(screen.queryByTestId('geoagent-base-url')).toBeNull();
    direct.unmount();

    const compatible = render(
      <GeoAgentPanel map={map} collapsed={false} defaultProvider="anthropic-compatible" />,
    );
    expect(screen.queryByTestId('geoagent-base-url')).toBeTruthy();
    expect(
      (screen.getByTestId('geoagent-model') as HTMLInputElement).value,
    ).toBe('claude-opus-4-8');
    compatible.unmount();
    cleanup();
  });

  it('renders the five providers in the select trigger value', () => {
    const { map, cleanup } = createMockMap();
    render(<GeoAgentPanel map={map} collapsed={false} />);
    const trigger = screen.getByTestId('geoagent-provider');
    expect(trigger.textContent).toContain('OpenAI Responses');
    cleanup();
  });

  it('hides the collapse button when showCollapseButton is false', () => {
    const { map, cleanup } = createMockMap();
    const { rerender } = render(
      <GeoAgentPanel map={map} collapsed={false} showCollapseButton={false} />,
    );
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();

    rerender(<GeoAgentPanel map={map} collapsed={false} />);
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    cleanup();
  });
});

describe('GeoAgentPanel configuration flow', () => {
  beforeEach(() => {
    sessionStorage.clear();
    AgentMock.mockClear();
    streamMock.mockClear();
  });

  it('commits the API key on Enter and unlocks the prompt', async () => {
    const { map, cleanup } = createMockMap();
    render(<GeoAgentPanel map={map} collapsed={false} />);

    const apiKey = screen.getByTestId('geoagent-api-key') as HTMLInputElement;
    const prompt = screen.getByTestId('geoagent-prompt') as HTMLTextAreaElement;
    expect(prompt.disabled).toBe(true);

    fireEvent.change(apiKey, { target: { value: 'sk-panel-test' } });
    expect(screen.getByTestId('geoagent-status').textContent).toBe('Setup required');
    fireEvent.keyDown(apiKey, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByTestId('geoagent-status').textContent).toBe('Ready');
    });
    expect(
      sessionStorage.getItem('geoagent.maplibre.openai-responses.api_key'),
    ).toBe('sk-panel-test');
    expect(prompt.disabled).toBe(false);
    cleanup();
  });

  it('shows the press-Enter note while the key is being typed', () => {
    const { map, cleanup } = createMockMap();
    render(<GeoAgentPanel map={map} collapsed={false} />);
    const apiKey = screen.getByTestId('geoagent-api-key');

    fireEvent.change(apiKey, { target: { value: 'sk-typing' } });
    const note = screen.getByTestId('geoagent-config-note');
    expect(note.textContent).toContain('Press Enter');

    cleanup();
  });
});

describe('GeoAgentPanel conversation flow', () => {
  beforeEach(() => {
    sessionStorage.clear();
    AgentMock.mockClear();
    streamMock.mockClear();
  });

  it('sends a prompt and renders the streamed assistant answer', async () => {
    const { map, cleanup } = createMockMap();
    render(<GeoAgentPanel map={map} collapsed={false} apiKeys={{ 'openai-responses': 'sk-test' }} />);

    const prompt = screen.getByTestId('geoagent-prompt') as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: 'Add a marker' } });
    fireEvent.keyDown(prompt, { key: 'Enter' });

    await waitFor(() => {
      const markdownEntries = screen.getAllByTestId('geoagent-entry-markdown');
      expect(
        markdownEntries.some((el) => el.textContent?.trim() === 'Hello answer'),
      ).toBe(true);
    });
    expect(streamMock).toHaveBeenCalledTimes(1);
    const roles = screen
      .getAllByTestId('geoagent-entry')
      .map((el) => el.getAttribute('data-role'));
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    cleanup();
  });

  it('copies the conversation as markdown', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { map, cleanup } = createMockMap();
    render(<GeoAgentPanel map={map} collapsed={false} apiKeys={{ 'openai-responses': 'sk-test' }} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('geoagent-entry').length).toBe(1);
    });
    fireEvent.click(screen.getByTestId('geoagent-copy'));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(
      '## System\n\nBrowser-only Strands MapLibre agent ready.',
    );
    expect(screen.getByTestId('geoagent-status').textContent).toBe('Copied');
    cleanup();
  });

  it('accepts a controlled core and reports state changes', async () => {
    const core = new GeoAgentCore({ collapsed: false, apiKeys: { anthropic: 'sk-ant' } });
    const onStateChange = vi.fn();
    const { map, cleanup } = createMockMap();
    render(<GeoAgentPanel core={core} map={map} onStateChange={onStateChange} />);

    core.setAllowDestructiveTools(false);
    await waitFor(() => {
      expect(onStateChange).toHaveBeenCalled();
    });
    expect(
      onStateChange.mock.calls.some(
        ([state]) => state.allowDestructiveTools === false,
      ),
    ).toBe(true);
    // A controlled core survives unmount: its listeners were removed but it is
    // not disposed, so committing a key still persists to storage.
    cleanup();
    core.commitApiKey('sk-later');
    expect(
      sessionStorage.getItem('geoagent.maplibre.openai-responses.api_key'),
    ).toBe('sk-later');
    core.dispose();
  });
});
