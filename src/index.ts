import './lib/styles/geoagent-control.css';

export { GeoAgentControl } from './lib/core/GeoAgentControl';
export { GeoAgentCore } from './lib/core/GeoAgentCore';
export {
  GeoAgentTools,
  DEFAULT_BASEMAPS,
  geoJsonBounds,
  geoJsonGeometryTypes,
  geojsonLayerDefs,
  geojsonLayerPaint,
  slug,
  toJsonValue,
  type BBox,
  type JsonObject,
  type GeoAgentToolsOptions,
  type MapLibreAgentToolsOptions,
  type GeoAgentMapEngine,
  type GeoAgentStyleSpecEngine,
  type GeoAgentStyleSpecNamespace,
  type GeoAgentLeafletEngine,
  type GeoAgentOpenLayersEngine,
  type GeoAgentMarker,
  type GeoAgentPopup,
} from './lib/core/geoagent-tools';
export { MapLibreAgentTools } from './lib/core/maplibre-tools';
export { LeafletAgentTools } from './lib/core/leaflet-tools';
export { OpenLayersAgentTools } from './lib/core/openlayers-tools';
export { createGeoAgentTools } from './lib/core/tools-factory';

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
