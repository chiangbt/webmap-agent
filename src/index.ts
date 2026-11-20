import './lib/styles/geoagent-control.css';

export { GeoAgentControl } from './lib/core/GeoAgentControl';
export {
  DEFAULT_BASEMAPS,
  geoJsonBounds,
  geoJsonGeometryTypes,
  geojsonLayerDefs,
  geojsonLayerPaint,
  slug,
  toJsonValue,
  type BBox,
  type JsonObject,
  type GeoAgentMapEngine,
  type GeoAgentStyleSpecEngine,
  type GeoAgentLeafletEngine,
  type GeoAgentMarker,
  type GeoAgentPopup,
} from './lib/core/maplibre-tools';

export {
  LeafletMapShim,
  addGeoAgentToLeafletMap,
  createLeafletMapShim,
  isLeafletMap,
  isLeafletMapShim,
  type LeafletControlAttachment,
  type LeafletMapLike,
} from './lib/core/leaflet-engine';

export type {
  EarthEngineOptions,
  EarthEngineLayerRecord,
  GeeDataset,
} from './lib/core/earth-engine';

export type {
  GeoAgentControlEvent,
  GeoAgentControlEventHandler,
  GeoAgentControlOptions,
  GeoAgentControlReactProps,
  GeoAgentProviderConfig,
  GeoAgentProviderId,
  GeoAgentState,
} from './lib/core/types';
