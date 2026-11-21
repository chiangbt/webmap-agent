import './lib/styles/geoagent-control.css';

export { GeoAgentControl } from './lib/core/GeoAgentControl';
export { GeoAgentCore } from './lib/core/GeoAgentCore';
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
  type GeoAgentOpenLayersEngine,
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

export {
  OpenLayersMapShim,
  addGeoAgentToOpenLayersMap,
  createOpenLayersMapShim,
  isOpenLayersMap,
  isOpenLayersMapShim,
  type OpenLayersControlAttachment,
  type OpenLayersMapLike,
  type OpenLayersNamespace,
} from './lib/core/openlayers-engine';

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
  GeoAgentConversationChange,
  GeoAgentConversationEntry,
  GeoAgentNoteState,
  GeoAgentProviderConfig,
  GeoAgentProviderId,
  GeoAgentState,
  GeoAgentStatusState,
} from './lib/core/types';

export type { GeoAgentLocale } from './lib/i18n';
