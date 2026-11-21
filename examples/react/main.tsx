import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import maplibregl, { type Map } from 'maplibre-gl';
import { LayerControl } from 'maplibre-gl-layer-control';
import { MaplibreStarfieldLayer } from '@geoql/maplibre-gl-starfield';
import { GeoAgentPanel } from '@/react';
import { ExampleShell } from '@/demo/example-shell';
import { applyExamplePageLocale, resolveExamplesLocale } from '@/demo/locale';
import { HOMEPAGE_I18N } from '@/demo/i18n';
import { readLlmEnvConfig } from '@/demo/env';
import '@/demo/demo.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import 'maplibre-gl-layer-control/style.css';
// ESO/S. Brunier milky way panorama (CC BY 4.0), equirectangular 4096x2048.
import milkywayUrl from '../assets/milkyway.jpg';

// Follow the language chosen on the examples homepage (localStorage).
const locale = resolveExamplesLocale();
// Deployment defaults from .env (LLM_API_URL / LLM_API_KEY / LLM_API_MODEL).
const llm = readLlmEnvConfig();
applyExamplePageLocale(locale, {
  en: 'web-geoagent - React Example',
  zh: 'web-geoagent - React 示例',
});

function ReactExample() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<Map | null>(null);

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

  return (
    <div className="flex w-full">
      <div className="flex shrink-0 flex-col overflow-hidden border-r bg-muted">
        {map && (
          <GeoAgentPanel
            map={map}
            title="GeoAgent"
            locale={locale}
            collapsed={false}
            showCollapseButton={false}
          defaultBaseUrl={llm.baseUrl}
          defaultApiKey={llm.apiKey}
          defaultModel={llm.model}
          />
        )}
      </div>
      <div ref={mapContainer} className="relative min-w-0 flex-1" />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ExampleShell title={HOMEPAGE_I18N[locale].reactTitle}>
    <ReactExample />
  </ExampleShell>,
);
