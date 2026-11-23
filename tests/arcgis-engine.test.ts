import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcGISTools } from '../src/lib/core/tools/arcgis-tools';
import type { GeoAgentMapEngine } from '../src/lib/core/tools/maplibre-tools';
import {
  resolveMapContainer,
} from '../src/lib/core/map-container';
import {
  createArcGISMapShim,
  isArcGISComponent,
  isArcGISMapShim,
  isArcGISView,
  resolveArcGISView,
  waitForArcGISComponent,
  type ArcGISViewLike,
} from '../src/lib/core/engines/arcgis-engine';
import { createGeoAgentTools } from '../src/lib/core/tools/tools-factory';

/* -------------------------------------------------------------------------- */
/* Fake ArcGIS Maps SDK surface (the real SDK is not a test dependency)       */
/* -------------------------------------------------------------------------- */

const MERCATOR_RADIUS = 6378137;
const mercX = (lon: number): number => ((lon * Math.PI) / 180) * MERCATOR_RADIUS;
const mercY = (lat: number): number =>
  MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

class FakeGraphic {
  geometry: unknown;
  attributes: Record<string, unknown>;
  symbol: unknown;
  constructor(options: Record<string, unknown>) {
    this.geometry = options.geometry;
    this.attributes = (options.attributes as Record<string, unknown>) ?? {};
    this.symbol = options.symbol;
  }
}

class FakeLayer {
  visible: boolean;
  opacity: number;
  title: string;
  constructor(options: Record<string, unknown> = {}) {
    this.visible = true;
    this.opacity = (options.opacity as number) ?? 1;
    this.title = (options.title as string) ?? '';
  }
}

class FakeWebTileLayer extends FakeLayer {
  urlTemplate: string;
  constructor(options: Record<string, unknown>) {
    super(options);
    this.urlTemplate = (options.urlTemplate as string) ?? '';
  }
}

class FakeFeatureLayer extends FakeLayer {
  source: FakeGraphic[];
  objectIdField: string;
  fields: Array<{ name: string; type: string }>;
  geometryType: string;
  spatialReference: unknown;
  renderer: unknown;
  constructor(options: Record<string, unknown>) {
    super(options);
    this.source = (options.source as FakeGraphic[]) ?? [];
    this.objectIdField = (options.objectIdField as string) ?? '';
    this.fields = (options.fields as Array<{ name: string; type: string }>) ?? [];
    this.geometryType = (options.geometryType as string) ?? '';
    this.spatialReference = options.spatialReference;
    this.renderer = options.renderer;
  }
}

function symbolClasses() {
  return {
    SimpleFillSymbol: class {
      options: Record<string, unknown>;
      constructor(options: Record<string, unknown>) {
        this.options = options;
      }
    },
    SimpleLineSymbol: class {
      options: Record<string, unknown>;
      constructor(options: Record<string, unknown>) {
        this.options = options;
      }
    },
    SimpleMarkerSymbol: class {
      options: Record<string, unknown>;
      constructor(options: Record<string, unknown>) {
        this.options = options;
      }
    },
    TextSymbol: class {
      options: Record<string, unknown>;
      constructor(options: Record<string, unknown>) {
        this.options = options;
      }
    },
    PictureMarkerSymbol: class {
      options: Record<string, unknown>;
      constructor(options: Record<string, unknown>) {
        this.options = options;
      }
    },
  };
}

const arcgisNamespace = {
  WebTileLayer: FakeWebTileLayer,
  FeatureLayer: FakeFeatureLayer,
  Graphic: FakeGraphic,
  ...symbolClasses(),
} as unknown as Record<string, unknown>;

function arcgisEngine(): GeoAgentMapEngine {
  return {
    kind: 'arcgis',
    namespace: arcgisNamespace,
  } as GeoAgentMapEngine;
}

