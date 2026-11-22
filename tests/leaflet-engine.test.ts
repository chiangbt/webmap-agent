import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import L from 'leaflet';
import { LeafletAgentTools } from '../src/lib/core/tools/leaflet-tools';
import type { GeoAgentMapEngine } from '../src/lib/core/tools/geoagent-tools';
import {
  computeClusteredFeatures,
  createLeafletMapShim,
  evaluateExpression,
  isLeafletMap,
  isLeafletMapShim,
  normalizeFeatureCollection,
  normalizeGeometryType,
  numberValueFrom,
  resolveBasemapStyle,
} from '../src/lib/core/engines/leaflet-engine';

function leafletEngine(): GeoAgentMapEngine {
  return { kind: 'leaflet', namespace: L as unknown as Record<string, unknown> };
}

function tools(map: unknown, mapEngine?: GeoAgentMapEngine): LeafletAgentTools {
  return new LeafletAgentTools(map as never, {
    allowCodeExecution: () => true,
    allowDestructiveTools: () => true,
    mapEngine: mapEngine ?? leafletEngine(),
  });
}

describe('leaflet pure helpers', () => {
  it('normalizes geometry types like MapLibre ["geometry-type"]', () => {
    expect(normalizeGeometryType('MultiPolygon')).toBe('Polygon');
    expect(normalizeGeometryType('MultiLineString')).toBe('LineString');
    expect(normalizeGeometryType('MultiPoint')).toBe('Point');
    expect(normalizeGeometryType('Point')).toBe('Point');
    expect(normalizeGeometryType('Polygon')).toBe('Polygon');
  });

  it('normalizes loose GeoJSON input into a FeatureCollection', () => {
    const fc = normalizeFeatureCollection({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 2] },
      properties: { a: 1 },
    });
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(1);
    const bare = normalizeFeatureCollection({
      type: 'Point',
      coordinates: [3, 4],
    });
    expect(bare.features[0]?.geometry?.type).toBe('Point');
  });

  it('evaluates the MapLibre expression subset used by the tools', () => {
    const context = {
      properties: { pop: 42, kind: 'city' },
      geometryType: 'Point',
      zoom: 5,
    };
    expect(evaluateExpression(['get', 'pop'], context)).toBe(42);
    expect(evaluateExpression(['geometry-type'], context)).toBe('Point');
    expect(evaluateExpression(['zoom'], context)).toBe(5);
    expect(
      evaluateExpression(['==', ['get', 'kind'], 'city'], context),
    ).toBe(true);
    expect(
      evaluateExpression(
        ['step', ['get', 'pop'], '#aaa', 10, '#bbb', 100, '#ccc'],
        context,
      ),
    ).toBe('#bbb');
    expect(
      evaluateExpression(
        ['match', ['get', 'kind'], ['city', 'town'], '#111', '#222'],
        context,
      ),
    ).toBe('#111');
    expect(evaluateExpression(['has', 'pop'], context)).toBe(true);
    expect(evaluateExpression(['literal', [1, 2]], context)).toEqual([1, 2]);
    expect(
      evaluateExpression(['coalesce', ['get', 'missing'], 'fallback'], context),
    ).toBe('fallback');
    // legacy filters: string first operand selects the property directly
    expect(evaluateExpression(['==', 'kind', 'city'], context)).toBe(true);
    expect(evaluateExpression(['!=', 'kind', 'city'], context)).toBe(false);
    expect(evaluateExpression(['!has', 'missing'], context)).toBe(true);
    // legacy "in": property membership against literal list
    expect(evaluateExpression(['in', 'kind', 'city', 'town'], context)).toBe(true);
    expect(evaluateExpression(['in', 'kind', 'village'], context)).toBe(false);
    expect(evaluateExpression(['!in', 'kind', 'village'], context)).toBe(true);
    // modern "in" expression（第一操作数为表达式取值）不受 legacy 分支影响
    expect(evaluateExpression(['in', ['get', 'kind'], ['literal', ['city', 'town']]], context)).toBe(true);
    expect(evaluateExpression(['in', ['get', 'kind'], ['literal', ['village']]], context)).toBe(false);
    // non-expressions pass through
    expect(evaluateExpression('#ff0000', context)).toBe('#ff0000');
  });

  it('clusters points greedily and stamps point_count', () => {
    const features = [0, 1, 2, 3, 4].map((i) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [i * 0.001, i * 0.001],
      },
      properties: { id: i },
    }));
    const clustered = computeClusteredFeatures(features, 500, () => ({
      x: 0,
      y: 0,
    }));
    expect(clustered).toHaveLength(1);
    expect(clustered[0]?.properties?.point_count).toBe(5);
    expect(clustered[0]?.properties?.point_count_abbreviated).toBe('5');
    const far = computeClusteredFeatures(
      [
        {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [0, 0] },
          properties: {},
        },
        {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [90, -80] },
          properties: {},
        },
      ],
      20,
      (lat, lng) => ({ x: lng * 100, y: lat * 100 }),
    );
    expect(far).toHaveLength(2);
  });

  it('resolves basemap aliases to raster tile URLs', () => {
    const dark = resolveBasemapStyle('dark');
    expect(dark.url).toMatch(/cartocdn/);
    const liberty = resolveBasemapStyle('liberty');
    expect(liberty.url).toMatch(/\{z\}/);
    const direct = resolveBasemapStyle(
      'https://example.com/tiles/{z}/{x}/{y}.png',
    );
    expect(direct.url).toBe('https://example.com/tiles/{z}/{x}/{y}.png');
  });

  it('detects leaflet maps and shims', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const map = L.map(container, { center: [0, 0], zoom: 1 });
    try {
      expect(isLeafletMap(map)).toBe(true);
      expect(isLeafletMap({})).toBe(false);
      expect(isLeafletMap(map)).toBe(true);
      const shim = createLeafletMapShim(map as never, L as never);
      expect(isLeafletMapShim(shim)).toBe(true);
      expect(isLeafletMapShim(map)).toBe(false);
    } finally {
      map.remove();
      container.remove();
    }
  });
});

