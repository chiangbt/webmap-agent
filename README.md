# web-geoagent

**[English](README.md) | [简体中文](README.zh-CN.md)**

A browser-only GeoAgent for web maps. The vanilla control implements
MapLibre's `IControl` interface and embeds a Strands TypeScript agent that can
inspect and operate on the live map through dedicated browser tools; the same
core also attaches to Leaflet and OpenLayers maps via compatibility shims.

[![npm version](https://img.shields.io/npm/v/web-geoagent.svg)](https://www.npmjs.com/package/web-geoagent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- Collapsible MapLibre control with a floating chat panel
- Browser provider UI for OpenAI Responses, OpenAI Chat, Anthropic, plus OpenAI-compatible and Anthropic-compatible custom endpoints
- API keys are saved on commit (Enter or blur) with an inline confirmation; provider errors are shown when a prompt is sent
- Provider, key, and model settings live in one collapsible section that folds away once configured; built-in providers default to their latest configured model, and the model can still be edited manually
- Map tools for camera movement, projection, basemaps, markers, GeoJSON, XYZ tiles, layer visibility, opacity, feature queries, screenshots, and layer cleanup
- Optional Google Earth Engine tools for catalog search, OAuth initialization, dataset tile layers, normalized difference indexes, visualization updates, snippets, and bounded statistics
- Optional MapLibre JavaScript execution tool, disabled by default
- Destructive layer removal tools gated behind a separate toggle
- Copy the visible conversation log as Markdown
- Headless `GeoAgentCore`, a shadcn/ui-styled React `GeoAgentPanel`, plus the classic React wrapper and state hook

## Installation

```bash
npm install web-geoagent maplibre-gl
```

## Vanilla Usage

```typescript
import maplibregl from "maplibre-gl";
import { GeoAgentControl } from "web-geoagent";
import "maplibre-gl/dist/maplibre-gl.css";
import "web-geoagent/style.css";

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/liberty",
  center: [-98.5795, 39.8283],
  zoom: 3,
  maxPitch: 85,
  canvasContextAttributes: { preserveDrawingBuffer: true },
});

map.on("load", () => {
  map.addControl(
    new GeoAgentControl({
      title: "GeoAgent",
      collapsed: false,
    }),
    "top-left",
  );
});
```

## React Usage

```tsx
import { useEffect, useRef, useState } from "react";
import maplibregl, { type Map } from "maplibre-gl";
import {
  GeoAgentControlReact,
  useGeoAgentState,
} from "web-geoagent/react";
import "maplibre-gl/dist/maplibre-gl.css";
import "web-geoagent/style.css";

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<Map | null>(null);
  const { state, setState } = useGeoAgentState({ collapsed: false });

  useEffect(() => {
    if (!mapContainer.current) return;

    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [-98.5795, 39.8283],
      zoom: 3,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });

    mapInstance.on("load", () => setMap(mapInstance));
    return () => mapInstance.remove();
  }, []);

  return (
    <>
      <div ref={mapContainer} style={{ width: "100vw", height: "100vh" }} />
      {map && (
        <GeoAgentControlReact
          map={map}
          title="GeoAgent"
          collapsed={state.collapsed}
          position="top-left"
          onStateChange={setState}
        />
      )}
    </>
  );
}
```

## React Panel (shadcn/ui)

`GeoAgentPanel` renders the whole chat UI as React components styled with
shadcn/ui + Tailwind CSS 4 (provider select, collapsible settings, conversation
log, prompt form). It is the panel used by the project's demo site. Render it
anywhere — a sidebar, a docked column, or a portal — and hand it the map; the
headless core is created and disposed for you:

```tsx
import { GeoAgentPanel } from "web-geoagent/react";
import "web-geoagent/style.css";

<GeoAgentPanel map={map} collapsed={false} title="GeoAgent" showCollapseButton={false} />;
```

For Leaflet/OpenLayers hosts, pass the same `mapEngine` option as the vanilla
control; the panel attaches to the map on mount and re-attaches when the map
instance changes. To control the lifecycle yourself, construct a
`GeoAgentCore` (exported from the main entry), call `core.attach(map)`, and pass
it via the `core` prop — the panel then never disposes it:

```tsx
import { GeoAgentCore } from "web-geoagent";
import { GeoAgentPanel } from "web-geoagent/react";

const core = new GeoAgentCore({ title: "GeoAgent", locale: "en" });
<GeoAgentPanel core={core} map={map} showCollapseButton={false} />;
```

Notes:

- `GeoAgentPanel` does not include floating positioning or drag-to-resize; it
  fills its container (default width 390px, override with `width`). The vanilla
  `GeoAgentControl` still provides the floating, resizable panel.
- Panel buttons are Send / Cancel / Copy Markdown. `GeoAgentCore`
  still exposes `clearConversation()` for hosts that want a clear affordance.
- Styles ship inside the package's single `web-geoagent/style.css`
  export: Tailwind utilities compiled without preflight (no global resets leak
  into your page) and design tokens under `--geoagent-*` prefixed variables.
- **Breaking change vs earlier releases:** `GeoAgentState.bedrockRegion` was
  removed together with the Google Gemini and Amazon Bedrock providers
  (`GeoAgentProviderId` now also includes `anthropic-compatible`), and the
  package was renamed from `maplibre-gl-geoagent` to `web-geoagent` — the
  default `storagePrefix` is now `web-geoagent`, so previously saved
  `geoagent.maplibre.*` sessionStorage keys are no longer read (users re-enter
  their API key once).

## Providers

Supported providers:

- OpenAI Responses
- OpenAI Chat
- Anthropic
- OpenAI-Compatible (Custom)
- Anthropic-Compatible (Custom)

For a custom or self-hosted model, select `OpenAI-Compatible (Custom)` or
`Anthropic-Compatible (Custom)`, enter the API base URL of the compatible
endpoint (for example a local LLM server, a private deployment, or a gateway),
supply the API key, and enter a model ID. OpenAI-compatible endpoints are called
with the OpenAI Chat Completions API shape (`https://host/v1`); the
Anthropic-compatible provider speaks the Anthropic Messages API
(`https://host`).

### Saving keys and models

The API key is written to `sessionStorage` only when you commit it (press Enter
or move focus out of the field), so a half-typed key never flips the status
badge to "Ready" or get written to storage.

Built-in providers use the latest model configured by the package:
`gpt-5.5` for OpenAI Responses and OpenAI Chat, and `claude-opus-4-8` for
Anthropic and Anthropic-Compatible. The "Use latest" button resets the model
field to that configured default without calling a provider model-list endpoint.
For `OpenAI-Compatible (Custom)`, there is no universal latest model, so enter
the model ID exposed by that endpoint.

### Language

Set the `locale` option to `'zh-CN'` to render every panel label, status badge,
button, and runtime message in Chinese; the default `'en'` keeps English. Brand
names and technical terms stay identical across locales. The examples homepage
provides a language dropdown that persists the choice in `localStorage`
(`geoagent.locale`), and every example page follows that choice — see
`src/demo/locale.ts`.

## Options

| Option                         | Type                                                           | Default               |
| ------------------------------ | -------------------------------------------------------------- | --------------------- |
| `collapsed`                    | `boolean`                                                      | `true`                |
| `position`                     | `'top-left' \| 'top-right' \| 'bottom-left' \| 'bottom-right'` | `'top-right'`         |
| `title`                        | `string`                                                       | `'GeoAgent'`          |
| `panelWidth`                   | `number`                                                       | `390`                 |
| `panelMinWidth`                | `number`                                                       | `320`                 |
| `panelMaxWidth`                | `number`                                                       | `720`                 |
| `className`                    | `string`                                                       | `''`                  |
| `locale`                       | `'en' \| 'zh-CN'`                                              | `'en'`                |
| `defaultProvider`              | `GeoAgentProviderId`                                           | `'openai-responses'`  |
| `defaultModel`                 | `string \| Partial<Record<GeoAgentProviderId, string>>`        | provider default      |
| `storagePrefix`                | `string`                                                       | `'web-geoagent'` |
| `apiKeys`                      | `Partial<Record<GeoAgentProviderId, string>>`                  | `undefined`           |
| `allowCodeExecutionDefault`    | `boolean`                                                      | `true`                |
| `allowDestructiveToolsDefault` | `boolean`                                                      | `true`                |
| `showPermissionToggles`        | `boolean`                                                      | `false`               |
| `basemaps`                     | `Record<string, string \| StyleSpecification>`                 | built-in basemaps     |
| `earthEngine`                  | `EarthEngineOptions`                                           | `undefined`           |
| `mapEngine`                    | `GeoAgentMapEngine`                                            | maplibre-gl           |

### Running on Mapbox GL JS

Almost every tool stays on the Style Spec surface `maplibre-gl` and `mapbox-gl`
share. Four cannot, and naming the engine once is what keeps them honest:

- `add_marker` builds the engine's `Marker` and `Popup` (MapLibre's read
  `map._camera.transform` and throw on a mapbox-gl map),
- `set_projection` writes MapLibre `{ type: 'globe' }` and Mapbox `'globe'`,
- `get_map_state` reads `{ type }` or `{ name }`,
- `run_maplibre_script` hands user-authored code the engine's own namespace.

```javascript
import mapboxgl from 'mapbox-gl';

const agent = new GeoAgentControl({
  mapEngine: { kind: 'mapbox', namespace: mapboxgl },
});

map.addControl(agent);
```

`namespace` must be the real library namespace, not a subset: `run_maplibre_script`
passes the whole object to the script it runs. Omit `mapEngine` and the tools use
this package's own `maplibre-gl`, exactly as before.

One tool stays MapLibre-only either way: `set_sky` / `clear_sky` call
`map.setSky`, which mapbox-gl does not have (it draws sky through a style
layer). It reports that rather than failing silently.

### Running on Leaflet

The same tools also run on a plain [Leaflet](https://leafletjs.com/) map.
Leaflet has no Style Spec, so the package ships a compatibility engine
(`leaflet-engine.ts`): a shim that presents the MapLibre map API on top of a
real `L.Map` and materializes Style-Spec sources/layers as Leaflet layers
(GeoJSON/vector layers per Style-Spec layer, tile layers for raster sources,
per-layer panes for z-order and visibility, an expression evaluator for
`["get", ...]`/`["step", ...]`/`["match", ...]` filters and paint, and greedy
pixel-grid clustering for `cluster: true` sources).

```javascript
import L from 'leaflet';
import { GeoAgentControl, addGeoAgentToLeafletMap } from 'web-geoagent';
import 'web-geoagent/dist/web-geoagent.css';
import 'leaflet/dist/leaflet.css';

const map = L.map('map').setView([39.8283, -98.5795], 4);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const agent = new GeoAgentControl({
  mapEngine: { kind: 'leaflet', namespace: L },
});

// Leaflet has no map.addControl slot for foreign controls, so mount it
// through the helper — it attaches to Leaflet's corner DOM and returns
// { remove() } for teardown.
addGeoAgentToLeafletMap(agent, map, { position: 'topleft' });
```

What works and what does not, by design:

- Camera (`set_center`, `fly_to`, `zoom_to_bounds`, `get_map_state`), all
  GeoJSON/raster/marker overlays, layer visibility/opacity, feature queries
  (`query_rendered_features` does pixel-accurate hit tests), basemap
  switching (named MapLibre styles resolve to raster tile URLs — vector
  styles cannot render in Leaflet), and `run_maplibre_script` (user code
  receives the real `L.Map` and the `L` namespace, so scripts there are
  Leaflet scripts).
- `set_projection` accepts `'mercator'` only (Leaflet is Web Mercator);
  `add_terrain`, `set_sky`/`clear_sky`, `fill-extrusion`/`heatmap` layers
  and `screenshot_map` report unsupported instead of failing silently.
- Earth Engine tiles load as plain XYZ raster overlays.

### Running on OpenLayers

The same tools also run on a plain [OpenLayers](https://openlayers.org/) map.
The package ships a second compatibility engine (`openlayers-engine.ts`): a
shim that presents the MapLibre map API on top of a real `ol/Map` and
materializes Style-Spec sources/layers as OpenLayers layers (one
`VectorLayer` per Style-Spec layer with a style function that evaluates
fill/line/circle/symbol paint and `["get", ...]`/`["step", ...]`/`["match", ...]`
filters, `TileLayer` + `XYZ` for raster sources, and greedy pixel-grid
clustering recomputed on `moveend` for `cluster: true` sources).

The library itself never imports `ol`, so the host assembles a small
namespace of ol classes once:

```javascript
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
import { GeoAgentControl, addGeoAgentToOpenLayersMap } from 'web-geoagent';
import 'web-geoagent/dist/web-geoagent.css';
import 'ol/ol.css';

const map = new Map({
  target: 'map',
  layers: [
    new TileLayer({
      source: new XYZ({ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' }),
    }),
  ],
  view: new View({ center: fromLonLat([-98.5795, 39.8283]), zoom: 4 }),
});

const agent = new GeoAgentControl({
  mapEngine: {
    kind: 'openlayers',
    namespace: {
      Feature, Point, Overlay, VectorLayer, TileLayer, VectorSource, XYZ,
      GeoJSON, Style, Fill, Stroke, CircleStyle, Text,
      fromLonLat, toLonLat, transformExtent,
    },
  },
});

// OpenLayers has no map.addControl slot for foreign controls, so mount it
// through the helper — it attaches to the map viewport and returns
// { remove() } for teardown.
addGeoAgentToOpenLayersMap(agent, map, { position: 'top-left' });
```

What works and what does not, by design:

- Camera (`set_center`, `fly_to`, `zoom_to_bounds`, `get_map_state`;
  bearing maps to the view rotation, pitch is always 0), all
  GeoJSON/raster/marker overlays (markers become `ol/Overlay` pins with
  click-to-open popups), layer visibility/opacity, feature queries
  (`query_rendered_features` does pixel-accurate hit tests, falling back to
  pure Web Mercator math before the first rendered frame), basemap
  switching (named MapLibre styles resolve to raster tile URLs), and
  `run_maplibre_script` (user code receives the real `ol/Map` and the
  namespace you supplied, so scripts there are OpenLayers scripts).
- `set_projection` accepts `'mercator'` only; `add_terrain`,
  `set_sky`/`clear_sky`, `fill-extrusion`/`heatmap` layers, vector tile
  sources and `screenshot_map` report unsupported instead of failing
  silently.
- Earth Engine tiles load as plain XYZ raster overlays.

### Earth Engine Options

```typescript
new GeoAgentControl({
  earthEngine: {
    oauthClientId: "YOUR_GOOGLE_OAUTH_CLIENT_ID",
    projectId: "your-earth-engine-project",
    includeCommunityCatalog: true,
  },
});
```

The Earth Engine integration uses browser OAuth through the official
`@google/earthengine` package. Service account private keys are intentionally
not supported in this browser-only package. Use a backend proxy if your
deployment needs service account access.

Host applications that already authenticate Earth Engine outside the browser
can provide a short-lived OAuth access token instead of launching browser
OAuth:

```typescript
new GeoAgentControl({
  earthEngine: {
    accessToken: "SHORT_LIVED_EARTH_ENGINE_ACCESS_TOKEN",
    tokenType: "Bearer",
    tokenExpiresIn: 3600,
    projectId: "your-earth-engine-project",
    includeCommunityCatalog: true,
  },
});
```

Access tokens are passed to the browser JavaScript runtime and should be
short-lived. Do not persist them in page source, notebooks, local storage, or
session storage. For untrusted users or production deployments, prefer a
backend proxy.

## Browser Credentials

This package runs model SDKs directly in the browser. API keys entered in the
panel are stored in `sessionStorage` under the configured `storagePrefix` and
are sent directly from the page to the selected model provider. Use this for
local development, trusted internal apps, or apps that intentionally expose a
browser-compatible credential path.

Host applications can prefill the panel with initial API keys:

```typescript
new GeoAgentControl({
  apiKeys: {
    "openai-responses": "OPENAI_API_KEY_VALUE",
    "openai-chat": "OPENAI_API_KEY_VALUE",
    anthropic: "ANTHROPIC_API_KEY_VALUE",
  },
});
```

Saved `sessionStorage` values take precedence over `apiKeys`. Initial keys are
kept in browser memory and are not written to storage unless the user edits the
API key field.

The MapLibre JavaScript tool and layer removal tools are enabled by default.
Their checkboxes are hidden by default; pass `showPermissionToggles: true` at
initialization time to let users turn them on or off in the panel. Disable either
capability at startup with `allowCodeExecutionDefault: false` or
`allowDestructiveToolsDefault: false`.

## Prompt Examples

```text
Add a red marker for San Francisco and zoom to it.
```

```text
Change the basemap to dark, then get the current map state.
```

```text
Add the GeoJSON URL https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json as US counties.
```

```text
Search Google Earth Engine for SRTM elevation datasets, then add the SRTM image with a terrain palette.
```

```text
Load Sentinel-2 surface reflectance for Knoxville in June 2024 and calculate NDVI using B8 and B4.
```

```text
Hide the US counties layer, then show it again.
```

```text
What features are visible at the center of the current map?
```

## API

- `GeoAgentControl` implements MapLibre `IControl`
- `GeoAgentControlReact` mounts and unmounts the control for React apps
- `useGeoAgentState` provides a small React state helper
- Types are exported for control options, state, providers, events, and React props

## Development

```bash
npm install
cp .env.example .env
npm run dev
npm test
npm run build
npm run build:examples
```

The demo site (homepage + examples) is a Vite multi-page React app styled
with shadcn/ui and Tailwind CSS 4; its source lives in `src/demo/` and
`examples/`. The published library itself stays framework-agnostic with its
own stylesheet and is not affected by the demo stack.

For the Earth Engine example, set `VITE_GEE_OAUTH_CLIENT_ID` in `.env`.
`VITE_GEE_PROJECT_ID` is optional; when it is omitted, users can enter their
own Earth Engine-enabled Google Cloud project ID in the GeoAgent panel.
