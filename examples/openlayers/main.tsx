import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
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
import { GeoAgentPanel } from '@/react';
import { ExampleShell } from '@/demo/example-shell';
import { applyExamplePageLocale, resolveExamplesLocale } from '@/demo/locale';
import { HOMEPAGE_I18N } from '@/demo/i18n';
import '@/demo/demo.css';
import 'ol/ol.css';

// Follow the language chosen on the examples homepage (localStorage).
const locale = resolveExamplesLocale();
applyExamplePageLocale(locale, {
  en: 'web-geoagent - OpenLayers Example',
  zh: 'web-geoagent - OpenLayers 示例',
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

function OpenLayersExample() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<Map | null>(null);

  useEffect(() => {
    if (!mapContainer.current) return;

    // A plain OpenLayers map — no MapLibre anywhere. The GeoAgent tools run
    // through the openlayers-engine compatibility shim
    // (mapEngine: { kind: "openlayers" }).
    const mapInstance = new Map({
      target: mapContainer.current,
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
    setMap(mapInstance);

    return () => {
      mapInstance.setTarget(null);
    };
  }, []);

  return (
    <div className="flex w-full">
      <div className="flex shrink-0 flex-col overflow-hidden border-r bg-muted">
        {map && (
          <GeoAgentPanel
            map={map}
            title="GeoAgent (OpenLayers)"
            locale={locale}
            collapsed={false}
            showCollapseButton={false}
            // Tell the tools this map is OpenLayers and hand them the
            // namespace above.
            mapEngine={{
              kind: 'openlayers',
              namespace: openLayersNamespace as unknown as Record<string, unknown>,
            }}
          />
        )}
      </div>
      <div ref={mapContainer} className="relative min-w-0 flex-1" />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ExampleShell title={HOMEPAGE_I18N[locale].openlayersTitle}>
    <OpenLayersExample />
  </ExampleShell>,
);
