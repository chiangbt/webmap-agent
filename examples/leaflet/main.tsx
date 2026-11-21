import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import L, { type Map as LeafletMap } from 'leaflet';
import { GeoAgentPanel } from '@/react';
import { ExampleShell } from '@/demo/example-shell';
import { applyExamplePageLocale, resolveExamplesLocale } from '@/demo/locale';
import { HOMEPAGE_I18N } from '@/demo/i18n';
import { readLlmEnvConfig } from '@/demo/env';
import '@/demo/demo.css';
import 'leaflet/dist/leaflet.css';

// Follow the language chosen on the examples homepage (localStorage).
const locale = resolveExamplesLocale();
// Deployment defaults from .env (LLM_API_URL / LLM_API_KEY / LLM_API_MODEL).
const llm = readLlmEnvConfig();
applyExamplePageLocale(locale, {
  en: 'web-geoagent - Leaflet Example',
  zh: 'web-geoagent - Leaflet 示例',
  tw: 'web-geoagent - Leaflet 範例',
});

function LeafletExample() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<LeafletMap | null>(null);

  useEffect(() => {
    if (!mapContainer.current) return;

    // A plain Leaflet map — no MapLibre anywhere. The GeoAgent tools run
    // through the leaflet-engine compatibility shim
    // (mapEngine: { kind: "leaflet" }).
    const mapInstance = L.map(mapContainer.current, {
      center: [39.8283, -98.5795],
      zoom: 4,
    });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(mapInstance);

    setMap(mapInstance);

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
            title="GeoAgent (Leaflet)"
            locale={locale}
            collapsed={false}
            showCollapseButton={false}
          defaultBaseUrl={llm.baseUrl}
          defaultApiKey={llm.apiKey}
          defaultModel={llm.model}
            // Tell the tools this map is Leaflet and hand them the L namespace.
            mapEngine={{
              kind: 'leaflet',
              namespace: L as unknown as Record<string, unknown>,
            }}
          />
        )}
      </div>
      <div ref={mapContainer} className="relative min-w-0 flex-1" />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ExampleShell title={HOMEPAGE_I18N[locale].leafletTitle}>
    <LeafletExample />
  </ExampleShell>,
);
