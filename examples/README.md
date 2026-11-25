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

The MapLibre GL basic example mounts a floating `GeoAgentControl` on the map.
The other examples render `<GeoAgentPanel>` in a left sidebar alongside the map.
Leaflet and OpenLayers specify their engine through the `mapEngine` option.
Without an engine configuration, `GeoAgentCore` and `GeoAgentPanel` use MapLibre.
TypeScript checks that the map matches the configured engine or supplied core.
The ArcGIS examples wait for their web component's view before attaching.

All examples follow the language chosen on the examples homepage: the
homepage's 中文/English dropdown persists the choice in `localStorage`
(`geoagent.locale`), and each page passes it to the Agent panel as the
`locale` option (`src/demo/locale.ts`).

## MapLibre GL Example

The example mounts `GeoAgentControl` with `map.addControl()` after the map loads.
The floating panel opens in the top-left corner and can be collapsed to the
map control button. MapLibre calls the control's cleanup when the map is removed.
The map starts in globe projection at a global initial
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
starts at the sample tile in Paris. The SDK's `VectorTileLayer` loads roads
and buildings from the OpenFreeMap `{z}/{x}/{y}.pbf` template and overlays
them on the satellite basemap. GeoAgent uses the same `ArcGISTools` with
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

The React example renders `<GeoAgentPanel map={map} />` in a left sidebar once
the map is ready. The panel binds itself to the map and fills the sidebar.

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
