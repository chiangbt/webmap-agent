import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
// The @arcgis/map-components web components + the esri classes the GeoAgent
// shim constructs. The library itself never imports @arcgis/* — the host
// assembles the namespace once.
import { defineCustomElements } from '@arcgis/map-components/dist/loader';
import WebTileLayer from '@arcgis/core/layers/WebTileLayer.js';
import FeatureLayer from '@arcgis/core/layers/FeatureLayer.js';
import Graphic from '@arcgis/core/Graphic.js';
import SimpleFillSymbol from '@arcgis/core/symbols/SimpleFillSymbol.js';
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol.js';
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol.js';
import TextSymbol from '@arcgis/core/symbols/TextSymbol.js';
import PictureMarkerSymbol from '@arcgis/core/symbols/PictureMarkerSymbol.js';
import { GeoAgentCore } from '@/lib/core/GeoAgentCore';
import { GeoAgentPanel } from '@/react';
import { waitForArcGISComponent } from '@/lib/core/engines/arcgis-engine';
import { ExampleShell } from '@/demo/example-shell';
import { applyExamplePageLocale, resolveExamplesLocale } from '@/demo/locale';
import { HOMEPAGE_I18N } from '@/demo/i18n';
import { readLlmEnvConfig } from '@/demo/env';
import '@/demo/demo.css';
import '@arcgis/map-components/dist/arcgis-map-components/arcgis-map-components.css';

// Register <arcgis-map> / <arcgis-scene> and friends.
void defineCustomElements();

// Follow the language chosen on the examples homepage (localStorage).
const locale = resolveExamplesLocale();
// Deployment defaults from .env (LLM_API_URL / LLM_API_KEY / LLM_API_MODEL).
const llm = readLlmEnvConfig();
applyExamplePageLocale(locale, {
  en: 'web-geoagent - ArcGIS Map Example',
  zh: 'web-geoagent - ArcGIS Map 示例',
});

/**
 * A small hand-made dataset seeded through the agent's own tool machinery
 * (runCommand), so the panel's first prompt already has agent-managed layers
 * to query and restyle: two district polygons, a bus line, and café points.
 */
const DEMO_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-122.44, 37.77],
            [-122.39, 37.77],
            [-122.39, 37.81],
            [-122.44, 37.81],
            [-122.44, 37.77],
          ],
        ],
      },
      properties: { name: 'Downtown', population: 87000, density: 14500 },
    },
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-122.51, 37.79],
            [-122.45, 37.79],
            [-122.45, 37.83],
            [-122.51, 37.83],
            [-122.51, 37.79],
          ],
        ],
      },
      properties: { name: 'Richmond', population: 71000, density: 9800 },
    },
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-122.508, 37.802],
          [-122.472, 37.804],
          [-122.44, 37.789],
          [-122.417, 37.784],
        ],
      },
      properties: { name: 'Bus 38', ridership: 21000 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.419, 37.779] },
      properties: { name: 'Cafe Mission', rating: 4.7, seats: 40 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.434, 37.786] },
      properties: { name: 'Cafe Civic', rating: 4.4, seats: 65 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.462, 37.79] },
      properties: { name: 'Cafe Presidio', rating: 4.8, seats: 30 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.497, 37.808] },
      properties: { name: 'Cafe Golden Gate', rating: 4.6, seats: 52 },
    },
  ],
} as const;

function ArcGISMapExample() {
  const mapElement = useRef<HTMLElement>(null);
  const [core] = useState(
    () =>
      new GeoAgentCore({
        collapsed: false,
        locale,
        defaultBaseUrl: llm.baseUrl,
        defaultApiKey: llm.apiKey,
        defaultModel: llm.model,
        // The ArcGIS compatibility engine: MapView (flat 2D) + the esri
        // classes the shim constructs.
        mapEngine: {
          kind: 'arcgis',
          viewKind: 'map',
          namespace: {
            WebTileLayer,
            FeatureLayer,
            Graphic,
            SimpleFillSymbol,
            SimpleLineSymbol,
            SimpleMarkerSymbol,
            TextSymbol,
            PictureMarkerSymbol,
          },
        },
      }),
  );
  const [mapEl, setMapEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = mapElement.current;
    if (!el) return;
    let disposed = false;
    // The component's MapView only exists after the component loads. Note:
    // these web components have no when() method — the element inherits the
    // native EventTarget.prototype.when(type), which needs an event name.
    void waitForArcGISComponent(el).then(() => {
      if (disposed) {
        return;
      }
      setMapEl(el);
    });
    return () => {
      disposed = true;
    };
  }, []);

  // Seed demo data through the agent's own tools once the panel has attached
  // (child effects run before parent effects, so the tools exist here).
  useEffect(() => {
    if (!mapEl) return;
    const tools = core.getTools();
    if (!tools) return;
    void tools.runCommand('add_geojson_data', {
      name: 'sf-demo',
      data: DEMO_GEOJSON,
      style: { 'circle-color': '#f08c00', 'line-color': '#e8590c' },
    });
  }, [mapEl, core]);

  return (
    <div className="flex w-full">
      <div className="flex shrink-0 flex-col overflow-hidden border-r bg-muted">
        {mapEl && (
          <GeoAgentPanel
            core={core}
            map={mapEl}
            title="GeoAgent"
            locale={locale}
            collapsed={false}
            showCollapseButton={false}
          />
        )}
      </div>
      <arcgis-map
        ref={mapElement}
        basemap="topo"
        center="-122.45, 37.79"
        zoom="11.5"
        className="relative min-w-0 flex-1"
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ExampleShell title={HOMEPAGE_I18N[locale].arcgisMapTitle}>
    <ArcGISMapExample />
  </ExampleShell>,
);
