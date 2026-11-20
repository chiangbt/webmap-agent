# Examples

**[English](README.md) | [简体中文](README.zh-CN.md)**

This directory contains example implementations of `maplibre-gl-geoagent`.
The examples add `maplibre-gl-layer-control` directly so the published
GeoAgent library does not depend on that optional UI control.

All examples use a side-by-side layout: the GeoAgent panel is docked on the
left at 1/4 of the viewport width and the map fills the remaining space
(`examples/shared/dock-panel.ts` + `dock-panel.css`).

## Basic Example

A vanilla TypeScript example showing the `GeoAgentControl` added to a MapLibre map.
It enables MapLibre JavaScript and layer removal by default while keeping the
permission checkboxes hidden. The map starts in globe projection with the
`@geoql/maplibre-gl-starfield` skybox (an ESO Milky Way panorama, CC BY 4.0)
underneath the basemap.

```bash
npm run dev
```

Open <http://localhost:5173/examples/basic/>.

## Earth Engine Example

A vanilla TypeScript example with Google Earth Engine tools enabled. Copy
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

A React example demonstrating `GeoAgentControlReact` and `useGeoAgentState`.
It uses the same default permission behavior as the vanilla example.

```bash
npm run dev
```

Open <http://localhost:5173/examples/react/>.

## Leaflet Example

A vanilla TypeScript example running the same agent tools on a plain
[Leaflet](https://leafletjs.com/) map. It passes
`mapEngine: { kind: 'leaflet', namespace: L }` to `GeoAgentControl` and mounts
the control with `addGeoAgentToLeafletMap`. See the "Running on Leaflet"
section in the root README for the supported command set.

```bash
npm run dev
```

Open <http://localhost:5173/examples/leaflet/>.

## OpenLayers Example

A vanilla TypeScript example running the same agent tools on a plain
[OpenLayers](https://openlayers.org/) map. It assembles the ol class namespace
(`Feature`, `VectorLayer`, `GeoJSON`, style classes, projection helpers),
passes `mapEngine: { kind: 'openlayers', namespace }`, and mounts the control
with `addGeoAgentToOpenLayersMap`. See the "Running on OpenLayers" section in
the root README for the supported command set.

```bash
npm run dev
```

Open <http://localhost:5173/examples/openlayers/>.

## Build

```bash
npm run build:examples
```

The built examples are written to `dist-examples`.
