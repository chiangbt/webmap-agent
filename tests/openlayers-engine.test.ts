import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Map from 'ol/Map';
import View from 'ol/View';
import Feature from 'ol/Feature';
import Overlay from 'ol/Overlay';
import Point from 'ol/geom/Point';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import XYZ from 'ol/source/XYZ';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style';
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj';
import { OpenLayersAgentTools } from '../src/lib/core/tools/openlayers-tools';
import type { GeoAgentMapEngine } from '../src/lib/core/tools/geoagent-tools';
import {
  createOpenLayersMapShim,
  isOpenLayersMap,
  isOpenLayersMapShim,
} from '../src/lib/core/engines/openlayers-engine';

const openLayersNamespace = {
  Feature,
  Point,
  Overlay,
  VectorLayer,
  TileLayer,
  VectorSource,
  XYZ,
  GeoJSON,
  Style,
  Fill,
  Stroke,
  CircleStyle,
  Text,
  fromLonLat,
  toLonLat,
  transformExtent,
};

function openLayersEngine(): GeoAgentMapEngine {
  return {
    kind: 'openlayers',
    namespace: openLayersNamespace as unknown as Record<string, unknown>,
  };
}

function tools(map: unknown, mapEngine?: GeoAgentMapEngine): OpenLayersAgentTools {
  return new OpenLayersAgentTools(map as never, {
    allowCodeExecution: () => true,
    allowDestructiveTools: () => true,
    mapEngine: mapEngine ?? openLayersEngine(),
  });
}

function makeMap(container: HTMLElement): Map {
  return new Map({
    target: container,
    layers: [
      new TileLayer({
        source: new XYZ({
          url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        }),
      }),
    ],
    view: new View({
      center: fromLonLat([-98.5795, 39.8283]),
      zoom: 4,
    }),
  });
}

describe('openlayers structural helpers', () => {
  it('detects openlayers maps and shims', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const map = makeMap(container);
    try {
      expect(isOpenLayersMap(map)).toBe(true);
      expect(isOpenLayersMap({})).toBe(false);
      const shim = createOpenLayersMapShim(
        map as never,
        openLayersNamespace as unknown as Record<string, unknown>,
      );
      expect(isOpenLayersMapShim(shim)).toBe(true);
      expect(isOpenLayersMapShim(map)).toBe(false);
      expect(shim.getRawMap()).toBe(map);
    } finally {
      map.setTarget(undefined);
      container.remove();
    }
  });

  it('rejects a namespace with missing keys', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const map = makeMap(container);
    try {
      expect(() =>
        createOpenLayersMapShim(map as never, { Feature, Point } as never),
      ).toThrow(/Overlay/);
    } finally {
      map.setTarget(undefined);
      container.remove();
    }
  });
});