class FakeLayerCollection {
  items: FakeLayer[] = [];
  add(layer: FakeLayer, index?: number): void {
    if (index === undefined || index >= this.items.length) {
      this.items.push(layer);
    } else {
      this.items.splice(index, 0, layer);
    }
  }
  remove(layer: FakeLayer): void {
    this.items = this.items.filter((item) => item !== layer);
  }
}

class FakeView implements ArcGISViewLike {
  container: HTMLElement;
  ready = true;
  spatialReference = { isWebMercator: true, wkid: 102100 };
  center: { longitude: number; latitude: number } = { longitude: -95, latitude: 40 };
  zoom = 4;
  rotation = 0;
  extent = {
    xmin: mercX(-100),
    ymin: mercY(30),
    xmax: mercX(-90),
    ymax: mercY(50),
    spatialReference: { wkid: 102100 },
  };
  size = { width: 400, height: 400 };
  map = { layers: new FakeLayerCollection(), basemap: null as string | null };
  goToTargets: Array<Record<string, unknown>> = [];
  watchHandles: Array<{ property: string; listener: () => void }> = [];
  eventHandles: Array<{ type: string; listener: () => void }> = [];
  readonly takeScreenshot = vi.fn(async () => ({
    dataUrl: 'data:image/png;base64,shot',
    data: { width: 480, height: 320 },
  }));

  constructor() {
    this.container = document.createElement('div');
    this.container.style.width = '400px';
    this.container.style.height = '400px';
    document.body.appendChild(this.container);
  }

  goTo(target: Record<string, unknown>): Promise<void> {
    this.goToTargets.push(target);
    return Promise.resolve();
  }

  when(callback?: () => void): Promise<void> {
    callback?.();
    return Promise.resolve();
  }

  on(type: string, listener: (event?: unknown) => void) {
    const handle = { type, listener, remove: () => {} };
    this.eventHandles.push(handle as never);
    return {
      remove: () => {
        this.eventHandles = this.eventHandles.filter((item) => item !== handle);
      },
    };
  }

  watch(
    property: string,
    listener: (newValue?: unknown, oldValue?: unknown) => void,
  ) {
    const handle = { property, listener, remove: () => {} };
    this.watchHandles.push(handle as never);
    return {
      remove: () => {
        this.watchHandles = this.watchHandles.filter((item) => item !== handle);
      },
    };
  }

  /** Test helper: fire a watched property change like the real SDK would. */
  emitWatch(property: string): void {
    for (const handle of this.watchHandles.filter((item) => item.property === property)) {
      handle.listener();
    }
  }

  cleanup(): void {
    this.container.remove();
  }
}

function tools(map: unknown, mapEngine?: GeoAgentMapEngine): ArcGISTools {
  return new ArcGISTools(map as never, {
    allowCodeExecution: () => true,
    allowDestructiveTools: () => true,
    mapEngine: mapEngine ?? arcgisEngine(),
  });
}

afterEach(() => {
  document.querySelectorAll('.geoagent-arcgis-marker-icon').forEach((el) => el.remove());
});

describe('arcgis structural helpers', () => {
  it('validates the required esri namespace classes', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const view = new FakeView();
    view.container = container;
    try {
      expect(() => createArcGISMapShim(view, { Graphic: FakeGraphic })).toThrow(
        /missing WebTileLayer/,
      );
      const shim = createArcGISMapShim(view, arcgisNamespace);
      expect(isArcGISMapShim(shim)).toBe(true);
      expect(isArcGISMapShim(view)).toBe(false);
    } finally {
      container.remove();
    }
  });

  it('duck-types views, components, and resolves the view behind them', () => {
    const view = new FakeView();
    expect(isArcGISView(view)).toBe(true);
    expect(isArcGISView({})).toBe(false);
    expect(isArcGISComponent({ view, when: () => undefined })).toBe(true);
    expect(isArcGISComponent({ when: () => undefined })).toBe(false);
    expect(resolveArcGISView(view)).toBe(view);
    expect(resolveArcGISView({ view, when: () => undefined })).toBe(view);
    expect(() => resolveArcGISView({ when: () => undefined })).toThrow(
      /view is not ready|must pass an ArcGIS Maps SDK MapView/,
    );
  });

  it('rejects non-Mercator/WGS84 views with an actionable error', () => {
    const view = new FakeView();
    view.spatialReference = { wkid: 2277 };
    expect(() => createArcGISMapShim(view, arcgisNamespace)).toThrow(
      /spatial reference 2277/,
    );
  });
});

