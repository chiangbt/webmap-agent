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

## Basic Example

`GeoAgentPanel` driving a MapLibre map with the default (vanilla-style) tool
configuration, rendered from a React page entry (`main.tsx`). It enables
MapLibre JavaScript and layer removal by default while keeping the permission
checkboxes hidden. The map starts in globe projection with the
`@geoql/maplibre-gl-starfield` skybox (an ESO Milky Way panorama, CC BY 4.0)
underneath the basemap.

```bash
npm run dev
```

Open <http://localhost:5173/examples/basic/>.

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
npm run dev
```

Open <http://localhost:5173/examples/earth-engine/>.

For a public deployment, configure `VITE_GEE_OAUTH_CLIENT_ID` at build time and
leave `VITE_GEE_PROJECT_ID` unset so each user can enter their own Earth
Engine-enabled Google Cloud project ID in the GeoAgent panel.

## React Example

Same setup as the basic example — it demonstrates that the panel-driven demo
pages are all React. It uses the same default permission behavior as the basic
example.

```bash
npm run dev
```

Open <http://localhost:5173/examples/react/>.

## Leaflet Example

The same agent tools running on a plain [Leaflet](https://leafletjs.com/)
map. The page passes `mapEngine: { kind: 'leaflet', namespace: L }` to
`GeoAgentPanel`, which attaches the core to the Leaflet map on mount. See
the "Running on Leaflet" section in the root README for the supported command
set.

```bash
npm run dev
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
npm run dev
```

Open <http://localhost:5173/examples/openlayers/>.

## Build

```bash
npm run build:examples
```

The built examples are written to `dist-examples`.
