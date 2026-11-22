import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeoAgentCore } from '../src/lib/core/GeoAgentCore';

const { stream, cancel } = vi.hoisted(() => ({ stream: vi.fn(), cancel: vi.fn() }));
vi.mock('@strands-agents/sdk', () => ({
  Agent: class { stream = stream; cancel = cancel; },
  tool: () => ({}),
}));
vi.mock('@strands-agents/sdk/models/openai', () => ({ OpenAIModel: class {} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function map() {
  return { getContainer: () => document.createElement('div') } as never;
}
function configuredCore() {
  return new GeoAgentCore({ defaultApiKey: 'test', defaultBaseUrl: 'https://example.com/v1', defaultModel: 'test' });
}
const delta = (text: string) => ({ type: 'modelStreamUpdateEvent', event: {
  type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text },
}});

describe('GeoAgentCore run lifecycle', () => {
  beforeEach(() => { sessionStorage.clear(); stream.mockReset(); cancel.mockReset(); });

  it.each(['detach', 'dispose'] as const)('does not start a stream when %s happens during model loading', async (action) => {
    const core = configuredCore();
    core.attach(map());
    const model = deferred<unknown>();
    const internals = core as unknown as { createProviderModel: () => Promise<unknown> };
    vi.spyOn(internals, 'createProviderModel').mockReturnValue(model.promise);
    const run = core.sendPrompt('first');
    core[action]();
    model.resolve({});
    await run;
    expect(stream).not.toHaveBeenCalled();
    expect(core.getState().busy).toBe(false);
    core.dispose();
  });

  it('aborts a detached run and ignores late events/finalizers after a new map run starts', async () => {
    const oldGate = deferred<void>();
    const newGate = deferred<void>();
    let oldSignal: AbortSignal | undefined;
    stream.mockImplementationOnce((_text, options) => {
      oldSignal = options.cancelSignal;
      return (async function* () { await oldGate.promise; yield delta('STALE'); })();
    }).mockImplementationOnce(() => (async function* () {
      await newGate.promise; yield delta('CURRENT');
    })());
    const core = configuredCore();
    core.attach(map());
    const oldRun = core.sendPrompt('old');
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    core.attach(map());
    expect(oldSignal?.aborted).toBe(true);
    const newRun = core.sendPrompt('new');
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
    oldGate.resolve();
    await oldRun;
    expect(core.getState().busy).toBe(true);
    expect(core.conversationMarkdown()).not.toContain('STALE');
    newGate.resolve();
    await newRun;
    expect(core.getState().busy).toBe(false);
    expect(core.conversationMarkdown()).toContain('CURRENT');
    core.dispose();
  });
});
