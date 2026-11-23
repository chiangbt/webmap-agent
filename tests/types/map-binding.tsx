import type { Map as LeafletMap } from 'leaflet';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type OpenLayersMap from 'ol/Map';
import { GeoAgentCore } from '../../src/index';
import { GeoAgentPanel } from '../../src/react';

declare const leafletMap: LeafletMap;
declare const mapLibre: MapLibreMap;
declare const openLayers: OpenLayersMap;
declare const arcgisMap: HTMLElementTagNameMap['arcgis-map'];

const leafletEngine = { kind: 'leaflet', namespace: {} } as const;
const leaflet = new GeoAgentCore({ mapEngine: leafletEngine });
leaflet.attach(leafletMap);
leaflet.getMap()?.setView([0, 0], 1);
// @ts-expect-error The Leaflet core cannot bind a MapLibre map.
leaflet.attach(mapLibre);
// @ts-expect-error Explicit non-default cores require their engine configuration.
new GeoAgentCore<'leaflet'>();

const defaultCore = new GeoAgentCore();
defaultCore.attach(mapLibre);
defaultCore.getMap()?.getCanvas();
// @ts-expect-error The default engine is MapLibre.
defaultCore.attach(openLayers);

const olCore = new GeoAgentCore({ mapEngine: { kind: 'openlayers', namespace: {} } });
olCore.attach(openLayers);
olCore.getMap()?.getView()?.getZoom();

<GeoAgentPanel map={mapLibre} />;
<GeoAgentPanel map={leafletMap} mapEngine={leafletEngine} />;
<GeoAgentPanel map={openLayers} mapEngine={{ kind: 'openlayers', namespace: {} }} />;
<GeoAgentPanel map={arcgisMap} mapEngine={{ kind: 'arcgis', namespace: {} }} />;
<GeoAgentPanel core={leaflet} map={leafletMap} />;
// @ts-expect-error A non-default engine must be configured.
<GeoAgentPanel map={leafletMap} />;
// @ts-expect-error mapEngine and map must describe the same engine.
<GeoAgentPanel map={openLayers} mapEngine={leafletEngine} />;
// @ts-expect-error The supplied core determines the panel's engine.
<GeoAgentPanel core={leaflet} map={mapLibre} />;
// @ts-expect-error A supplied core and explicit engine cannot disagree.
<GeoAgentPanel core={leaflet} map={leafletMap} mapEngine={{ kind: 'openlayers', namespace: {} }} />;
