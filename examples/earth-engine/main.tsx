import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import maplibregl, { type Map } from 'maplibre-gl';
import { LayerControl } from 'maplibre-gl-layer-control';
import { GeoAgentPanel } from '@/react';
import { ExampleShell } from '@/demo/example-shell';
import { applyExamplePageLocale, resolveExamplesLocale } from '@/demo/locale';
import { HOMEPAGE_I18N } from '@/demo/i18n';
import { readLlmEnvConfig } from '@/demo/env';
import '@/demo/demo.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import 'maplibre-gl-layer-control/style.css';

// Follow the language chosen on the examples homepage (localStorage).
const locale = resolveExamplesLocale();
// Deployment defaults from .env (LLM_API_URL / LLM_API_KEY / LLM_API_MODEL).
const llm = readLlmEnvConfig();
applyExamplePageLocale(locale, {
  en: 'web-geoagent - Earth Engine Example',
  zh: 'web-geoagent - Earth Engine 示例',
  tw: 'web-geoagent - Earth Engine 範例',
});

const STORAGE_PREFIX = 'web-geoagent.ee-example';

function envString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function projectValue(envValue: unknown): string {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get('ee_project_id') ||
    envString(envValue) ||
    sessionStorage.getItem(`${STORAGE_PREFIX}.earthEngine.projectId`) ||
    localStorage.getItem(`${STORAGE_PREFIX}.ee_project_id`) ||
    ''
  );
}

function EarthEngineExample() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<Map | null>(null);

  useEffect(() => {
    if (!mapContainer.current) return;

    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      // Global initial extent: the whole world in view on load.
      center: [10, 12],
      zoom: 1.6,
      maxPitch: 85,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });

    mapInstance.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapInstance.addControl(new maplibregl.FullscreenControl(), 'top-right');
    mapInstance.addControl(new maplibregl.GlobeControl(), 'top-right');

    mapInstance.on('load', () => {
      mapInstance.setProjection({ type: 'globe' });

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
            title="GeoAgent（Earth Engine）"
            locale={locale}
            collapsed={false}
            showCollapseButton={false}
          defaultBaseUrl={llm.baseUrl}
          defaultApiKey={llm.apiKey}
          defaultModel={llm.model}
            storagePrefix={STORAGE_PREFIX}
            earthEngine={{
              oauthClientId: envString(import.meta.env.VITE_GEE_OAUTH_CLIENT_ID),
              projectId: projectValue(import.meta.env.VITE_GEE_PROJECT_ID),
              includeCommunityCatalog: true,
            }}
          />
        )}
      </div>
      <div ref={mapContainer} className="relative min-w-0 flex-1" />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ExampleShell title={HOMEPAGE_I18N[locale].earthEngineTitle}>
    <EarthEngineExample />
  </ExampleShell>,
);