describe('ArcGISTools on a fake ArcGIS view', () => {
  let view: FakeView;

  beforeEach(() => {
    view = new FakeView();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    view.cleanup();
  });

  it('reports map state, bounds, and mercator projection', async () => {
    const agent = tools(view);
    const state = (await agent.runCommand('get_map_state')) as {
      center: [number, number];
      zoom: number;
      projection: string;
      bearing: number;
      bounds: { west: number; south: number; east: number; north: number };
    };
    expect(state.center[0]).toBeCloseTo(-95, 3);
    expect(state.center[1]).toBeCloseTo(40, 3);
    expect(state.zoom).toBe(4);
    expect(state.projection).toBe('mercator');
    expect(state.bearing).toBe(0);
    expect(state.bounds.west).toBeCloseTo(-100, 2);
    expect(state.bounds.east).toBeCloseTo(-90, 2);
    expect(state.bounds.south).toBeCloseTo(30, 2);
    expect(state.bounds.north).toBeCloseTo(50, 2);
  });

  it('moves the camera: jumpTo writes, flyTo goes through goTo', async () => {
    const agent = tools(view);
    await agent.runCommand('set_center', { lat: 35, lon: -92, zoom: 6 });
    expect(view.center).toEqual({ longitude: -92, latitude: 35 });
    expect(view.zoom).toBe(6);

    await agent.runCommand('fly_to', { lat: 37, lon: -91, zoom: 8 });
    expect(view.goToTargets.at(-1)).toMatchObject({
      center: [-91, 37],
      zoom: 8,
    });

    await agent.runCommand('zoom_to_bounds', {
      west: -100,
      south: 30,
      east: -90,
      north: 50,
    });
    expect(view.goToTargets.at(-1)).toMatchObject({
      type: 'extent', xmin: -100, ymin: 30, xmax: -90, ymax: 50,
    });
  });

  it('waits for ArcGIS camera completion before reading the view and reports rejected navigation', async () => {
    const agent = tools(view);
    let finish!: () => void;
    const goTo = vi.spyOn(view, 'goTo').mockImplementationOnce(() => new Promise<void>((resolve) => {
      finish = () => {
        view.center = { longitude: -91, latitude: 37 };
        resolve();
      };
    }));
    const movement = agent.runCommand('fly_to', { lat: 37, lon: -91, zoom: 8 });
    const state = agent.runCommand('get_map_state');
    await vi.waitFor(() => expect(goTo).toHaveBeenCalledTimes(1));
    finish();
    await expect(movement).resolves.toBe('Moved map.');
    await expect(state).resolves.toMatchObject({ center: [-91, 37] });
    goTo.mockRejectedValueOnce(new Error('Navigation interrupted'));
    await expect(agent.runCommand('fly_to', { lat: 38, lon: -90 })).rejects.toThrow('Navigation interrupted');
  });

  it('stops an ArcGIS animation on cancellation and lets a new command run', async () => {
    const agent = tools(view);
    const stop = vi.fn();
    Object.assign(view, { animation: { stop } });
    const goTo = vi.spyOn(view, 'goTo').mockImplementationOnce(() => new Promise<void>(() => {}));
    const movement = agent.runCommand('fly_to', { lat: 37, lon: -91, zoom: 8 });
    const cancelled = expect(movement).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(goTo).toHaveBeenCalledTimes(1));
    agent.cancelPendingCommands();
    await cancelled;
    expect(stop).toHaveBeenCalledOnce();
    await expect(agent.runCommand('get_map_state')).resolves.toMatchObject({ center: [-95, 40] });
  });

  it('adds GeoJSON as a client-side FeatureLayer with per-feature symbols', async () => {
    const agent = tools(view);
    await agent.runCommand('add_geojson_data', {
      name: 'cities',
      data: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-95, 40] },
            properties: { name: 'Omaha', pop: 480000 },
          },
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-96, 41] },
            properties: { name: 'Des Moines', pop: 210000 },
          },
        ],
      },
      style: { 'circle-color': '#ff0000', 'circle-radius': 8 },
    });

    const esriLayers = view.map.layers.items as FakeFeatureLayer[];
    expect(esriLayers).toHaveLength(1);
    const layer = esriLayers[0];
    expect(layer).toBeInstanceOf(FakeFeatureLayer);
    expect(layer.geometryType).toBe('point');
    expect(layer.source).toHaveLength(2);
    expect(layer.fields.map((field) => field.name)).toContain('name');
    const graphic = layer.source[0];
    expect((graphic.geometry as { longitude: number }).longitude).toBe(-95);
    // The color expression lands as the per-feature symbol (opacity 1 keeps
    // the plain hex; a <1 fill-opacity would blend it to rgba).
    expect((graphic.symbol as { options: { color: string } }).options.color).toBe(
      '#ff0000',
    );

    const listed = (await agent.runCommand('list_layers')) as Array<{
      id: string;
      user_added: boolean;
    }>;
    expect(listed.some((entry) => entry.id.startsWith('cities-'))).toBe(true);
  });

  it('queries rendered features through the extent pixel projector', async () => {
    const agent = tools(view);
    await agent.runCommand('add_geojson_data', {
      name: 'pin',
      data: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-95, 40] },
            properties: { id: 1 },
          },
        ],
      },
    });
    // Longitude is linear in Web Mercator; latitude is not, so the pixel for
    // (-95, 40) is x=200 but y follows the mercator ratio (≈214.6 at this
    // extent), not the naive center.
    const expectedY = Math.round(
      ((mercY(50) - mercY(40)) / (mercY(50) - mercY(30))) * 400,
    );
    const hits = (await agent.runCommand('query_rendered_features', {
      x: 200,
      y: expectedY,
    })) as Array<{ properties: { id: number } }>;
    expect(hits).toHaveLength(1);
    expect(hits[0].properties.id).toBe(1);
    const misses = (await agent.runCommand('query_rendered_features', {
      x: 1,
      y: 1,
    })) as unknown[];
    expect(misses).toHaveLength(0);
  });

  it('adds raster basemaps as WebTileLayers and swaps ArcGIS basemaps', async () => {
    const agent = tools(view);
    const message = (await agent.runCommand('add_basemap', {
      provider: 'google_satellite',
    })) as string;
    expect(message).toContain('Added basemap');
    const tileLayers = (view.map.layers.items as FakeWebTileLayer[]).filter(
      (layer) => layer instanceof FakeWebTileLayer,
    );
    expect(tileLayers).toHaveLength(1);
    expect(tileLayers[0].urlTemplate).toContain('google.com');

    await agent.runCommand('change_basemap', { style: 'dark' });
    await vi.runAllTimersAsync();
    expect(view.map.basemap).toBe('dark-gray');
  });

  it('re-styles and removes layers like the other engines', async () => {
    const agent = tools(view);
    await agent.runCommand('add_geojson_data', {
      name: 'boxes',
      data: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
            },
            properties: { id: 1 },
          },
        ],
      },
    });

    await agent.runCommand('set_paint_property', {
      layer_id: 'boxes-fill',
      property: 'fill-color',
      value: '#00ff00',
    });
    const refreshed = (view.map.layers.items as FakeFeatureLayer[]).find(
      (layer) => layer instanceof FakeFeatureLayer,
    );
    expect(
      (refreshed?.source[0].symbol as { options: { color: string } }).options.color,
    ).toMatch(/0,\s*255,\s*0/);

    await agent.runCommand('set_layer_visibility', {
      name: 'boxes',
      visible: false,
    });
    expect(refreshed?.visible).toBe(false);

    await agent.runCommand('remove_layer', { name: 'boxes' });
    expect(view.map.layers.items).toHaveLength(0);
  });

  it('hides layers outside their zoom range on zoom changes', async () => {
    const agent = tools(view);
    await agent.runCommand('add_map_source', {
      source_id: 'src',
      source: {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [-95, 40] },
              properties: {},
            },
          ],
        },
      },
    });
    await agent.runCommand('add_map_layer', {
      layer: { id: 'gated', type: 'circle', source: 'src', minzoom: 12 },
    });
    const layer = (view.map.layers.items as FakeFeatureLayer[])[0];
    // zoom 4 < minzoom 12 → hidden
    expect(layer.visible).toBe(false);
    view.zoom = 13;
    view.emitWatch('zoom');
    expect(layer.visible).toBe(true);
    view.zoom = 4;
    view.emitWatch('zoom');
    expect(layer.visible).toBe(false);
  });

  it('adds markers as DOM overlays with working visibility and removal', async () => {
    const agent = tools(view);
    await agent.runCommand('add_marker', {
      name: 'pin',
      lon: -95,
      lat: 40,
      popup: 'Hello',
    });
    let element = view.container.querySelector<HTMLElement>(
      '.geoagent-arcgis-marker-icon',
    );
    expect(element).toBeTruthy();

    await agent.runCommand('set_layer_visibility', { name: 'pin', visible: false });
    expect(element?.style.display).toBe('none');
    await agent.runCommand('set_layer_visibility', { name: 'pin', visible: true });
    expect(element?.style.display).toBe('');

    await agent.runCommand('remove_layer', { name: 'pin' });
    element = view.container.querySelector<HTMLElement>(
      '.geoagent-arcgis-marker-icon',
    );
    expect(element).toBeNull();
  });

  it('captures screenshots through view.takeScreenshot', async () => {
    const onStateDataChange = vi.fn();
    const agent = new ArcGISTools(view as never, {
      allowCodeExecution: () => true,
      allowDestructiveTools: () => true,
      onStateDataChange,
      mapEngine: arcgisEngine(),
    });
    const result = (await agent.runCommand('screenshot_map')) as string;
    expect(view.takeScreenshot).toHaveBeenCalled();
    // The base64 image goes to the panel state, not into the model context
    // (a ~1MB tool result overflows provider input limits).
    expect(result).toContain('Screenshot captured: 480x320');
    expect(result).not.toContain('data:image/png');
    expect(onStateDataChange).toHaveBeenCalledWith({
      screenshot: expect.objectContaining({
        data_url: expect.stringContaining('data:image/png'),
        width: 480,
        height: 320,
      }),
    });
  });

  it('answers WebGL-only commands with explicit capability errors', async () => {
    const agent = tools(view);
    await expect(
      agent.runCommand('set_projection', { projection: 'globe' }),
    ).rejects.toThrow(/MapView renders Web Mercator only/);
    await expect(
      agent.runCommand('add_terrain', { url: 'https://example.com/{z}/{x}/{y}.png' }),
    ).rejects.toThrow(/Terrain/);
    await expect(
      agent.runCommand('add_3d_buildings'),
    ).rejects.toThrow(/fill-extrusion/);
    await expect(
      agent.runCommand('set_sky', { sky: { 'sky-color': '#000' } }),
    ).rejects.toThrow(/Sky is not supported/);
    await expect(
      agent.runCommand('add_map_source', {
        source_id: 'v',
        source: { type: 'vector', url: 'https://example.com/tiles' },
      }),
    ).rejects.toThrow(/Vector tile sources are not supported/);
  });

  it('unbinds watch and click listeners on destroy', async () => {
    const agent = tools(view);
    await agent.runCommand('get_map_state');
    expect(view.watchHandles.length).toBeGreaterThan(0);
    expect(view.eventHandles.length).toBeGreaterThan(0);
    agent.destroy();
    expect(view.watchHandles).toHaveLength(0);
    expect(view.eventHandles).toHaveLength(0);
  });

  it('answers cluster queries with point_count features', async () => {
    const agent = tools(view);
    await agent.runCommand('add_cluster_layer', {
      name: 'clustered',
      data: {
        type: 'FeatureCollection',
        features: [0, 1].map((i) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-95 + i * 0.001, 40] },
          properties: { id: i },
        })),
      },
    });
    const result = (await agent.runCommand('query_source_features', {
      source_id: 'clustered-source',
      filter: ['has', 'point_count'],
    })) as { features: Array<{ properties: { point_count: number } }> };
    expect(result.features).toHaveLength(1);
    expect(result.features[0].properties.point_count).toBe(2);
  });
});

