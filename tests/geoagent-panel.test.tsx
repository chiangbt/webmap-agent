import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeoAgentCore } from '../src/lib/core/GeoAgentCore';
import { GeoAgentPanel } from '../src/lib/panel/GeoAgentPanel';
import { Button } from '../src/lib/ui/button';
import { Input } from '../src/lib/ui/input';
import { Textarea } from '../src/lib/ui/textarea';

// jsdom lacks scrollIntoView, which Radix Select item focusing requires.
Element.prototype.scrollIntoView = vi.fn();

// The agent/model SDK is mocked so prompt runs stream deterministic text.
// vi.hoisted keeps the factories available to the hoisted vi.mock calls below.
const { streamMock, AgentMock } = vi.hoisted(() => {
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
  return { streamMock, AgentMock };
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
    map: { getContainer: () => container, getStyle: () => ({ layers: [] }), on: vi.fn(), off: vi.fn() } as never,
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
        'Strands agent loaded',
      );
    });
    cleanup();
  });

  it('shows the API base URL field for both compatible providers', () => {
    const { map, cleanup } = createMockMap();
    const openai = render(<GeoAgentPanel map={map} collapsed={false} />);
    const openaiBaseUrl = screen.getByTestId(
      'geoagent-base-url',
    ) as HTMLInputElement;
    expect(openaiBaseUrl.placeholder).toBe('https://host/v1');
    // No default model for the OpenAI-compatible endpoint.
    expect((screen.getByTestId('geoagent-model') as HTMLInputElement).value).toBe('');
    openai.unmount();

    const anthropic = render(
      <GeoAgentPanel map={map} collapsed={false} defaultProvider="anthropic-compatible" />,
    );
    const anthropicBaseUrl = screen.getByTestId(
      'geoagent-base-url',
    ) as HTMLInputElement;
    expect(anthropicBaseUrl.placeholder).toBe('https://host');
    expect(
      (screen.getByTestId('geoagent-model') as HTMLInputElement).value,
    ).toBe('claude-opus-4-8');
    anthropic.unmount();
    cleanup();
  });

  it('renders the two compatible providers in the select trigger value', () => {
    const { map, cleanup } = createMockMap();
    render(<GeoAgentPanel map={map} collapsed={false} />);
    const trigger = screen.getByTestId('geoagent-provider');
    expect(trigger.textContent).toContain('OpenAI-Compatible (Custom)');
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
    // The compatible provider also needs a base URL and a model id; seed them
    // so committing the key completes the configuration.
    sessionStorage.setItem('web-geoagent.baseUrl.openai-compatible', 'https://llm.example.com/v1');
    sessionStorage.setItem('web-geoagent.model.openai-compatible', 'local-model');
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
      sessionStorage.getItem('web-geoagent.openai-compatible.api_key'),
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
    sessionStorage.setItem(
      'web-geoagent.baseUrl.anthropic-compatible',
      'https://gateway.example.com',
    );
    const { map, cleanup } = createMockMap();
    render(
      <GeoAgentPanel
        map={map}
        collapsed={false}
        defaultProvider="anthropic-compatible"
        apiKeys={{ 'anthropic-compatible': 'sk-test' }}
      />,
    );

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
    sessionStorage.setItem(
      'web-geoagent.baseUrl.anthropic-compatible',
      'https://gateway.example.com',
    );
    const { map, cleanup } = createMockMap();
    render(
      <GeoAgentPanel
        map={map}
        collapsed={false}
        defaultProvider="anthropic-compatible"
        apiKeys={{ 'anthropic-compatible': 'sk-test' }}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('geoagent-entry').length).toBe(1);
    });
    fireEvent.click(screen.getByTestId('geoagent-copy'));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(
      '## System\n\nBrowser-only Strands agent ready (MapLibre).',
    );
    expect(screen.getByTestId('geoagent-status').textContent).toBe('Copied');
    cleanup();
  });

  it('forwards refs on the shadcn primitives (React 18 compatibility)', () => {
    const textareaRef = { current: null as HTMLTextAreaElement | null };
    const inputRef = { current: null as HTMLInputElement | null };
    const buttonRef = { current: null as HTMLButtonElement | null };
    render(
      <div>
        <Textarea ref={textareaRef} data-testid="t" />
        <Input ref={inputRef} data-testid="i" />
        <Button ref={buttonRef} data-testid="b" />
      </div>,
    );
    // A plain function component would leave all three null and log
    // "Function components cannot be given refs" in dev.
    expect(textareaRef.current).toBeInstanceOf(HTMLTextAreaElement);
    expect(inputRef.current).toBeInstanceOf(HTMLInputElement);
    expect(buttonRef.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('accepts a controlled core and reports state changes', async () => {
    const core = new GeoAgentCore({ collapsed: false, apiKeys: { 'openai-compatible': 'sk-ant' } });
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
      sessionStorage.getItem('web-geoagent.openai-compatible.api_key'),
    ).toBe('sk-later');
    core.dispose();
  });
});


