import maplibregl from 'maplibre-gl';
import { LayerControl } from 'maplibre-gl-layer-control';
import { MaplibreStarfieldLayer } from '@geoql/maplibre-gl-starfield';
import { GeoAgentControl } from '../../src/index';
import '../../src/index.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import 'maplibre-gl-layer-control/style.css';
// ESO/S. Brunier milky way panorama (CC BY 4.0), equirectangular 4096x2048.
import milkywayUrl from '../assets/milkyway.jpg';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  // Tilted/rotated initial view so the milky way band of the skybox is
  // visible around the globe right after load.
  center: [-85, 32],
  zoom: 2.5,
  bearing: 150,
  maxPitch: 85,
  canvasContextAttributes: { preserveDrawingBuffer: true },
});

map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.FullscreenControl(), 'top-right');
map.addControl(new maplibregl.GlobeControl(), 'top-right');

map.on('load', () => {
  map.setProjection({ type: 'globe' });

  // Starfield background: the milky way panorama on a Three.js skybox plus
  // thousands of point stars, inserted below every other layer so the
  // globe renders in front of it.
  map.addLayer(
    new MaplibreStarfieldLayer({
      galaxyTextureUrl: milkywayUrl,
      // The ESO panorama is a real dark-sky photograph; the plugin default
      // (0.35) renders it almost black, 1.5 makes the galactic band visible.
      galaxyBrightness: 1.5,
      starCount: 4000,
      starSize: 2.0,
    }),
    map.getStyle().layers[0]?.id,
  );

  map.addControl(
    new LayerControl({
      collapsed: true,
      basemapStyleUrl: 'https://tiles.openfreemap.org/styles/liberty',
      panelWidth: 320,
      panelMinWidth: 240,
      panelMaxWidth: 420,
    }),
    'top-right',
  );

  const geoAgent = new GeoAgentControl({
    title: 'GeoAgent',
    collapsed: false,
    allowCodeExecutionDefault: true,
    allowDestructiveToolsDefault: true,
    showPermissionToggles: false,
  });

  map.addControl(geoAgent, 'top-left');

  geoAgent.on('statechange', (event) => {
    console.log('GeoAgent state changed:', event.state);
  });
});
