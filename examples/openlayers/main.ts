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
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from 'ol/style';
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj';
import { GeoAgentControl, addGeoAgentToOpenLayersMap } from '../../src/index';
import '../../src/index.css';
import 'ol/ol.css';
import { dockAgentPanel } from '../shared/dock-panel';
import '../shared/dock-panel.css';
import { applyExamplePageLocale, resolveExamplesLocale } from '../shared/locale';

// Follow the language chosen on the examples homepage (localStorage).
const locale = resolveExamplesLocale();
applyExamplePageLocale(locale, {
  en: 'maplibre-gl-geoagent - OpenLayers Example',
  zh: 'maplibre-gl-geoagent - OpenLayers 示例',
});

// A plain OpenLayers map — no MapLibre anywhere. The GeoAgent tools run
// through the openlayers-engine compatibility shim
// (mapEngine: { kind: "openlayers" }).
const map = new Map({
  target: 'map',
  layers: [
    new TileLayer({
      source: new XYZ({
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        attributions: [
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        ],
      }),
    }),
  ],
  view: new View({
    center: fromLonLat([-98.5795, 39.8283]),
    zoom: 4,
  }),
});

// The only ol imports the shim needs, assembled once. Every key is required;
// a missing one produces an explicit error instead of a confusing crash.
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

const geoAgent = new GeoAgentControl({
  title: 'GeoAgent (OpenLayers)',
  locale,
  collapsed: false,
  allowCodeExecutionDefault: true,
  allowDestructiveToolsDefault: true,
  showPermissionToggles: false,
  // Tell the tools this map is OpenLayers and hand them the namespace above.
  mapEngine: {
    kind: 'openlayers',
    namespace: openLayersNamespace as unknown as Record<string, unknown>,
  },
});

// OpenLayers has no map.addControl slot for foreign controls, so the control
// is attached through the helper, which mounts it into the map viewport.
const attachment = addGeoAgentToOpenLayersMap(geoAgent, map, { position: 'top-left' });

// Split layout: dock the agent panel into the left sidebar (25% wide).
dockAgentPanel(map.getTargetElement()!, document.getElementById('sidebar')!);

geoAgent.on('statechange', (event) => {
  console.log('GeoAgent state changed:', event.state);
});

// Keep a reference so hot-reload / teardown can remove it cleanly.
if (import.meta.hot) {
  import.meta.hot.dispose(() => attachment.remove());
}
