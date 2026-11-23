import type { Map as MapLibreMap } from 'maplibre-gl';
import { isArcGISSceneView, resolveArcGISView, type ArcGISViewLike } from './engines/arcgis-engine';
import { isLeafletMap, type LeafletMapLike } from './engines/leaflet-engine';
import { isOpenLayersMap, type OpenLayersMapLike } from './engines/openlayers-engine';
import { isRecord } from './engines/shared';
import type { GeoAgentMapEngine } from './tools/geoagent-tools';
import type { GeoAgentControlOptions } from './types';

/** Structural contracts keep the optional map SDKs out of the library's dependencies. */
export interface GeoAgentMaps {
  maplibre: MapLibreMap;
  mapbox: Pick<MapLibreMap, 'getContainer' | 'getZoom'> & {
    getCenter(): { lng: number; lat: number };
    getStyle(): unknown;
  };
  leaflet: LeafletMapLike;
  openlayers: Pick<OpenLayersMapLike, 'getView' | 'getTargetElement' | 'getSize'> & {
    getViewport(): HTMLElement | undefined;
    getLayers(): { getLength(): number };
  };
  arcgis: ArcGISHostView | { readonly view: ArcGISHostView | null | undefined };
}

type ArcGISHostView = Pick<ArcGISViewLike, 'goTo'> & {
  readonly container: HTMLElement | null | undefined;
};

export type GeoAgentMapKind = keyof GeoAgentMaps;
export type GeoAgentMapFor<K extends GeoAgentMapKind> = GeoAgentMaps[K];

/** An engine configuration is required whenever the default MapLibre engine is excluded. */
export type GeoAgentOptionsFor<K extends GeoAgentMapKind> =
  Omit<GeoAgentControlOptions, 'mapEngine'> &
  { mapEngine?: GeoAgentMapEngine & { kind: K } } &
  ('maplibre' extends K ? unknown : { mapEngine: GeoAgentMapEngine });

/** Check the host before any tool or control mutates it. */
export function validateMapBinding(map: unknown, engine: GeoAgentMapEngine | undefined): 'map' | 'scene' | undefined {
  const kind = engine?.kind ?? 'maplibre';
  switch (kind) {
    case 'arcgis': {
      const viewKind = isArcGISSceneView(resolveArcGISView(map)) ? 'scene' : 'map';
      if (engine?.kind === 'arcgis' && engine.viewKind && engine.viewKind !== viewKind) {
        throw new TypeError(`GeoAgent expected an ArcGIS ${engine.viewKind === 'map' ? 'MapView' : 'SceneView'} for viewKind "${engine.viewKind}".`);
      }
      return viewKind;
    }
    case 'leaflet':
      if (isLeafletMap(map)) return;
      throw new TypeError('GeoAgent expected a Leaflet map for mapEngine.kind "leaflet".');
    case 'openlayers':
      if (isOpenLayersMap(map)) return;
      throw new TypeError('GeoAgent expected an OpenLayers map for mapEngine.kind "openlayers".');
    case 'maplibre':
    case 'mapbox':
      if (isRecord(map) && typeof map.getContainer === 'function' && typeof map.getStyle === 'function') return;
      throw new TypeError(`GeoAgent expected a ${kind === 'maplibre' ? 'MapLibre GL' : 'Mapbox GL'} map for mapEngine.kind "${kind}". Pass the matching mapEngine for other map libraries.`);
    default:
      throw new TypeError(`Unsupported GeoAgent mapEngine.kind "${kind}".`);
  }
}
