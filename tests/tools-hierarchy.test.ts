/**
 * The GeoAgentTools class hierarchy: createGeoAgentTools routes a mapEngine
 * declaration to the right subclass, every subclass IS a GeoAgentTools, and
 * the subclasses reject engine declarations they cannot drive.
 */
import { afterEach, describe, expect, it } from 'vitest';
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
import { GeoAgentTools } from '../src/lib/core/geoagent-tools';
import { MapLibreAgentTools } from '../src/lib/core/maplibre-tools';
import { LeafletAgentTools } from '../src/lib/core/leaflet-tools';
import { OpenLayersAgentTools } from '../src/lib/core/openlayers-tools';
import { createGeoAgentTools } from '../src/lib/core/tools-factory';

const baseOptions = {
  allowCodeExecution: () => true,
  allowDestructiveTools: () => true,
};

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

describe('GeoAgentTools hierarchy and factory routing', () => {
  let container: HTMLDivElement;

  const makeContainer = () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    return container;
  };

  afterEach(() => {
    container?.remove();
  });

  it('routes a Leaflet mapEngine to LeafletAgentTools', () => {
    const map = L.map(makeContainer(), { center: [0, 0], zoom: 1 });
    try {
      const tools = createGeoAgentTools(map, {
        ...baseOptions,
        mapEngine: {
          kind: 'leaflet',
          namespace: L as unknown as Record<string, unknown>,
        },
      });
      expect(tools).toBeInstanceOf(LeafletAgentTools);
      expect(tools).toBeInstanceOf(GeoAgentTools);
    } finally {
      map.remove();
    }
  });

  it('routes an OpenLayers mapEngine to OpenLayersAgentTools', () => {
    const map = new Map({
      target: makeContainer(),
      view: new View({ center: fromLonLat([0, 0]), zoom: 1 }),
    });
    try {
      const tools = createGeoAgentTools(map, {
        ...baseOptions,
        mapEngine: {
          kind: 'openlayers',
          namespace: openLayersNamespace as unknown as Record<string, unknown>,
        },
      });
      expect(tools).toBeInstanceOf(OpenLayersAgentTools);
      expect(tools).toBeInstanceOf(GeoAgentTools);
    } finally {
      map.setTarget(undefined);
    }
  });

  it('routes the default and mapbox engines to MapLibreAgentTools', () => {
    const fakeMap = { getContainer: () => makeContainer() };
    const defaultTools = createGeoAgentTools(fakeMap, baseOptions);
    expect(defaultTools).toBeInstanceOf(MapLibreAgentTools);
    expect(defaultTools).toBeInstanceOf(GeoAgentTools);

    const mapboxTools = createGeoAgentTools(fakeMap, {
      ...baseOptions,
      mapEngine: {
        kind: 'mapbox',
        namespace: { Marker: class {}, Popup: class {} } as never,
      },
    });
    expect(mapboxTools).toBeInstanceOf(MapLibreAgentTools);
  });

  it('MapLibreAgentTools refuses a 2D shim engine', () => {
    expect(
      () =>
        new MapLibreAgentTools({} as never, {
          ...baseOptions,
          mapEngine: {
            kind: 'leaflet',
            namespace: L as unknown as Record<string, unknown>,
          },
        }),
    ).toThrow(/LeafletAgentTools/);
    expect(
      () =>
        new MapLibreAgentTools({} as never, {
          ...baseOptions,
          mapEngine: {
            kind: 'openlayers',
            namespace: openLayersNamespace as unknown as Record<string, unknown>,
          },
        }),
    ).toThrow(/OpenLayersAgentTools/);
  });

  it('the 2D subclasses refuse a missing or foreign mapEngine', () => {
    expect(() => new LeafletAgentTools({} as never, baseOptions)).toThrow(
      /kind: "leaflet"/,
    );
    expect(
      () =>
        new OpenLayersAgentTools(
          {} as never,
          {
            ...baseOptions,
            mapEngine: {
              kind: 'leaflet',
              namespace: L as unknown as Record<string, unknown>,
            },
          },
        ),
    ).toThrow(/kind: "openlayers"/);
  });
});
