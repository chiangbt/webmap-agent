import './lib/styles/geoagent-control.css';

export { GeoAgentControl } from './lib/core/control/GeoAgentControl';
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
  type GeoAgentArcGISEngine,
  type GeoAgentMarker,
  type GeoAgentPopup,
} from './lib/core/tools/geoagent-tools';
export { MapLibreAgentTools } from './lib/core/tools/maplibre-tools';
export { LeafletAgentTools } from './lib/core/tools/leaflet-tools';
export { OpenLayersAgentTools } from './lib/core/tools/openlayers-tools';
export { ArcGISTools } from './lib/core/tools/arcgis-tools';
export { createGeoAgentTools } from './lib/core/tools/tools-factory';

export {
  LeafletMapShim,
  addGeoAgentToLeafletMap,
  createLeafletMapShim,
  isLeafletMap,
  isLeafletMapShim,
  type LeafletControlAttachment,
  type LeafletMapLike,
} from './lib/core/engines/leaflet-engine';

export {
  OpenLayersMapShim,
  addGeoAgentToOpenLayersMap,
  createOpenLayersMapShim,
  isOpenLayersMap,
  isOpenLayersMapShim,
  type OpenLayersControlAttachment,
  type OpenLayersMapLike,
  type OpenLayersNamespace,
} from './lib/core/engines/openlayers-engine';

export {
  ArcGISMapShim,
  addGeoAgentToArcGISMap,
  createArcGISMapShim,
  isArcGISComponent,
  isArcGISMapShim,
  isArcGISSceneView,
  isArcGISView,
  resolveArcGISView,
  waitForArcGISComponent,
  type ArcGISControlAttachment,
  type ArcGISComponentLike,
  type ArcGISNamespace,
  type ArcGISViewLike,
} from './lib/core/engines/arcgis-engine';

export type {
  EarthEngineOptions,
  EarthEngineLayerRecord,
  GeeDataset,
} from './lib/core/earth-engine/earth-engine';

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