describe('arcgis factory wiring', () => {
  it('creates ArcGISTools from createGeoAgentTools and registers its tool surface', () => {
    const view = new FakeView();
    try {
      const agent = createGeoAgentTools(view, {
        allowCodeExecution: () => true,
        allowDestructiveTools: () => true,
        mapEngine: arcgisEngine(),
      });
      expect(agent).toBeInstanceOf(ArcGISTools);
      const names = (agent.createTools() as Array<{ name: string }>).map(
        (item) => item.name,
      );
      expect(names).toContain('screenshot_map');
      for (const hidden of ['set_projection', 'add_terrain', 'add_3d_buildings']) {
        expect(names).not.toContain(hidden);
      }
    } finally {
      view.cleanup();
    }
  });

  it('rejects a mapEngine kind mismatch', () => {
    expect(
      () =>
        new ArcGISTools(new FakeView() as never, {
          allowCodeExecution: () => true,
          allowDestructiveTools: () => true,
          mapEngine: { kind: 'leaflet', namespace: {} } as never,
        }),
    ).toThrow(/requires mapEngine/);
  });
});

/* -------------------------------------------------------------------------- */
/* SceneView (3D globe) support                                               */
/* -------------------------------------------------------------------------- */

const BASE_MAP_SCALE = 591657527.591555;
const zoomToScale = (zoom: number): number => BASE_MAP_SCALE / Math.pow(2, zoom);