describe('audit React frame batching', () => {
  it('updates an existing tool entry when the same frame also appends an answer', () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length; });
    const core = new GeoAgentCore({ collapsed: false });
    const handle = (core as unknown as { handleAgentStreamEvent: (event: unknown) => void }).handleAgentStreamEvent.bind(core);
    const view = render(<GeoAgentPanel core={core} />);
    const flush = () => act(() => { for (const callback of frames.splice(0)) callback(0); });
    act(() => handle({ type: 'beforeToolCallEvent', toolUse: { name: 'add_marker' } }));
    flush();
    expect(screen.getByTestId('geoagent-entry').textContent).toContain('Running tool');
    act(() => handle({ type: 'modelStreamUpdateEvent', event: {
      type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Done' },
    }}));
    flush();
    expect(screen.getAllByTestId('geoagent-entry')[0].textContent).toContain('Tool calls: 1');
    view.unmount(); core.dispose(); raf.mockRestore();
  });
});


it('refreshes the credential input after a programmatic provider switch', () => {
  sessionStorage.clear();
  const core = new GeoAgentCore({ collapsed: false, apiKeys: {
    'openai-compatible': 'key-a', 'anthropic-compatible': 'key-b',
  }});
  core.loadProviderSettings();
  const view = render(<GeoAgentPanel core={core} />);
  expect((screen.getByTestId('geoagent-api-key') as HTMLInputElement).value).toBe('key-a');
  act(() => core.setState({ providerId: 'anthropic-compatible' }));
  expect((screen.getByTestId('geoagent-api-key') as HTMLInputElement).value).toBe('key-b');
  fireEvent.blur(screen.getByTestId('geoagent-api-key'));
  expect(core.getCommittedApiKey()).toBe('key-b');
  view.unmount(); core.dispose();
});

it('replaces all visible snapshots when a controlled core changes without emitting events', async () => {
  sessionStorage.clear();
  const first = new GeoAgentCore({ collapsed: false });
  const second = new GeoAgentCore({ collapsed: false, defaultProvider: 'anthropic-compatible' });
  await first.sendPrompt('FIRST HISTORY');
  await second.sendPrompt('SECOND HISTORY');
  const view = render(<GeoAgentPanel core={first} />);
  expect(view.container.textContent).toContain('FIRST HISTORY');
  view.rerender(<GeoAgentPanel core={second} />);
  expect(view.container.textContent).toContain('SECOND HISTORY');
  expect(view.container.textContent).not.toContain('FIRST HISTORY');
  expect(screen.getByTestId('geoagent-provider').textContent).toContain('Anthropic');
  view.unmount(); first.dispose(); second.dispose();
});

it('ignores events from the previous core after replacement', async () => {
  const first = new GeoAgentCore({ collapsed: false });
  const second = new GeoAgentCore({ collapsed: false });
  await second.sendPrompt('CURRENT');
  const view = render(<GeoAgentPanel core={first} />);
  act(() => first.clearConversation()); // schedules a frame on the old subscription
  view.rerender(<GeoAgentPanel core={second} />);
  await act(async () => { await first.sendPrompt('STALE'); });
  expect(view.container.textContent).toContain('CURRENT');
  expect(view.container.textContent).not.toContain('STALE');
  view.unmount(); first.dispose(); second.dispose();
});

describe('GeoAgentPanel plan collapse', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  function setup() {
    const container = document.createElement('div');
    container.style.width = '800px';
    container.style.height = '600px';
    document.body.appendChild(container);
    const map = { getContainer: () => container, getStyle: () => ({ layers: [] }), on: vi.fn(), off: vi.fn() } as never;
    // 传入受控 core 时 collapsed prop 不生效（options 只在自建 core 时捕获），
    // 直接构造展开状态的核心。
    const core = new GeoAgentCore({ collapsed: false });
    render(<GeoAgentPanel core={core} map={map} />);
    return {
      core,
      run: (command: string, args?: unknown) => act(async () => { await core.getTools()!.runCommand(command, args); }),
      cleanup: () => { container.remove(); },
    };
  }

  it('hides the plan block when no plan exists', () => {
    const { cleanup } = setup();
    expect(screen.queryByTestId('geoagent-plan')).toBeNull();
    cleanup();
  });

  it('defaults to collapsed after create_plan and toggles on title click', async () => {
    const { run, cleanup } = setup();
    await run('create_plan', { steps: ['first', 'second'] });
    expect(screen.getByTestId('geoagent-plan')).toBeTruthy();
    // 默认收起：标题行（含进度）可见，步骤列表不可见。
    expect(screen.getByTestId('geoagent-plan-toggle').textContent).toContain('0/2');
    expect(screen.queryByTestId('geoagent-plan-step-1')).toBeNull();
    fireEvent.click(screen.getByTestId('geoagent-plan-toggle'));
    expect(screen.getByTestId('geoagent-plan-step-1')).toBeTruthy();
    // 再点一次收起。
    fireEvent.click(screen.getByTestId('geoagent-plan-toggle'));
    expect(screen.queryByTestId('geoagent-plan-step-1')).toBeNull();
    cleanup();
  });

  it('auto-expands once when a step moves to in_progress', async () => {
    const { run, cleanup } = setup();
    await run('create_plan', { steps: ['first', 'second'] });
    expect(screen.queryByTestId('geoagent-plan-step-1')).toBeNull();
    await run('update_plan_step', { index: 1, status: 'in_progress' });
    expect(screen.getByTestId('geoagent-plan-step-1')).toBeTruthy();
    // 用户手动收起后不再被顶开（活跃状态未发生新的边沿）。
    fireEvent.click(screen.getByTestId('geoagent-plan-toggle'));
    expect(screen.queryByTestId('geoagent-plan-step-1')).toBeNull();
    cleanup();
  });
});
