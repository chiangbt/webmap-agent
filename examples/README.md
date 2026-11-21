# Examples

**[English](README.md) | [简体中文](README.zh-CN.md)**

This directory contains example implementations of `web-geoagent`.
The examples add `maplibre-gl-layer-control` directly so the published
GeoAgent library does not depend on that optional UI control.

The demo site is a Vite multi-page React app styled with
[shadcn/ui](https://ui.shadcn.com) and Tailwind CSS 4: the homepage renders
shadcn cards and a language selector, and every example page shares the
`ExampleShell` chrome from `src/demo/example-shell.tsx` (back link, title,
GitHub link) with the map-specific logic kept verbatim per page. Shared demo
modules live in `src/demo/` (`demo.css`, `locale.ts`, `i18n.ts`, and the shadcn
components under `src/demo/components/ui/`). The npm library itself ships the
headless `GeoAgentCore` plus both the vanilla control and the shadcn/ui React
panel.

All examples use a side-by-side layout: the shadcn/ui `<GeoAgentPanel>` renders
directly into a left sidebar (no dock surgery — the panel fills its container),
and the map fills the remaining space. Leaflet and OpenLayers pass the same
`mapEngine` option as the vanilla control; the panel attaches the core to the
map on mount.

All examples follow the language chosen on the examples homepage: the
homepage's 中文/English dropdown persists the choice in `localStorage`
(`geoagent.locale`), and each page passes it to the Agent panel as the
`locale` option (`src/demo/locale.ts`).

## MapLibre GL Example

`GeoAgentPanel` driving a MapLibre map with the default (vanilla-style) tool
configuration, rendered from a React page entry (`main.tsx`). It enables
MapLibre JavaScript and layer removal by default while keeping the permission
checkboxes hidden. The map starts in globe projection at a global initial
extent (the whole globe in view on load, north-up), with the
`@geoql/maplibre-gl-starfield` skybox (an ESO Milky Way panorama, CC BY 4.0)
underneath the basemap; the GlobeControl / the agent's `set_projection` tool
switch to flat Mercator on demand.

```bash
pnpm dev
```

Open <http://localhost:5173/examples/basic/>.

## ArcGIS Map Example

An [`@arcgis/map-components`](https://developers.arcgis.com/javascript/latest/references/map-components/components/arcgis-map/)
`<arcgis-map>` web component (a MapView) driven by `ArcGISTools`. The page
creates a controlled `GeoAgentCore` with
`mapEngine: { kind: "arcgis", viewKind: "map", namespace }` and, once the
component's view is ready, seeds a small hand-made GeoJSON (district
polygons, a bus line, café points) **through the agent's own tool machinery**
(`tools.runCommand("add_geojson_data", ...)`), so the first prompt already has
agent-managed layers to query and restyle.

```bash
pnpm dev
```

Open <http://localhost:5173/examples/arcgis-map/>.

Readiness note for `@arcgis/map-components`: the web components have **no
`when()` method** — the element inherits the modern native
`EventTarget.prototype.when(type)`, which takes a required event name and has
nothing to do with view readiness. Await the exported
`waitForArcGISComponent(element)` instead; it resolves once the element
exposes its `.view` (via the `arcgisViewReadyChange` event, with a poll
fallback):

```javascript
import { waitForArcGISComponent } from 'web-geoagent';

const mapEl = document.querySelector('arcgis-map');
const view = await waitForArcGISComponent(mapEl);
addGeoAgentToArcGISMap(agent, mapEl, { position: 'top-left' });
```

## ArcGIS Scene Example

An `<arcgis-scene>` web component (a SceneView globe with `ground="world-elevation"`)
starting on a whole-globe view, driven by the same `ArcGISTools` with
`mapEngine: { kind: "arcgis", viewKind: "scene" }`. The shim adapts the camera
model for the scene — zoom goes through the view scale, bearing through
`camera.heading`, pitch through `camera.tilt`, and marker positioning uses the
view's exact `toScreen` projection. `screenshot_map` works here; the system
prompt describes the globe geometry up front.

```bash
pnpm dev
```

Open <http://localhost:5173/examples/arcgis-scene/>.

## Earth Engine Example

Google Earth Engine tools enabled via the panel's `earthEngine` option. Copy
`.env.example` to `.env` and set the Vite environment variables:

```bash
cp .env.example .env
```

```env
VITE_GEE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
# Optional default. Users can also enter their own project ID in the panel.
VITE_GEE_PROJECT_ID=
```

Then run:

```bash
pnpm dev
```

Open <http://localhost:5173/examples/earth-engine/>.

For a public deployment, configure `VITE_GEE_OAUTH_CLIENT_ID` at build time and
leave `VITE_GEE_PROJECT_ID` unset so each user can enter their own Earth
Engine-enabled Google Cloud project ID in the GeoAgent panel.

## MapLibre GL React Example

Same setup as the basic example — it demonstrates that the panel-driven demo
pages are all React. It uses the same default permission behavior as the basic
example.

```bash
pnpm dev
```

Open <http://localhost:5173/examples/react/>.

## Leaflet Example

The same agent tools running on a plain [Leaflet](https://leafletjs.com/)
map. The page passes `mapEngine: { kind: 'leaflet', namespace: L }` to
`GeoAgentPanel`, which attaches the core to the Leaflet map on mount. See
the "Running on Leaflet" section in the root README for the supported command
set.

```bash
pnpm dev
```

Open <http://localhost:5173/examples/leaflet/>.

## OpenLayers Example

The same agent tools running on a plain [OpenLayers](https://openlayers.org/)
map. It assembles the ol class namespace (`Feature`, `VectorLayer`, `GeoJSON`,
style classes, projection helpers) and passes
`mapEngine: { kind: 'openlayers', namespace }` to `GeoAgentPanel`. See the
"Running on OpenLayers" section in the root README for the supported command
set.

```bash
pnpm dev
```

Open <http://localhost:5173/examples/openlayers/>.

## Build

```bash
pnpm build:examples
```

The built examples are written to `dist-examples`.
