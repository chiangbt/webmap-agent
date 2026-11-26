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

describe('plan tools (multi-step task queue)', () => {
  let mapContext: ReturnType<typeof createMockMap>;
  let core: GeoAgentCore;

  beforeEach(() => {
    sessionStorage.clear();
    mapContext = createMockMap();
    core = new GeoAgentCore();
    core.attach(mapContext.map);
  });

  afterEach(() => {
    core.dispose();
    mapContext.cleanup();
  });

  function run(command: string, args?: unknown) {
    return core.getTools()!.runCommand(command, args) as Promise<{
      steps: Array<{ id: number; title: string; status: string; note?: string }>;
    }>;
  }

  it('exposes create_plan and update_plan_step to the agent', () => {
    const names = core.getTools()!.createTools().map((tool) => tool.name);
    expect(names).toContain('create_plan');
    expect(names).toContain('update_plan_step');
  });

  it('creates a plan with pending steps and publishes it to state.data.plan', async () => {
    const result = await run('create_plan', { steps: ['search place', 'load geojson', 'compute stats'] });
    expect(result.steps.map((step) => step.status)).toEqual(['pending', 'pending', 'pending']);
    expect(result.steps.map((step) => step.id)).toEqual([1, 2, 3]);
    const published = (core.getState().data as { plan?: { steps: unknown[] } }).plan;
    expect(published?.steps).toHaveLength(3);
  });

  it('updates step status and note through the 1-based index', async () => {
    await run('create_plan', { steps: ['a', 'b'] });
    const started = await run('update_plan_step', { index: 1, status: 'in_progress' });
    expect(started.steps[0].status).toBe('in_progress');
    const done = await run('update_plan_step', { index: 1, status: 'done', note: 'layer x added' });
    expect(done.steps[0].status).toBe('done');
    expect(done.steps[0].note).toBe('layer x added');
  });

  it('rejects updates without a plan, unknown indexes and invalid statuses', async () => {
    await expect(run('update_plan_step', { index: 1, status: 'done' })).rejects.toThrow(/create_plan/);
    await run('create_plan', { steps: ['only'] });
    await expect(run('update_plan_step', { index: 5, status: 'done' })).rejects.toThrow(/valid ids/);
    await expect(run('update_plan_step', { index: 1, status: 'bogus' })).rejects.toThrow(/status must be/);
    await expect(run('create_plan', { steps: [] })).rejects.toThrow(/non-empty/);
  });

  it('caps the plan at 12 steps', async () => {
    const result = await run('create_plan', {
      steps: Array.from({ length: 20 }, (_, index) => `step ${index + 1}`),
    });
    expect(result.steps).toHaveLength(12);
  });

  it('clears the plan and publishes null', async () => {
    await run('create_plan', { steps: ['a'] });
    await run('clear_plan');
    const published = (core.getState().data as { plan?: unknown }).plan;
    expect(published).toBeNull();
  });
});
