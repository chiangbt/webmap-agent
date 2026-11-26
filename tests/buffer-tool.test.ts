import { describe, expect, it, vi } from 'vitest';
import { MapLibreAgentTools } from '../src/lib/core/tools/maplibre-tools';

/** Minimal MapLibre-shaped map covering the members these commands reach. */
class MockMap {
  sources: Record<string, Record<string, unknown>> = {};
  layers: Array<Record<string, unknown> & { id: string; type: string }> = [];
  readonly loaded = vi.fn(() => true);
  readonly once = vi.fn((_event: string, callback: () => void) => callback());
  readonly fitBounds = vi.fn();
  readonly easeTo = vi.fn();
  readonly getZoom = vi.fn(() => 4);
  readonly queryRenderedFeatures = vi.fn(() => []);
  readonly getCanvas = vi.fn(() => ({
    clientWidth: 100,
    clientHeight: 100,
    width: 100,
    height: 100,
    toDataURL: () => 'data:image/png;base64,mock',
  }));

  getStyle() {
    return { version: 8, sources: this.sources, layers: this.layers };
  }

  getSource(sourceId: string) {
    return this.sources[sourceId];
  }

  addSource(sourceId: string, source: Record<string, unknown>) {
    this.sources[sourceId] = { ...source };
  }

  removeSource(sourceId: string) {
    delete this.sources[sourceId];
  }

  getLayer(layerId: string) {
    return this.layers.find((layer) => layer.id === layerId);
  }

  addLayer(layer: Record<string, unknown> & { id: string; type: string }) {
    this.layers.push({ ...layer });
  }

  removeLayer(layerId: string) {
    this.layers = this.layers.filter((layer) => layer.id !== layerId);
  }
}

/** 1° × 1° 的正方形（赤道处约 111 km 宽），用于校验缓冲结果面积。 */
const SQUARE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      },
    },
  ],
};

function makeTools() {
  return new MapLibreAgentTools(new MockMap() as never, {
    basemaps: {},
    allowCodeExecution: () => false,
    allowDestructiveTools: () => true,
    onStateDataChange: vi.fn(),
  } as never);
}

describe('buffer_layer (built-in spatial analysis)', () => {
  it('exposes buffer_layer through createTools', () => {
    const tools = makeTools();
    const names = tools.createTools().map((tool) => tool.name);
    expect(names).toContain('buffer_layer');
  });

  it('buffers a user-added geojson layer and registers the result', async () => {
    const tools = makeTools();
    await tools.runCommand('add_geojson_data', { name: 'aoi', data: SQUARE });
    const result = (await tools.runCommand('buffer_layer', { name: 'aoi', radiusKm: 10 })) as {
      success: boolean;
      name: string;
      radiusKm: number;
      featureCount: number;
      areaKm2: number;
    };
    expect(result.success).toBe(true);
    expect(result.name).toBe('aoi-buffer');
    expect(result.featureCount).toBe(1);
    // 1° 方形约 12300 km²，四周各加 10 km 后应显著大于原面积。
    expect(result.areaKm2).toBeGreaterThan(14000);
    // 结果作为新 geojson overlay 入账，并被 agent 的 list_layers 看到。
    const layers = (await tools.runCommand('list_layers')) as { name?: string }[];
    const serialized = JSON.stringify(layers);
    expect(serialized).toContain('aoi-buffer');
    expect(serialized).toContain('aoi-buffer-fill');
  });

  it('accepts GeoJSON passed as a JSON-encoded string and rejects broken JSON', async () => {
    const tools = makeTools();
    // 模型高频行为：把 GeoJSON 序列化成 JSON 字符串传入。
    const result = await tools.runCommand('add_geojson_data', {
      name: 'aoi-string',
      data: JSON.stringify(SQUARE),
    });
    expect(String(result)).toContain('aoi-string');
    await expect(
      tools.runCommand('add_geojson_data', { name: 'broken', data: '{not json' }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('rejects unknown layers, non-geojson overlays and invalid radii', async () => {
    const tools = makeTools();
    await expect(
      tools.runCommand('buffer_layer', { name: 'missing', radiusKm: 5 }),
    ).rejects.toThrow(/not found/);
    // raster 底图也是合法 overlay，但不是 geojson —— 缓冲应明确拒绝。
    await tools.runCommand('add_basemap', { provider: 'esri_world_imagery', name: 'pin' });
    await expect(
      tools.runCommand('buffer_layer', { name: 'pin', radiusKm: 5 }),
    ).rejects.toThrow(/GeoJSON layer/);
    await tools.runCommand('add_geojson_data', { name: 'aoi', data: SQUARE });
    await expect(
      tools.runCommand('buffer_layer', { name: 'aoi', radiusKm: -1 }),
    ).rejects.toThrow(/radiusKm/);
    await expect(
      tools.runCommand('buffer_layer', { name: 'aoi', radiusKm: 5000 }),
    ).rejects.toThrow(/radiusKm/);
  });
});
