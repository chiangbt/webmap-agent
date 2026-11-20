import L from 'leaflet';
import { GeoAgentControl, addGeoAgentToLeafletMap } from '../../src/index';
import '../../src/index.css';
import 'leaflet/dist/leaflet.css';
import { dockAgentPanel } from '../shared/dock-panel';
import '../shared/dock-panel.css';

// A plain Leaflet map — no MapLibre anywhere. The GeoAgent tools run through
// the leaflet-engine compatibility shim (mapEngine: { kind: "leaflet" }).
const map = L.map('map', {
  center: [39.8283, -98.5795],
  zoom: 4,
});

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const geoAgent = new GeoAgentControl({
  title: 'GeoAgent (Leaflet)',
  collapsed: false,
  allowCodeExecutionDefault: true,
  allowDestructiveToolsDefault: true,
  showPermissionToggles: false,
  // Tell the tools this map is Leaflet and hand them the L namespace.
  mapEngine: { kind: 'leaflet', namespace: L as unknown as Record<string, unknown> },
});

// Leaflet has no map.addControl slot for foreign controls, so the control is
// attached through the helper, which mounts it into Leaflet's corner DOM.
const attachment = addGeoAgentToLeafletMap(geoAgent, map, { position: 'topleft' });

// Split layout: dock the agent panel into the left sidebar (25% wide).
dockAgentPanel(map.getContainer(), document.getElementById('sidebar')!);

geoAgent.on('statechange', (event) => {
  console.log('GeoAgent state changed:', event.state);
});

// Keep a reference so hot-reload / teardown can remove it cleanly.
if (import.meta.hot) {
  import.meta.hot.dispose(() => attachment.remove());
}
