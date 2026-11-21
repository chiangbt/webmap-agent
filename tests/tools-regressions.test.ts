import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapLibreAgentTools } from '../src/lib/core/tools/maplibre-tools';
import type { GeoAgentMapEngine } from '../src/lib/core/tools/maplibre-tools';

/**
 * Regression tests for defects found in the library audit:
 * - add_vector_data swallowed fetch failures and reported success
 * - set_layer_visibility claimed success on markers without hiding them
 * - default marker names collided after a removal (overlays.size + 1)
 */

/** Minimal MapLibre-shaped map covering the members these commands reach. */
class MockMap {
  sources: Record<string, Record<string, unknown>> = {};
  layers: Array<Record<string, unknown> & { id: string; type: string }> = [];
  layoutWrites: Array<{ id: string; property: string; value: unknown }> = [];
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
    return {
      version: 8,
      sources: this.sources,
      layers: this.layers,
    };
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

  setLayoutProperty(id: string, property: string, value: unknown) {
    this.layoutWrites.push({ id, property, value });
    const layer = this.layers.find((item) => item.id === id);
    if (layer) {
      const layout = {
        ...((layer.layout as Record<string, unknown>) ?? {}),
        [property]: value,
      };
      layer.layout = layout;
    }
  }
}

function markerNamespace() {
  const built: Array<{
    element: HTMLDivElement;
    lngLat?: unknown;
    removed?: boolean;
  }> = [];
  class FakeMarker {
    record: (typeof built)[number];
    constructor(_options?: unknown) {
      this.record = { element: document.createElement('div') };
      built.push(this.record);
    }
    setLngLat(lngLat: unknown) {
      this.record.lngLat = lngLat;
      return this;
    }
    addTo(_map: unknown) {
      return this;
    }
    setPopup(_popup: unknown) {
      return this;
    }
    getElement() {
      return this.record.element;
    }
    remove() {
      this.record.removed = true;
      return this;
    }
  }
  class FakePopup {
    setText(_text: string) {
      return this;
    }
  }
  const namespace = {
    Marker: FakeMarker,
    Popup: FakePopup,
  } as unknown as Record<string, unknown>;
  return { built, namespace };
}

function tools(map: unknown, namespace: Record<string, unknown>) {
  return new MapLibreAgentTools(map as never, {
    allowCodeExecution: () => true,
    allowDestructiveTools: () => true,
    mapEngine: { kind: 'maplibre', namespace } as GeoAgentMapEngine,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('add_vector_data fetch failures surface to the agent', () => {
  it('rejects with the fetch error instead of reporting success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('not found', { status: 404 }),
      ),
    );
    const { namespace } = markerNamespace();
    const agent = tools(new MockMap(), namespace);

    await expect(
      agent.runCommand('add_vector_data', {
        url: 'https://example.com/missing.geojson',
        name: 'broken',
      }),
    ).rejects.toThrow(/Could not fetch GeoJSON \(404\)/);
  });

  it('still succeeds when the URL fetches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [0, 0] },
                properties: {},
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const map = new MockMap();
    const { namespace } = markerNamespace();
    const agent = tools(map, namespace);

    const message = (await agent.runCommand('add_vector_data', {
      url: 'https://example.com/points.geojson',
      name: 'points',
    })) as string;
    expect(message).toContain('Added GeoJSON URL layer points');
    expect(map.getSource('points-source')).toBeTruthy();
  });
});

describe('set_layer_visibility on markers', () => {
  it('hides and shows the marker element', async () => {
    const map = new MockMap();
    const { built, namespace } = markerNamespace();
    const agent = tools(map, namespace);

    await agent.runCommand('add_marker', { name: 'pin', lon: 1, lat: 2 });
    const element = built[0].element;

    await agent.runCommand('set_layer_visibility', {
      name: 'pin',
      visible: false,
    });
    expect(element.style.display).toBe('none');

    await agent.runCommand('set_layer_visibility', { name: 'pin', visible: true });
    expect(element.style.display).toBe('');
  });
});

describe('default marker names', () => {
  it('never collide, even after removals', async () => {
    const map = new MockMap();
    const { namespace } = markerNamespace();
    const agent = tools(map, namespace);

    const first = (await agent.runCommand('add_marker', {
      lon: 0,
      lat: 0,
    })) as string;
    const second = (await agent.runCommand('add_marker', {
      lon: 1,
      lat: 1,
    })) as string;
    await agent.runCommand('remove_layer', {
      name: first.replace('Added marker ', '').replace('.', ''),
    });
    const third = (await agent.runCommand('add_marker', {
      lon: 2,
      lat: 2,
    })) as string;

    const listed = (await agent.runCommand('list_layers')) as Array<{
      id: string;
      type: string;
    }>;
    const markerIds = listed
      .filter((layer) => layer.type === 'marker')
      .map((layer) => layer.id);
    // second kept its name; the new marker must not have replaced it
    expect(markerIds).toHaveLength(2);
    expect(markerIds).toContain(second.replace('Added marker ', '').replace('.', ''));
    expect(markerIds).toContain(third.replace('Added marker ', '').replace('.', ''));
  });
});

