/**
 * P4 regression guard: `maplibre-gl` must be a lazy, default-engine-only
 * dependency. The module is mocked with a spy (returning a fake namespace),
 * so every runtime load of maplibre-gl in this file is recorded: the 2D
 * engines must never trigger one, and the default MapLibre engine must reach
 * it only through the lazy dynamic import on its first command.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import L from 'leaflet';
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
import { createGeoAgentTools } from '../src/lib/core/tools-factory';
import type {
  GeoAgentMapEngine,
  GeoAgentTools,
} from '../src/lib/core/geoagent-tools';

const { maplibreImportSpy } = vi.hoisted(() => ({
  maplibreImportSpy: vi.fn(),
}));

vi.mock('maplibre-gl', () => {
  maplibreImportSpy();
  // A fake namespace: enough for the default engine's lazy resolution to
  // succeed, so tests can assert WHEN maplibre-gl gets loaded, not just that
  // loading fails.
  return {
    Marker: class {
      setLngLat() {
        return this;
      }
      addTo() {
        return this;
      }
      setPopup() {
        return this;
      }
      getElement() {
        return document.createElement('div');
      }
      remove() {
        return this;
      }
    },
    Popup: class {
      setText() {
        return this;
      }
    },
  };
});

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

function toolsFor(
  map: unknown,
  mapEngine?: GeoAgentMapEngine,
): GeoAgentTools {
  return createGeoAgentTools(map, {
    allowCodeExecution: () => true,
    allowDestructiveTools: () => true,
    mapEngine,
  });
}

/** The map members runCommand touches before any namespace use. */
function fakeMapLibreMap() {
  return {
    loaded: () => true,
    getCenter: () => ({ lng: -100, lat: 40 }),
    getBounds: () => ({
      getWest: () => -110,
      getSouth: () => 30,
      getEast: () => -90,
      getNorth: () => 50,
    }),
    getZoom: () => 4,
    getBearing: () => 0,
    getPitch: () => 0,
    getProjection: () => ({ type: 'mercator' }),
  };
}

describe('lazy maplibre-gl loading', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    maplibreImportSpy.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('never imports maplibre-gl on a Leaflet host', async () => {
    const map = L.map(container, {
      center: [39.8283, -98.5795],
      zoom: 4,
      zoomControl: false,
      attributionControl: false,
    });
    try {
      const agent = toolsFor(
        map,
        {
          kind: 'leaflet',
          namespace: L as unknown as Record<string, unknown>,
        },
      );
      await agent.runCommand('get_map_state');
      await agent.runCommand('add_marker', { lat: 39, lon: -98, name: 'pin' });
      const script = (await agent.runCommand('run_maplibre_script', {
        code: 'return typeof L.marker;',
      })) as { result: string };
      expect(script.result).toBe('function');
      expect(maplibreImportSpy).not.toHaveBeenCalled();
    } finally {
      map.remove();
    }
  });

  it('never imports maplibre-gl on an OpenLayers host', async () => {
    const map = new Map({
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
    try {
      const agent = toolsFor(
        map,
        {
          kind: 'openlayers',
          namespace: openLayersNamespace as unknown as Record<string, unknown>,
        },
      );
      await agent.runCommand('get_map_state');
      await agent.runCommand('add_marker', { lat: 39, lon: -98, name: 'pin' });
      const script = (await agent.runCommand('run_maplibre_script', {
        code: 'return typeof ol.fromLonLat;',
      })) as { result: string };
      expect(script.result).toBe('function');
      expect(maplibreImportSpy).not.toHaveBeenCalled();
    } finally {
      map.setTarget(undefined);
    }
  });

  it('reaches maplibre-gl only through the lazy import on the default engine', async () => {
    const agent = toolsFor(fakeMapLibreMap());
    // Construction loads nothing...
    expect(maplibreImportSpy).not.toHaveBeenCalled();
    // ...the first command lazily imports the mocked module...
    const state = (await agent.runCommand('get_map_state')) as {
      projection: string;
    };
    expect(state.projection).toBe('mercator');
    expect(maplibreImportSpy).toHaveBeenCalledTimes(1);
    // ...and later commands reuse the cached namespace.
    await agent.runCommand('get_map_state');
    expect(maplibreImportSpy).toHaveBeenCalledTimes(1);
  });
});