describe('OpenLayersAgentTools on a real OpenLayers map (jsdom)', () => {
  let container: HTMLDivElement;
  let map: Map;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    map = makeMap(container);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    map.setTarget(undefined);
    container.remove();
  });

  it('reports map state through the shim', async () => {
    const agent = tools(map);
    const state = (await agent.runCommand('get_map_state')) as {
      center: [number, number];
      zoom: number;
      projection: string;
      bounds: { west: number; south: number; east: number; north: number };
    };
    expect(state.center[0]).toBeCloseTo(-98.5795, 3);
    expect(state.center[1]).toBeCloseTo(39.8283, 3);
    expect(state.zoom).toBe(4);
    expect(state.projection).toBe('mercator');
    // zero-size jsdom viewport falls back to a 512px square in the shim
    expect(state.bounds.west).toBeLessThan(state.bounds.east);
    expect(state.bounds.south).toBeLessThan(state.bounds.north);
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
    // map center (pixel 256,256 of the shim's 512px jsdom fallback size)
    // is exactly where the point feature sits.
    await agent.runCommand('set_center', {
      lat: 39.8283,
      lon: -98.5795,
      zoom: 4,
    });
    const hit = (await agent.runCommand('query_rendered_features', {
      x: 256,
      y: 256,
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

  it('adds markers as ol overlays through the shim adapter', async () => {
    const agent = tools(map);
    const message = (await agent.runCommand('add_marker', {
      lat: 39,
      lon: -98,
      popup: 'hello',
      name: 'pin',
    })) as string;
    expect(message).toContain('Added marker pin');
    expect(map.getOverlays().getLength()).toBe(1);
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

  it('hands run_maplibre_script the raw ol map and the namespace', async () => {
    const agent = tools(map);
    const result = (await agent.runCommand('run_maplibre_script', {
      code: 'return { isOlMap: typeof map.getView === "function" && typeof map.addLayer === "function", hasNamespace: typeof ol.fromLonLat === "function", zoom: map.getView().getZoom() };',
    })) as { result: Record<string, unknown> };
    expect(result.result.isOlMap).toBe(true);
    expect(result.result.hasNamespace).toBe(true);
    expect(result.result.zoom).toBe(4);
  });

  it('does not expose the WebGL-only 3D tools on the OpenLayers engine', () => {
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

  it('describes run_maplibre_script with the OpenLayers API and the ol binding', () => {
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
    expect(scriptTool?.description).toMatch(/OpenLayers map/);
    expect(scriptTool?.description).toMatch(/not MapLibre/);
    expect(
      scriptTool?.toolSpec.inputSchema.properties.code.description,
    ).toMatch(/map, ol, and helpers/);
  });

  it('reports unsupported capabilities explicitly instead of failing silently', async () => {
    const agent = tools(map);
    await expect(
      agent.runCommand('set_projection', { projection: 'globe' }),
    ).rejects.toThrow(/mercator/);
    await expect(
      agent.runCommand('add_terrain', {
        url: 'https://example.com/{z}/{x}/{y}.png',
      }),
    ).rejects.toThrow(/Terrain/);
    await expect(agent.runCommand('screenshot_map')).rejects.toThrow(
      /screenshots are not supported/i,
    );
    await expect(
      agent.runCommand('set_sky', { sky: { 'sky-color': '#000' } }),
    ).rejects.toThrow(/Sky is not supported/);
  });
});

/* -------------------------------------------------------------------------- */
/* Defect regressions found in the library audit                              */
/* -------------------------------------------------------------------------- */

describe('openlayers engine defect regressions', () => {
  let container: HTMLDivElement;
  let map: Map;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    map = makeMap(container);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    map.setTarget(undefined);
    container.remove();
  });

  function shimWithPointLayer(spec: Record<string, unknown>) {
    const shim = createOpenLayersMapShim(
      map as never,
      openLayersNamespace as unknown as Record<string, unknown>,
    );
    shim.addSource('src', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-98.5795, 39.8283] },
            properties: { kind: 'city', pop: 1000 },
          },
        ],
      },
    });
    shim.addLayer({ id: 'layer-under-test', source: 'src', ...spec });
    return shim;
  }

  function styleForLayer(_shim: ReturnType<typeof createOpenLayersMapShim>): Style {
    // The registry layer's ol style function; calling it with a feature
    // reproduces exactly what the renderer draws.
    // The registry appends, so the layer under test is the last vector layer.
    const vectorLayers = map
      .getLayers()
      .getArray()
      .filter((layer): layer is VectorLayer => layer instanceof VectorLayer);
    const styleFn = vectorLayers.at(-1)!.getStyle() as (
      feature: Feature,
    ) => Style | undefined;
    const feature = new Feature(new Point(fromLonLat([-98.5795, 39.8283])));
    feature.set('kind', 'city');
    feature.set('pop', 1000);
    const style = styleFn(feature);
    expect(style).toBeTruthy();
    return style as Style;
  }

  it('throws on an unknown beforeId in addLayer and moveLayer', () => {
    const shim = createOpenLayersMapShim(
      map as never,
      openLayersNamespace as unknown as Record<string, unknown>,
    );
    shim.addSource('src', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    expect(() =>
      shim.addLayer({ id: 'l1', type: 'circle', source: 'src' }, 'ghost'),
    ).toThrow(/beforeId not found: ghost/);
    shim.addLayer({ id: 'l1', type: 'circle', source: 'src' });
    expect(() => shim.moveLayer('l1', 'ghost')).toThrow(/Layer not found: ghost/);
    // A known beforeId still works.
    shim.addLayer({ id: 'l2', type: 'circle', source: 'src' });
    expect(() => shim.moveLayer('l2', 'l1')).not.toThrow();
  });

  it('guards removeSource like MapLibre', () => {
    const shim = createOpenLayersMapShim(
      map as never,
      openLayersNamespace as unknown as Record<string, unknown>,
    );
    shim.addSource('src', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    expect(() => shim.removeSource('missing')).toThrow(/Source not found: missing/);
    shim.addLayer({ id: 'l1', type: 'circle', source: 'src' });
    expect(() => shim.removeSource('src')).toThrow(
      /Cannot remove source src; active layers depend on it: l1/,
    );
    shim.removeLayer('l1');
    expect(() => shim.removeSource('src')).not.toThrow();
  });

  it('draws no fill outline unless fill-outline-color is set', () => {
    const shim = shimWithPointLayer({ type: 'fill' });
    const style = styleForLayer(shim);
    // ol.Style.getStroke() is null when no stroke was configured.
    expect(style.getStroke()).toBeNull();
  });

  it('applies fill-opacity to the fill outline too', () => {
    const shim = shimWithPointLayer({
      type: 'fill',
      paint: { 'fill-color': '#ff0000', 'fill-outline-color': '#00ff00', 'fill-opacity': 0.25 },
    });
    const style = styleForLayer(shim);
    const stroke = style.getStroke();
    expect(stroke).toBeTruthy();
    // ol normalizes the color string with spaces; assert the blended opacity.
    expect(String(stroke?.getColor())).toMatch(/rgba\(0,\s*255,\s*0,\s*0\.25\)/);
    expect(String(style.getFill()?.getColor())).toMatch(
      /rgba\(255,\s*0,\s*0,\s*0\.25\)/,
    );
  });

  it('matches the shared default paint values (line width 1, circle radius 5)', () => {
    const shim = shimWithPointLayer({ type: 'line' });
    expect(styleForLayer(shim).getStroke()?.getWidth()).toBe(1);

    const circleShim = shimWithPointLayer({ type: 'circle' });
    const image = styleForLayer(circleShim).getImage() as CircleStyle;
    expect(image.getRadius()).toBe(5);
  });

  it('respects minzoom/maxzoom in queryRenderedFeatures', () => {
    const shim = createOpenLayersMapShim(
      map as never,
      openLayersNamespace as unknown as Record<string, unknown>,
    );
    shim.addSource('src', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-98.5795, 39.8283] },
            properties: {},
          },
        ],
      },
    });
    // The map zoom is 4: a minzoom 12 layer is not rendered and must not be
    // hit-tested, matching MapLibre and the Leaflet shim.
    shim.addLayer({ id: 'gated', type: 'circle', source: 'src', minzoom: 12 });
    const size = shim.getSize();
    expect(shim.queryRenderedFeatures([size[0] / 2, size[1] / 2])).toHaveLength(0);
    shim.removeLayer('gated');
    shim.addLayer({ id: 'open', type: 'circle', source: 'src' });
    expect(
      shim.queryRenderedFeatures([size[0] / 2, size[1] / 2]).length,
    ).toBeGreaterThan(0);
  });

  it('unbinds its moveend listener on destroy', () => {
    const unSpy = vi.spyOn(map, 'un');
    const shim = createOpenLayersMapShim(
      map as never,
      openLayersNamespace as unknown as Record<string, unknown>,
    );
    shim.destroy();
    expect(unSpy).toHaveBeenCalledWith('moveend', expect.any(Function));
    unSpy.mockRestore();
  });
});