class FakeSceneView extends FakeView {
  camera = {
    position: { longitude: 86.925, latitude: 27.988, z: 12500 },
    heading: 105,
    tilt: 78,
  };
  scale = zoomToScale(5);
  spatialReference = { wkid: 102100 };
  /** Exact screen projection, like the real SDK (sync). */
  readonly toScreen = vi.fn((point: { longitude: number; latitude: number }) => {
    // Project through the extent, linearly — the test only cares that the
    // shim prefers this path over the fallback.
    const [width, height] = [400, 400];
    const west = mercX(-100);
    const east = mercX(-90);
    const north = mercY(50);
    const south = mercY(30);
    return {
      x: ((mercX(point.longitude) - west) / (east - west)) * width,
      y: ((north - mercY(point.latitude)) / (north - south)) * height,
    };
  });
}

describe('arcgis SceneView support', () => {
  let view: FakeSceneView;

  beforeEach(() => {
    view = new FakeSceneView();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    view.cleanup();
  });

  it('converts the SceneView scale into MapLibre zoom', async () => {
    const shim = createArcGISMapShim(view, arcgisNamespace);
    expect(shim.isScene).toBe(true);
    expect(shim.getZoom()).toBeCloseTo(5, 4);
    shim.setZoom(7);
    expect(view.scale).toBeCloseTo(zoomToScale(7), 4);
  });

  it('reads bearing from camera.heading and pitch from camera.tilt', () => {
    const shim = createArcGISMapShim(view, arcgisNamespace);
    // A SceneView heading maps directly to the clockwise bearing convention.
    expect(shim.getBearing()).toBe(105);
    // MapLibre pitch and ArcGIS tilt share the degrees-off-nadir convention.
    expect(shim.getPitch()).toBe(78);
  });

  it('reports the globe projection and answers set_projection per kind', async () => {
    const agent = tools(view);
    const state = (await agent.runCommand('get_map_state')) as {
      projection: string;
      bearing: number;
      pitch: number;
    };
    expect(state.projection).toBe('globe');
    expect(state.bearing).toBe(105);
    expect(state.pitch).toBe(78);

    const message = (await agent.runCommand('set_projection', {
      projection: 'globe',
    })) as string;
    expect(message).toMatch(/already renders a globe/);
    await expect(
      agent.runCommand('set_projection', { projection: 'mercator' }),
    ).rejects.toThrow(/renders a 3D globe/);
  });

  it('jumps through scale and animates through goTo', async () => {
    const agent = tools(view);
    await agent.runCommand('set_center', { lat: 30, lon: 90, zoom: 6 });
    expect(view.center).toEqual({ longitude: 90, latitude: 30 });
    expect(view.scale).toBeCloseTo(zoomToScale(6), 4);

    await agent.runCommand('fly_to', { lat: 45, lon: 9, zoom: 9 });
    expect(view.goToTargets.at(-1)).toMatchObject({
      center: [9, 45],
      scale: zoomToScale(9),
    });
    expect(view.scale).toBeCloseTo(zoomToScale(9), 4);
  });

  it('watches the camera (not zoom) for scene navigation', async () => {
    const agent = tools(view);
    await agent.runCommand('get_map_state');
    const properties = view.watchHandles.map((handle) => handle.property);
    expect(properties).toContain('camera');
    expect(properties).not.toContain('zoom');
    // Navigating the camera re-runs visibility/markers sync without error.
    view.camera.heading = 200;
    view.emitWatch('camera');
  });

  it('positions markers with the view toScreen projection', async () => {
    const agent = tools(view);
    await agent.runCommand('add_marker', { name: 'pin', lon: -95, lat: 40 });
    const element = view.container.querySelector<HTMLElement>(
      '.geoagent-arcgis-marker-icon',
    );
    expect(element).toBeTruthy();
    // toScreen ran with the marker's plain point; its screen position drives
    // the element's left/top instead of the extent-linear fallback.
    expect(view.toScreen).toHaveBeenCalledWith(
      expect.objectContaining({ longitude: -95, latitude: 40 }),
    );
    // toScreen's float result drives the pixel position.
    expect(Number.parseFloat(element?.style.left ?? '')).toBeCloseTo(200, 5);
    await agent.runCommand('remove_layer', { name: 'pin' });
    expect(
      view.container.querySelector('.geoagent-arcgis-marker-icon'),
    ).toBeNull();
  });

  it('falls back to extent-linear projection when toScreen is absent', () => {
    const bare = new FakeSceneView();
    (bare as unknown as { toScreen?: unknown }).toScreen = undefined;
    const shim = createArcGISMapShim(bare, arcgisNamespace);
    const pixel = shim.projectPoint(40, -95);
    // Linear-in-Mercator fallback: x = 200, y follows the mercator ratio.
    expect(pixel.x).toBeCloseTo(200, 5);
    const expectedY =
      ((mercY(50) - mercY(40)) / (mercY(50) - mercY(30))) * 400;
    expect(pixel.y).toBeCloseTo(expectedY, 5);
  });

  it('wording of the terrain error adapts to scenes', async () => {
    const agent = tools(view);
    await expect(
      agent.runCommand('add_terrain', { url: 'https://example.com/{z}/{x}/{y}.png' }),
    ).rejects.toThrow(/ground ElevationLayers/);
  });

  it('reports the SceneView engine name in script descriptions', () => {
    const agent = tools(view);
    const scriptTool = (
      agent.createTools() as Array<{ name: string; description: string }>
    ).find((item) => item.name === 'run_maplibre_script');
    expect(scriptTool?.description).toMatch(/ArcGIS SceneView/);
  });
});

