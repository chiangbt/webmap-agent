import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import maplibregl, { type Map } from 'maplibre-gl';
import { LayerControl } from 'maplibre-gl-layer-control';
import { MaplibreStarfieldLayer } from '@geoql/maplibre-gl-starfield';
import { GeoAgentControlReact, useGeoAgentState } from '../../src/react';
import '../../src/index.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import 'maplibre-gl-layer-control/style.css';
import { dockAgentPanel } from '../shared/dock-panel';
import '../shared/dock-panel.css';
// ESO/S. Brunier milky way panorama (CC BY 4.0), equirectangular 4096x2048.
import milkywayUrl from '../assets/milkyway.jpg';

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const sidebar = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<Map | null>(null);
  const { state, setState } = useGeoAgentState({ collapsed: false });

  useEffect(() => {
    if (!mapContainer.current) return;

    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      // Tilted/rotated initial view so the milky way band of the skybox is
      // visible around the globe right after load.
      center: [-85, 32],
      zoom: 2.5,
      bearing: 150,
      maxPitch: 85,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });

    mapInstance.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapInstance.addControl(new maplibregl.FullscreenControl(), 'top-right');
    mapInstance.addControl(new maplibregl.GlobeControl(), 'top-right');
    mapInstance.on('load', () => {
      mapInstance.setProjection({ type: 'globe' });

      // Starfield background: milky way panorama skybox + point stars,
      // inserted below every other layer so the globe renders in front.
      mapInstance.addLayer(
        new MaplibreStarfieldLayer({
          galaxyTextureUrl: milkywayUrl,
          // The ESO panorama is a real dark-sky photograph; the plugin
          // default (0.35) renders it almost black, 1.5 makes the band show.
          galaxyBrightness: 1.5,
          starCount: 4000,
          starSize: 2.0,
        }),
        mapInstance.getStyle().layers[0]?.id,
      );

      mapInstance.addControl(
        new LayerControl({
          collapsed: true,
          basemapStyleUrl: 'https://tiles.openfreemap.org/styles/liberty',
          panelWidth: 320,
          panelMinWidth: 240,
          panelMaxWidth: 420,
        }),
        'top-right',
      );
      setMap(mapInstance);
    });

    return () => {
      mapInstance.remove();
    };
  }, []);

  // Split layout: once the React wrapper has added the control, dock the
  // agent panel into the left sidebar (25% wide).
  useEffect(() => {
    if (map && sidebar.current) {
      dockAgentPanel(map.getContainer(), sidebar.current);
    }
  }, [map]);

  return (
    <div className="geoagent-dock">
      <div ref={sidebar} className="geoagent-sidebar" />
      <div ref={mapContainer} className="geoagent-map-host" />
      {map && (
        <GeoAgentControlReact
          map={map}
          title="GeoAgent"
          collapsed={state.collapsed}
          position="top-left"
          allowCodeExecutionDefault={true}
          allowDestructiveToolsDefault={true}
          showPermissionToggles={false}
          onStateChange={setState}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