describe('LeafletAgentTools on a real Leaflet map (jsdom)', () => {
  let container: HTMLDivElement;
  let map: L.Map;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    map = L.map(container, {
      center: [39.8283, -98.5795],
      zoom: 4,
      zoomControl: false,
      attributionControl: false,
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    map.remove();
    container.remove();
  });

  it('uses flyTo for set_center so Leaflet centers transition smoothly', async () => {
    const agent = tools(map);
    // spy 并短路真实动画；断言 set_center 落在 flyTo（平滑）而非 setView（跳转）。
    const flyToSpy = vi.spyOn(map, 'flyTo').mockImplementation(() => map);
    await agent.runCommand('set_center', { lat: 41, lon: -100, zoom: 5 });
    expect(flyToSpy).toHaveBeenCalledTimes(1);
    // shim 把 MapLibre 顺序的 [lng, lat] 转成 Leaflet 的 [lat, lng]。
    expect(flyToSpy.mock.calls[0][0]).toEqual([41, -100]);
    expect(flyToSpy.mock.calls[0][1]).toBe(5);
    agent.destroy();
  });

  it('snaps the center to the flyTo target when the animation is interrupted', async () => {
    const shim = createLeafletMapShim(map as never, L as never);
    // 让动画立即结束但停在中途（模拟用户拖拽打断 flyTo）。
    const flyToSpy = vi
      .spyOn(map, 'flyTo')
      .mockImplementation(((_target: [number, number], _zoom?: number) => {
        map.setView([40, -99], { animate: false });
        map.fire('moveend');
        return map;
      }) as never);
    shim.flyTo({ center: [-100, 41], zoom: 5 });
    expect(flyToSpy).toHaveBeenCalledTimes(1);
    // moveend 校正：中心被无动画地拉回到目标点，视图中心精确等于 flyTo 目标。
    const center = map.getCenter();
    expect(center.lat).toBeCloseTo(41, 9);
    expect(center.lng).toBeCloseTo(-100, 9);
    expect(map.getZoom()).toBe(5);
  });

  it('reports map state through the shim', async () => {
    const agent = tools(map);
    const state = (await agent.runCommand('get_map_state')) as {
      center: [number, number];
      zoom: number;
      projection: string;
    };
    expect(state.center[0]).toBeCloseTo(-98.5795, 3);
    expect(state.center[1]).toBeCloseTo(39.8283, 3);
    expect(state.zoom).toBe(4);
    expect(state.projection).toBe('mercator');
  });

  it('adds raster basemaps and switches named styles', async () => {
    const agent = tools(map);
    const message = (await agent.runCommand('add_basemap', {
      provider: 'google_satellite',
    })) as string;
    expect(message).toContain('Added basemap');
    const listed = (await agent.runCommand('list_layers')) as Array<{
      id: string;
      user_added: boolean;
    }>;
    expect(listed.some((layer) => layer.user_added)).toBe(true);

    await agent.runCommand('change_basemap', { style: 'dark' });
    await vi.runAllTimersAsync();
    const after = (await agent.runCommand('list_layers')) as Array<{
      id: string;
      user_added: boolean;
    }>;
    // the basemap overlay survived the style swap
    expect(after.some((layer) => layer.user_added)).toBe(true);
  });

  it('adds GeoJSON data as fill/line/point layers and queries features', async () => {
    const agent = tools(map);
    const data = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-99.5, 39.0],
                [-97.5, 39.0],
                [-97.5, 40.5],
                [-99.5, 40.5],
                [-99.5, 39.0],
              ],
            ],
          },
          properties: { name: 'box' },
        },
        {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [-98.5795, 39.8283],
          },
          properties: { name: 'center-dot' },
        },
      ],
    };
    await agent.runCommand('add_geojson_data', { data, name: 'demo' });
    const listed = (await agent.runCommand('list_layers')) as Array<{
      id: string;
      type: string;
    }>;
    const ids = listed.map((layer) => layer.id);
    expect(ids.some((id) => id.endsWith('-fill'))).toBe(true);
    expect(ids.some((id) => id.endsWith('-point'))).toBe(true);

    // add_geojson_data zooms to the data bounds; put the view back so the
    // map center (container point 0,0 in jsdom's zero-size viewport) is
    // exactly where the point feature sits.
    await agent.runCommand('set_center', {
      lat: 39.8283,
      lon: -98.5795,
      zoom: 4,
    });
    const hit = (await agent.runCommand('query_rendered_features', {
      x: 0,
      y: 0,
    })) as Array<{ properties: Record<string, unknown> }>;
    const names = hit.map((f) => f.properties?.name);
    expect(names).toContain('center-dot');
    expect(names).toContain('box');
  });

  it('toggles layer visibility through the registry', async () => {
    const agent = tools(map);
    await agent.runCommand('add_geojson_data', {
      data: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: {},
          },
        ],
      },
      name: 'vis',
    });
    await agent.runCommand('set_layer_visibility', {
      name: 'vis',
      visible: false,
    });
    const listed = (await agent.runCommand('list_layers')) as Array<{
      id: string;
      visible: boolean;
    }>;
    const hidden = listed.filter((layer) => layer.id.startsWith('vis'));
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((layer) => !layer.visible)).toBe(true);
  });

  it('adds markers through the shim marker adapter', async () => {
    const agent = tools(map);
    const message = (await agent.runCommand('add_marker', {
      lat: 39,
      lon: -98,
      popup: 'hello',
      name: 'pin',
    })) as string;
    expect(message).toContain('Added marker pin');
    let markerCount = 0;
    map.eachLayer((layer) => {
      if (layer instanceof L.Marker) {
        markerCount += 1;
      }
    });
    expect(markerCount).toBe(1);
  });

  it('removes named overlays', async () => {
    const agent = tools(map);
    await agent.runCommand('add_geojson_data', {
      data: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [10, 10] },
            properties: {},
          },
        ],
      },
      name: 'temp',
    });
    await agent.runCommand('remove_layer', { name: 'temp' });
    const state = (await agent.runCommand('get_map_state')) as {
      user_layers: string[];
    };
    expect(state.user_layers).not.toContain('temp');
  });

  it('hands run_maplibre_script the raw Leaflet map and the L namespace', async () => {
    const agent = tools(map);
    const result = (await agent.runCommand('run_maplibre_script', {
      code: 'return { isLeaflet: typeof map.eachLayer === "function", hasNamespace: typeof L.map === "function", center: map.getCenter().lat };',
    })) as { result: Record<string, unknown> };
    expect(result.result.isLeaflet).toBe(true);
    expect(result.result.hasNamespace).toBe(true);
    expect(result.result.center).toBeCloseTo(39.8283, 3);
  });

  it('does not expose the WebGL-only 3D tools on the Leaflet engine', () => {
    const agent = tools(map);
    const toolNames = (agent.createTools() as Array<{ name: string }>).map(
      (item) => item.name,
    );
    for (const hidden of [
      'set_projection',
      'add_terrain',
      'clear_terrain',
      'set_sky',
      'remove_sky',
      'add_3d_buildings',
      'screenshot_map',
    ]) {
      expect(toolNames).not.toContain(hidden);
    }
    // The 2D-capable surface stays available.
    expect(toolNames).toContain('add_geojson_data');
    expect(toolNames).toContain('add_basemap');
    expect(toolNames).toContain('run_maplibre_script');
  });

  it('describes run_maplibre_script with the Leaflet API and the L binding', () => {
    const agent = tools(map);
    const scriptTool = (
      agent.createTools() as Array<{
        name: string;
        description: string;
        toolSpec: {
          inputSchema: {
            properties: Record<string, { description?: string }>;
          };
        };
      }>
    ).find((item) => item.name === 'run_maplibre_script');
    expect(scriptTool?.description).toMatch(/Leaflet map/);
    expect(scriptTool?.description).toMatch(/not MapLibre/);
    expect(
      scriptTool?.toolSpec.inputSchema.properties.code.description,
    ).toMatch(/map, L, and helpers/);
  });

  it('reports unsupported capabilities explicitly instead of failing silently', async () => {
    const agent = tools(map);
    await expect(
      agent.runCommand('set_projection', { projection: 'globe' }),
    ).rejects.toThrow(/not supported/);
    await expect(
      agent.runCommand('add_terrain', { url: 'https://example.com/{z}/{x}/{y}.png' }),
    ).rejects.toThrow(/Terrain/);
    await expect(agent.runCommand('screenshot_map')).rejects.toThrow();
    await expect(
      agent.runCommand('set_sky', { sky: { 'sky-color': '#000' } }),
    ).rejects.toThrow(/Sky is not supported/);
  });
});