describe('waitForArcGISComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeComponentElement(): HTMLElement {
    const el = document.createElement('arcgis-map');
    document.body.appendChild(el);
    return el;
  }

  it('resolves immediately when the view is already present', async () => {
    const view = new FakeView();
    const el = makeComponentElement();
    (el as unknown as { view?: unknown }).view = view;
    try {
      await expect(waitForArcGISComponent(el)).resolves.toBe(view);
    } finally {
      el.remove();
    }
  });

  it('resolves once the element exposes its view (event + poll)', async () => {
    const view = new FakeView();
    const el = makeComponentElement();
    try {
      const pending = waitForArcGISComponent(el);
      // The Lumina component emits arcgisViewReadyChange when ready.
      (el as unknown as { view?: unknown }).view = view;
      el.dispatchEvent(new CustomEvent('arcgisViewReadyChange'));
      await expect(pending).resolves.toBe(view);
    } finally {
      el.remove();
    }
  });

  it('rejects with an actionable error after the timeout', async () => {
    const el = makeComponentElement();
    try {
      const pending = waitForArcGISComponent(el, 1000);
      // Attach the rejection handler BEFORE the timer fires, so the rejection
      // never lands unhandled between the timer and the assertion.
      const expectation = expect(pending).rejects.toThrow(
        /did not expose its view within 1s/,
      );
      await vi.runAllTimersAsync();
      await expectation;
    } finally {
      el.remove();
    }
  });
});