describe('screenshot_map renders inside a frame', () => {
  it('captures the canvas in a render callback instead of a cleared buffer', async () => {
    const map = new MockMap();
    const { namespace } = markerNamespace();
    const agent = tools(map, namespace);

    const result = (await agent.runCommand('screenshot_map')) as {
      data_url: string;
      width: number;
      height: number;
    };
    // The mock fires once('render') immediately; the capture must come from
    // that callback, not a bare toDataURL on a cleared WebGL buffer.
    expect(map.once).toHaveBeenCalledWith('render', expect.any(Function));
    expect(result.data_url).toContain('data:image/png');
    expect(result).toMatchObject({ width: 100, height: 100 });
  });
});

describe('query_rendered_features layer resolution', () => {
  it('rejects unknown layer names instead of scanning the whole map', async () => {
    const map = new MockMap();
    const { namespace } = markerNamespace();
    const agent = tools(map, namespace);

    await expect(
      agent.runCommand('query_rendered_features', { layers: ['no-such-layer'] }),
    ).rejects.toThrow(/Layer not found: no-such-layer/);
    expect(map.queryRenderedFeatures).not.toHaveBeenCalled();
  });

  it('resolves overlay names to their style layers', async () => {
    const map = new MockMap();
    const { namespace } = markerNamespace();
    const agent = tools(map, namespace);
    await agent.runCommand('add_geojson_data', {
      name: 'pts',
      data: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [1, 2] },
            properties: {},
          },
        ],
      },
    });

    await agent.runCommand('query_rendered_features', { layers: ['pts'] });
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(1);
    const options = map.queryRenderedFeatures.mock.calls[0][1] as {
      layers?: string[];
    };
    expect(options.layers).toContain('pts-point');
  });
});

describe('paint parameter hardening', () => {
  it('falls back to defaults for non-numeric style values instead of NaN', async () => {
    const map = new MockMap();
    const { namespace } = markerNamespace();
    const agent = tools(map, namespace);
    const data = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
          },
          properties: {},
        },
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [[0, 0], [1, 1]],
          },
          properties: {},
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [1, 2] },
          properties: {},
        },
      ],
    };

    await agent.runCommand('add_geojson_data', {
      name: 'nan-style',
      data,
      style: { opacity: 'auto', 'line-width': 'thick' },
    });

    const fillLayer = map.getLayer('nan-style-fill') as {
      paint?: Record<string, unknown>;
    };
    expect(fillLayer?.paint?.['fill-opacity']).toBe(0.35);
    const lineLayer = map.getLayer('nan-style-line') as {
      paint?: Record<string, unknown>;
    };
    expect(lineLayer?.paint?.['line-width']).toBe(2);
    const pointLayer = map.getLayer('nan-style-point') as {
      paint?: Record<string, unknown>;
    };
    expect(pointLayer?.paint?.['circle-radius']).toBe(6);
  });

  it('rejects a non-finite zoom with the standard argument error', async () => {
    const map = new MockMap();
    const { namespace } = markerNamespace();
    const agent = tools(map, namespace);

    await expect(
      agent.runCommand('set_center', { lat: 0, lon: 0, zoom: 'high' }),
    ).rejects.toThrow(/Expected finite numeric argument: zoom/);
  });
});

describe('add_map_layer before_id validation', () => {
  it('rejects an unknown before_id with an actionable error', async () => {
    const map = new MockMap();
    const { namespace } = markerNamespace();
    const agent = tools(map, namespace);
    map.addSource('src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    await expect(
      agent.runCommand('add_map_layer', {
        layer: { id: 'new-layer', type: 'circle', source: 'src' },
        before_id: 'ghost',
      }),
    ).rejects.toThrow(/before_id not found: ghost/);
    expect(map.getLayer('new-layer')).toBeUndefined();
  });
});

describe('list_layers reflects marker visibility', () => {
  it('reports hidden markers as not visible', async () => {
    const map = new MockMap();
    const { built, namespace } = markerNamespace();
    const agent = tools(map, namespace);
    await agent.runCommand('add_marker', { name: 'pin', lon: 1, lat: 2 });
    await agent.runCommand('set_layer_visibility', { name: 'pin', visible: false });

    const listed = (await agent.runCommand('list_layers')) as Array<{
      id: string;
      type: string;
      visible: boolean;
    }>;
    const marker = listed.find((layer) => layer.type === 'marker');
    expect(marker?.visible).toBe(false);
    expect(built[0].element.style.display).toBe('none');
  });
});