/* -------------------------------------------------------------------------- */
/* Defect regressions found in the library audit                              */
/* -------------------------------------------------------------------------- */

describe('leaflet engine defect regressions', () => {
  let container: HTMLDivElement;
  let map: L.Map;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    map = L.map(container, {
      center: [39.8283, -98.5795],
      zoom: 4,
      zoomControl: false,
      attributionControl: false,
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    map.remove();
    container.remove();
  });

  it('detects the host basemap via getTileUrl and replaces it on setStyle', () => {
    // Leaflet TileLayers expose getTileUrl; no Leaflet class has getURL, so
    // the old probe never matched and change_basemap rendered underneath the
    // host's tiles with no visible change.
    const hostBasemap = L.tileLayer('https://example.com/host/{z}/{x}/{y}.png');
    hostBasemap.addTo(map);
    const shim = createLeafletMapShim(map as never, L as never);

    shim.setStyle('dark');
    expect(map.hasLayer(hostBasemap)).toBe(false);
    // Exactly one agent basemap lives in the dedicated base pane.
    const baseLayerCount = () => {
      let count = 0;
      map.eachLayer((layer) => {
        if (
          (layer as unknown as { options?: { pane?: string } }).options?.pane ===
          'geoagent-base'
        ) {
          count += 1;
        }
      });
      return count;
    };
    expect(baseLayerCount()).toBe(1);
    shim.setStyle('positron');
    expect(baseLayerCount()).toBe(1);
  });

  it('escapes marker popup text before Leaflet renders it as HTML', () => {
    // Leaflet's Popup.setContent treats a plain string as HTML; the popup text
    // comes from model tool calls influenced by ingested map data, so it must
    // be escaped before reaching innerHTML.
    const shim = createLeafletMapShim(map as never, L as never);
    const popup = shim.createPopup();
    popup.setText('<img src=x onerror=alert(1)>');
    const content = (popup.leafletPopup as unknown as { _content?: string })
      ._content;
    expect(content).toContain('&lt;img');
    expect(content).not.toContain('<img');
  });

  it('unbinds its zoomend listener on destroy', () => {
    const shim = createLeafletMapShim(map as never, L as never);
    expect(map.listens('zoomend')).toBe(true);
    shim.destroy();
    expect(map.listens('zoomend')).toBe(false);
  });

  it('emulates the idle event via whenReady for an unloaded map', async () => {
    const bareContainer = document.createElement('div');
    document.body.appendChild(bareContainer);
    // A map without a view is not "loaded"; Leaflet has no idle event, so the
    // shim must route once('idle') through whenReady instead of stalling.
    const bareMap = L.map(bareContainer);
    try {
      const shim = createLeafletMapShim(bareMap as never, L as never);
      expect(shim.loaded()).toBe(false);
      let fired = 0;
      shim.once('idle', () => {
        fired += 1;
      });
      bareMap.setView([0, 0], 2);
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(fired).toBe(1);
    } finally {
      bareMap.remove();
      bareContainer.remove();
    }
  });

  it('throws on an unknown beforeId instead of silently appending', () => {
    const shim = createLeafletMapShim(map as never, L as never);
    shim.addSource('src', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    expect(() =>
      shim.addLayer(
        { id: 'missing-before', type: 'circle', source: 'src' },
        'no-such-layer',
      ),
    ).toThrow(/beforeId not found: no-such-layer/);
  });

  it('treats maxzoom as exclusive, matching MapLibre', () => {
    const shim = createLeafletMapShim(map as never, L as never);
    shim.addSource('src', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-98.5795, 39.8283] },
            properties: { id: 1 },
          },
        ],
      },
    });
    // Map zoom is 4 here; a maxzoom 4 layer must be hidden at zoom 4.
    // (Leaflet keeps layer-group children in its layer registry too, so count
    // the materialized L.GeoJSON groups, not raw map layers.)
    const geoLayersOnMap = () => {
      let count = 0;
      map.eachLayer((layer) => {
        if (layer instanceof L.GeoJSON) {
          count += 1;
        }
      });
      return count;
    };
    shim.addLayer({ id: 'gated', type: 'circle', source: 'src', maxzoom: 4 });
    expect(geoLayersOnMap()).toBe(0);
    // Dropping below maxzoom materializes it.
    map.setZoom(3, { animate: false });
    expect(geoLayersOnMap()).toBe(1);
  });

  it('answers query_source_features with clustered features', () => {
    const shim = createLeafletMapShim(map as never, L as never);
    const points = [0, 1].map((i) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [-98.5795 + i * 0.001, 39.8283],
      },
      properties: { id: i },
    }));
    shim.addSource('clustered', {
      type: 'geojson',
      cluster: true,
      clusterRadius: 500,
      data: { type: 'FeatureCollection', features: points },
    });
    shim.addLayer({ id: 'clusters', type: 'circle', source: 'clustered' });
    const features = shim.querySourceFeatures('clustered', {
      filter: ['has', 'point_count'],
    });
    expect(features).toHaveLength(1);
    expect(features[0]?.properties?.point_count).toBe(2);
  });

  it('falls back on expressions that resolve to null instead of coercing 0', () => {
    const context = {
      properties: { kind: 'town' },
      geometryType: 'Point',
      zoom: 4,
    };
    // A match without a default clause resolves to null.
    expect(
      numberValueFrom(['match', ['get', 'kind'], ['city'], 3], context, 5),
    ).toBe(5);
    expect(
      numberValueFrom(['match', ['get', 'kind'], ['city'], 3], {
        ...context,
        properties: { kind: 'city' },
      }, 5),
    ).toBe(3);
  });
});
