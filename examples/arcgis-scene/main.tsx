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
  en: 'web-geoagent - ArcGIS Scene Example',
  zh: 'web-geoagent - ArcGIS Scene 示例',
  tw: 'web-geoagent - ArcGIS Scene 範例',
});

function ArcGISSceneExample() {
  const sceneElement = useRef<HTMLElement>(null);
  const [core] = useState(
    () =>
      new GeoAgentCore({
        collapsed: false,
        locale,
        defaultBaseUrl: llm.baseUrl,
        defaultApiKey: llm.apiKey,
        defaultModel: llm.model,
        // viewKind "scene": the shim drives the SceneView camera model
        // (zoom via scale, bearing via camera.heading, pitch via tilt).
        mapEngine: {
          kind: 'arcgis',
          viewKind: 'scene',
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
    const el = sceneElement.current;
    if (!el) return;
    let disposed = false;
    // The component's SceneView only exists after the component loads. Note:
    // these web components have no when() method — the element inherits the
    // native EventTarget.prototype.when(type), which needs an event name.
    void waitForArcGISComponent(el).then((view) => {
      if (disposed) {
        return;
      }
      // Global initial extent: the whole globe in view on load (the
      // attributes below already ask for this; assigning the camera keeps
      // the start view deterministic across SDK releases).
      view.camera = {
        position: { longitude: 10, latitude: 12, z: 20000000 },
        heading: 0,
        tilt: 0,
      };
      setMapEl(el);
    });
    return () => {
      disposed = true;
    };
  }, []);

  return (
    <div className="flex w-full">
      <div className="flex shrink-0 flex-col overflow-hidden border-r bg-muted">
        {mapEl && (
          <GeoAgentPanel
            core={core}
            map={mapEl}
            title="GeoAgent（ArcGIS SceneView）"
            locale={locale}
            collapsed={false}
            showCollapseButton={false}
          />
        )}
      </div>
      {/* A global 3D scene: satellite imagery over real world elevation. The
          agent's camera tools (fly_to, zoom_to_bounds, markers, screenshots)
          all drive this SceneView through the shim. */}
      <arcgis-scene
        ref={sceneElement}
        basemap="satellite"
        ground="world-elevation"
        camera-position="10, 12, 20000000"
        camera-heading="0"
        camera-tilt="0"
        className="relative min-w-0 flex-1"
      >
        {/* Zoom in/out buttons live in the view's UI at the requested slot;
            on a scene they step the camera distance in/out. */}
        <arcgis-zoom slot="top-right" />
      </arcgis-scene>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ExampleShell title={HOMEPAGE_I18N[locale].arcgisSceneTitle}>
    <ArcGISSceneExample />
  </ExampleShell>,
);