describe('resolveMapContainer with ArcGIS components', () => {
  it('treats a bare component element as its own container', () => {
    const el = document.createElement('arcgis-map');
    document.body.appendChild(el);
    try {
      // The <arcgis-map> element constructs its view with container: this and
      // does not proxy a container property — so the element itself must
      // resolve, or GeoAgentCore.attach rejects it.
      expect(resolveMapContainer(el)).toBe(el);
    } finally {
      el.remove();
    }
  });

  it('still prefers an explicit container property (MapView)', () => {
    const inner = document.createElement('div');
    const fakeMapView = { container: inner };
    expect(resolveMapContainer(fakeMapView)).toBe(inner);
  });
});

describe('arcgis shadow DOM style injection', () => {
  it('injects marker/popup styles when the container lives in a shadow root', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const container = document.createElement('div');
    shadow.appendChild(container);
    try {
      const view = new FakeView();
      view.container = container;
      const shim = createArcGISMapShim(view, arcgisNamespace);
      // The page stylesheet cannot reach inside the shadow root, so the shim
      // must inject a self-contained copy of the marker/popup rules.
      const style = shadow.querySelector('style[data-geoagent-arcgis]');
      expect(style).toBeTruthy();
      expect(style?.textContent).toContain('.geoagent-arcgis-popup-content');
      expect(style?.textContent).toContain('.geoagent-arcgis-marker-icon');
      // A second shim on the same view must not duplicate the style.
      createArcGISMapShim(view, arcgisNamespace);
      expect(shadow.querySelectorAll('style[data-geoagent-arcgis]')).toHaveLength(1);
      // Markers created afterwards still land in the (styled) shadow tree.
      shim.createMarker('#ff0000').setLngLat([0, 0]).addTo(view);
      expect(
        shadow.querySelectorAll('.geoagent-arcgis-marker-icon'),
      ).toHaveLength(1);
    } finally {
      host.remove();
    }
  });

  it('skips injection in the light DOM (page stylesheet already applies)', () => {
    const view = new FakeView();
    // FakeView's container is attached to document.body → light DOM.
    createArcGISMapShim(view, arcgisNamespace);
    expect(
      document.querySelectorAll('style[data-geoagent-arcgis]'),
    ).toHaveLength(0);
  });
});
