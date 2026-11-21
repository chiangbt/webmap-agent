/**
 * GeoAgentTools — the engine-agnostic base of the agent tool layer.
 *
 * The base class owns everything the tools share across map engines: the
 * overlay registry, Style-Spec materialization bookkeeping, the GeoJSON /
 * cluster / choropleth builders, the Earth Engine commands, and the
 * `runCommand` entry point. It drives the map through a MapLibre-shaped
 * "surface" provided by each subclass:
 *
 * - `MapLibreAgentTools`   → the native maplibre-gl / mapbox-gl map itself
 * - `LeafletAgentTools`    → `LeafletMapShim` (see leaflet-engine.ts)
 * - `OpenLayersAgentTools` → `OpenLayersMapShim` (see openlayers-engine.ts)
 *
 * Engine differences live in the subclasses as overrides, not as runtime
 * kind checks: `engineTools()` (which extra Strands tools the model sees),
 * `executeEngineCommand()` (the WebGL-only commands on MapLibre; explicit
 * capability errors on the 2D engines), `createEngineMarker/Popup`, the
 * script-tool bindings, and namespace resolution.
 *
 * No static `maplibre-gl` value import lives here; the default engine's
 * namespace is loaded lazily by `MapLibreAgentTools.loadNamespace()`.
 */
import { tool, type JSONValue, type Tool } from "@strands-agents/sdk";
import type {
  FilterSpecification,
  LayerSpecification,
  Map as MapLibreMap,
  MapGeoJSONFeature,
  SourceSpecification,
  StyleSpecification,
} from "maplibre-gl";
import { z } from "zod";
import {
  buildGeeVisParams,
  EarthEngineService,
  parseBbox,
  type EarthEngineOptions,
} from "../earth-engine/earth-engine";

export type JsonObject = Record<string, unknown>;
export type BBox = [number, number, number, number];

interface GeoJsonLayerDefinition {
  id: string;
  suffix: string;
  type: "fill" | "line" | "circle";
  filter: unknown[];
  paint: JsonObject;
}

/**
 * The marker surface the tools drive. Both `maplibre-gl`'s and `mapbox-gl`'s
 * `Marker` satisfy it, so either engine's class can build one.
 */
export interface GeoAgentMarker {
  setLngLat(lngLat: [number, number]): GeoAgentMarker;
  addTo(map: unknown): GeoAgentMarker;
  setPopup(popup: unknown): GeoAgentMarker;
  getElement(): HTMLElement;
  remove(): unknown;
}

/** The popup surface the marker tool drives; again shared by both engines. */
export interface GeoAgentPopup {
  setText(text: string): GeoAgentPopup;
}

/**
 * The map library the host's map came from.
 *
 * Almost every tool stays on the Style Spec surface `maplibre-gl` and
 * `mapbox-gl` share, but four cannot: the marker tool builds the engine's
 * `Marker` and `Popup` (MapLibre's read `map._camera.transform` and throw on a
 * mapbox-gl map), `set_projection` and `get_map_state` speak the engine's
 * projection shape (`{ type }` on MapLibre, a name string / `{ name }` on
 * Mapbox), and `run_maplibre_script` hands user code the engine's namespace.
 * Naming the engine once is what keeps those four honest.
 *
 * Defaults to `maplibre-gl`. A host rendering with Mapbox GL JS passes
 * `{ kind: "mapbox", namespace: mapboxgl }`.
 */
/** The namespace shape the Style-Spec tools drive. */
export interface GeoAgentStyleSpecNamespace {
  Marker: new (options?: { color?: string }) => GeoAgentMarker;
  Popup: new (options?: Record<string, unknown>) => GeoAgentPopup;
  [key: string]: unknown;
}

export interface GeoAgentStyleSpecEngine {
  /** Which Style-Spec library {@link namespace} is. */
  kind: "maplibre" | "mapbox";
  /**
   * The library's own namespace. `Marker` and `Popup` are what the tools
   * construct; the whole object is what `run_maplibre_script` hands to
   * user-authored code, so it must be the real namespace, not a subset.
   *
   * Optional for `kind: "maplibre"`: when omitted, the package lazily imports
   * its own `maplibre-gl` dependency on the first tool call, so Leaflet and
   * OpenLayers hosts never load a WebGL library they do not use. Required at
   * runtime for `kind: "mapbox"` — this package never imports mapbox-gl.
   */
  namespace?: GeoAgentStyleSpecNamespace;
}

export interface GeoAgentLeafletEngine {
  kind: "leaflet";
  /**
   * The Leaflet factory object (`L` from `import L from "leaflet"`). The tools
   * run through a compatibility shim (see leaflet-engine.ts) that materializes
   * Style-Spec sources/layers as Leaflet layers; `run_maplibre_script` hands
   * user code the real Leaflet map and this namespace.
   */
  namespace: Record<string, unknown>;
}

export interface GeoAgentOpenLayersEngine {
  kind: "openlayers";
  /**
   * An object with the ol classes/helpers the shim needs (Feature, Point,
   * Overlay, VectorLayer, TileLayer, VectorSource, XYZ, GeoJSON, Style, Fill,
   * Stroke, CircleStyle, Text, fromLonLat, toLonLat, transformExtent). The
   * tools run through a compatibility shim (see openlayers-engine.ts) that
   * materializes Style-Spec sources/layers as OpenLayers layers;
   * `run_maplibre_script` hands user code the real ol Map and this namespace.
   */
  namespace: Record<string, unknown>;
}

export interface GeoAgentArcGISEngine {
  kind: "arcgis";
  /**
   * Which ArcGIS view the host passes: `"map"` (MapView, flat 2D — the
   * default) or `"scene"` (SceneView, a 3D globe). The shim adapts its camera
   * model per kind (zoom via scale, bearing via camera.heading, pitch via
   * camera.tilt on a scene); the system prompt describes the right geometry.
   */
  viewKind?: "map" | "scene";
  /**
   * An object with the ArcGIS Maps SDK classes the shim constructs
   * (WebTileLayer, FeatureLayer, Graphic, SimpleFillSymbol, SimpleLineSymbol,
   * SimpleMarkerSymbol, TextSymbol, PictureMarkerSymbol). The tools run
   * through a compatibility shim (see arcgis-engine.ts) that materializes
   * Style-Spec sources/layers as ArcGIS layers; `run_maplibre_script` hands
   * user code the real view and this namespace.
   */
  namespace: Record<string, unknown>;
}

export type GeoAgentMapEngine =
  | GeoAgentStyleSpecEngine
  | GeoAgentLeafletEngine
  | GeoAgentOpenLayersEngine
  | GeoAgentArcGISEngine;

/** One agent-managed map overlay; shared bookkeeping across engines. */
export interface Overlay {
  kind: "geojson" | "raster" | "basemap" | "marker" | "native" | "gee";
  name: string;
  sourceIds: string[];
  layerIds: string[];
  marker?: GeoAgentMarker;
  data?: GeoJSON.GeoJSON;
  url?: string;
  style?: JsonObject;
  attribution?: string;
  sourceSpecs?: Record<string, SourceSpecification>;
  layerSpecs?: Array<{ layer: LayerSpecification; beforeId?: string }>;
  terrain?: { source: string; exaggeration?: number };
  sky?: JsonObject;
  geeLayerName?: string;
}

export const DEFAULT_BASEMAPS: Record<string, string | StyleSpecification> = {
  liberty: "https://tiles.openfreemap.org/styles/liberty",
  positron: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  voyager: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
  demotiles: "https://demotiles.maplibre.org/style.json",
  openstreetmap: "osm",
  osm: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: [
          "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        attribution: "OpenStreetMap contributors",
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  },
};

const RASTER_BASEMAPS: Record<
  string,
  { name: string; url: string; attribution: string }
> = {
  google_satellite: {
    name: "Google Satellite",
    url: "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
    attribution: "Google",
  },
  google_hybrid: {
    name: "Google Hybrid",
    url: "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
    attribution: "Google",
  },
  esri_world_imagery: {
    name: "Esri World Imagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  },
};

const MAP_EVENT_TIMEOUT_MS = 8000;

export function numberArg(args: JsonObject, key: string): number {
  const value = args[key];
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`Expected numeric argument: ${key}`);
  }
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new Error(`Expected finite numeric argument: ${key}`);
  }
  return numberValue;
}

export function stringArg(
  args: JsonObject,
  key: string,
  fallback = "",
): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

export function objectArg(args: JsonObject, key: string): JsonObject {
  const value = args[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

export function slug(value: unknown): string {
  return (
    String(value || "layer")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "layer"
  );
}

export function extendBounds(
  bounds: BBox | null,
  coordinate: unknown,
): BBox | null {
  if (!Array.isArray(coordinate) || coordinate.length < 2) {
    return bounds;
  }
  const lon = Number(coordinate[0]);
  const lat = Number(coordinate[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return bounds;
  }
  if (!bounds) {
    return [lon, lat, lon, lat];
  }
  bounds[0] = Math.min(bounds[0], lon);
  bounds[1] = Math.min(bounds[1], lat);
  bounds[2] = Math.max(bounds[2], lon);
  bounds[3] = Math.max(bounds[3], lat);
  return bounds;
}

export function extendGeometryBounds(
  bounds: BBox | null,
  geometry: GeoJSON.Geometry | null | undefined,
): BBox | null {
  if (!geometry) {
    return bounds;
  }
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.reduce(
      (currentBounds, item) => extendGeometryBounds(currentBounds, item),
      bounds,
    );
  }
  const visit = (coordinates: unknown): void => {
    if (!Array.isArray(coordinates)) {
      return;
    }
    if (
      coordinates.length >= 2 &&
      typeof coordinates[0] === "number" &&
      typeof coordinates[1] === "number"
    ) {
      bounds = extendBounds(bounds, coordinates);
      return;
    }
    for (const item of coordinates) {
      visit(item);
    }
  };
  visit(geometry.coordinates);
  return bounds;
}

export function geoJsonBounds(
  geojson: GeoJSON.GeoJSON | undefined,
): BBox | null {
  if (!geojson) {
    return null;
  }
  if (Array.isArray(geojson.bbox) && geojson.bbox.length >= 4) {
    const dimension = geojson.bbox.length / 2;
    const bbox = [
      geojson.bbox[0],
      geojson.bbox[1],
      geojson.bbox[dimension],
      geojson.bbox[dimension + 1],
    ].map(Number);
    if (bbox.every(Number.isFinite)) {
      return bbox as BBox;
    }
  }
  if (geojson.type === "FeatureCollection") {
    return geojson.features.reduce(
      (currentBounds, feature) =>
        extendGeometryBounds(currentBounds, feature.geometry),
      null as BBox | null,
    );
  }
  if (geojson.type === "Feature") {
    return extendGeometryBounds(null, geojson.geometry);
  }
  return extendGeometryBounds(null, geojson);
}

function collectGeometryTypes(
  types: Set<GeoJSON.GeoJsonGeometryTypes>,
  geometry: GeoJSON.Geometry | null | undefined,
): Set<GeoJSON.GeoJsonGeometryTypes> {
  if (!geometry) {
    return types;
  }
  if (geometry.type === "GeometryCollection") {
    for (const item of geometry.geometries) {
      collectGeometryTypes(types, item);
    }
    return types;
  }
  types.add(geometry.type);
  return types;
}

export function geoJsonGeometryTypes(
  geojson: GeoJSON.GeoJSON | undefined,
): Set<GeoJSON.GeoJsonGeometryTypes> {
  const types = new Set<GeoJSON.GeoJsonGeometryTypes>();
  if (!geojson) {
    return types;
  }
  if (geojson.type === "FeatureCollection") {
    for (const feature of geojson.features) {
      collectGeometryTypes(types, feature.geometry);
    }
    return types;
  }
  if (geojson.type === "Feature") {
    return collectGeometryTypes(types, geojson.geometry);
  }
  return collectGeometryTypes(types, geojson);
}

export function geojsonLayerPaint(style: JsonObject): {
  fill: JsonObject;
  line: JsonObject;
  circle: JsonObject;
} {
  // Clamps defeat NaN (Math.min/max pass NaN through), so every numeric style
  // value falls back when it is not finite rather than poisoning the paint.
  const finiteOr = (value: unknown, fallback: number): number => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  };
  const clamp01 = (value: unknown, fallback: number): number =>
    Math.max(0, Math.min(1, finiteOr(value, fallback)));
  const color =
    stringArg(style, "color") || stringArg(style, "line-color") || "#1c7ed6";
  const fillColor = stringArg(
    style,
    "fill-color",
    stringArg(style, "fillColor", color),
  );
  const lineColor = stringArg(
    style,
    "line-color",
    stringArg(style, "lineColor", color),
  );
  const circleColor = stringArg(
    style,
    "circle-color",
    stringArg(style, "circleColor", color),
  );
  const opacity = style.opacity ?? style["fill-opacity"] ?? 0.35;
  return {
    fill: {
      "fill-color": fillColor,
      "fill-outline-color": lineColor,
      "fill-opacity": clamp01(opacity, 0.35),
    },
    line: {
      "line-color": lineColor,
      "line-width": finiteOr(style["line-width"] ?? style.lineWidth, 2),
    },
    circle: {
      "circle-color": circleColor,
      "circle-radius": finiteOr(style["circle-radius"] ?? style.radius, 6),
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1,
    },
  };
}

export function geojsonLayerDefs(
  baseId: string,
  paint: ReturnType<typeof geojsonLayerPaint>,
  geojson: GeoJSON.GeoJSON | undefined,
): GeoJsonLayerDefinition[] {
  const geometryTypes = geoJsonGeometryTypes(geojson);
  const hasKnownTypes = geometryTypes.size > 0;
  const hasPolygons =
    !hasKnownTypes ||
    geometryTypes.has("Polygon") ||
    geometryTypes.has("MultiPolygon");
  const hasLines =
    !hasKnownTypes ||
    geometryTypes.has("LineString") ||
    geometryTypes.has("MultiLineString");
  const hasPoints =
    !hasKnownTypes ||
    geometryTypes.has("Point") ||
    geometryTypes.has("MultiPoint");
  const layerDefs: GeoJsonLayerDefinition[] = [];
  if (hasPolygons) {
    layerDefs.push({
      id: `${baseId}-fill`,
      suffix: "-fill",
      type: "fill",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: paint.fill,
    });
  }
  if (hasLines) {
    layerDefs.push({
      id: `${baseId}-line`,
      suffix: "-line",
      type: "line",
      filter: ["==", ["geometry-type"], "LineString"],
      paint: paint.line,
    });
  }
  if (hasPoints) {
    layerDefs.push({
      id: `${baseId}-point`,
      suffix: "-point",
      type: "circle",
      filter: ["==", ["geometry-type"], "Point"],
      paint: paint.circle,
    });
  }
  return layerDefs;
}

export function toJsonValue(value: unknown): JSONValue {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JSONValue;
  } catch {
    return String(value);
  }
}

export interface GeoAgentToolsOptions {
  basemaps?: Record<string, string | StyleSpecification>;
  allowCodeExecution: () => boolean;
  allowDestructiveTools: () => boolean;
  earthEngine?: EarthEngineOptions;
  onStateDataChange?: (data: Record<string, unknown>) => void;
  /**
   * The map library `map` came from. Each subclass validates it; see
   * {@link GeoAgentMapEngine} and `createGeoAgentTools`.
   */
  mapEngine?: GeoAgentMapEngine;
}

/**
 * @deprecated Renamed to {@link GeoAgentToolsOptions}; kept as an alias for
 * existing imports.
 */
export type MapLibreAgentToolsOptions = GeoAgentToolsOptions;

/**
 * The engine-agnostic agent tool base. See the file header for how the
 * subclasses split the engine-specific surface.
 */
export abstract class GeoAgentTools {
  /** The MapLibre-shaped surface every shared command drives. */
  protected readonly map: MapLibreMap;
  private readonly basemaps: Record<string, string | StyleSpecification>;
  private readonly allowCodeExecution: () => boolean;
  private readonly allowDestructiveTools: () => boolean;
  private readonly onStateDataChange?: (data: Record<string, unknown>) => void;
  protected readonly overlays = new globalThis.Map<string, Overlay>();
  private readonly earthEngine?: EarthEngineService;
  protected readonly engine: GeoAgentMapEngine;
  /**
   * The engine namespace, resolved on the first command through the
   * subclass's `loadNamespace()` — host-injected on the shim engines, lazily
   * imported `maplibre-gl` on the default engine.
   */
  private resolvedNamespace?: GeoAgentStyleSpecNamespace;

  constructor(map: unknown, options: GeoAgentToolsOptions) {
    this.engine = this.resolveEngine(options.mapEngine);
    this.map = this.createSurface(map);
    this.basemaps = { ...DEFAULT_BASEMAPS, ...options.basemaps };
    this.allowCodeExecution = options.allowCodeExecution;
    this.allowDestructiveTools = options.allowDestructiveTools;
    this.onStateDataChange = options.onStateDataChange;
    if (options.earthEngine && options.earthEngine.enabled !== false) {
      this.earthEngine = new EarthEngineService(options.earthEngine);
      this.publishEarthEngineState();
    }
  }

  /* ------------------------------------------------------------ hooks */

  /** Validate (and default) the engine declaration for this subclass. */
  protected abstract resolveEngine(
    provided: GeoAgentMapEngine | undefined,
  ): GeoAgentMapEngine;

  /** Wrap the raw host map into the MapLibre-shaped command surface. */
  protected abstract createSurface(map: unknown): MapLibreMap;

  /** Provide the engine namespace (host-injected or lazily imported). */
  protected abstract loadNamespace():
    | Promise<GeoAgentStyleSpecNamespace>
    | GeoAgentStyleSpecNamespace;

  /** Human-readable engine name for schema text and result messages. */
  protected abstract engineDisplayName(): string;

  /** Binding name user scripts see for the engine namespace. */
  protected abstract scriptNamespaceName(): string;

  /** Description of the `run_maplibre_script` tool on this engine. */
  protected abstract scriptToolDescription(): string;

  /** Engine-specific Strands tools; empty on engines that add none. */
  protected abstract engineTools(): Tool[];

  /** Run a command only this engine understands; throw for the rest. */
  protected abstract executeEngineCommand(
    command: string,
    args: JsonObject,
  ): Promise<unknown>;

  /** The map object user scripts receive (the raw map on shim engines). */
  protected scriptMap(): MapLibreMap {
    return this.map;
  }

  /** Build the engine's own Marker for `add_marker`. */
  protected createEngineMarker(color: string): GeoAgentMarker {
    return new (this.requireNamespace().Marker)({ color });
  }

  /** Build the engine's own Popup for `add_marker`. */
  protected createEnginePopup(): GeoAgentPopup {
    return new (this.requireNamespace().Popup)();
  }

  /* -------------------------------------------------------- lifecycle */

  updateEarthEngineOptions(options: EarthEngineOptions): void {
    this.earthEngine?.updateOptions(options);
    this.publishEarthEngineState();
  }

  /**
   * Resolve the engine namespace before any command touches it. The default
   * MapLibre engine's `loadNamespace()` lazily imports `maplibre-gl` here —
   * the ONLY place this package loads it at runtime — so 2D-only hosts never
   * pay for a WebGL library.
   */
  protected async ensureEngineNamespace(): Promise<void> {
    if (this.resolvedNamespace) {
      return;
    }
    this.resolvedNamespace = await this.loadNamespace();
  }

  /** The resolved namespace; valid after `ensureEngineNamespace` has run. */
  protected requireNamespace(): GeoAgentStyleSpecNamespace {
    if (!this.resolvedNamespace) {
      throw new Error(
        "The map engine namespace is not resolved; drive the tools through runCommand.",
      );
    }
    return this.resolvedNamespace;
  }

  destroy(): void {
    this.clearOverlays();
  }

  createTools(): Tool[] {
    const optionalStyleSchema = z
      .record(z.string(), z.any())
      .optional()
      .describe("Optional MapLibre-compatible paint/style values.");
    const sourceSpecSchema = z
      .record(z.string(), z.any())
      .describe("MapLibre source specification.");
    const layerSpecSchema = z
      .record(z.string(), z.any())
      .describe("MapLibre layer specification.");
    const filterSchema = z
      .array(z.any())
      .nullable()
      .describe(
        "MapLibre filter expression, or null to clear the filter. Required.",
      );
    const cornerCoordinatesSchema = z
      .array(z.array(z.number()).length(2))
      .length(4)
      .describe(
        "Four image/video corner coordinates: top-left, top-right, bottom-right, bottom-left.",
      );
    const geeCommonLoadSchema = {
      asset_id: z.string().describe("Google Earth Engine asset id."),
      layer_name: z.string().optional(),
      asset_type: z
        .enum(["Image", "ImageCollection", "FeatureCollection"])
        .optional(),
      start_date: z.string().optional().describe("YYYY-MM-DD start date."),
      end_date: z.string().optional().describe("YYYY-MM-DD end date."),
      bbox: z.string().optional().describe("west,south,east,north in WGS84."),
      bounds_collection_asset_id: z.string().optional(),
      bounds_filter_property: z.string().optional(),
      bounds_filter_value: z.string().optional(),
      cloud_cover: z.number().optional(),
      cloud_property: z.string().optional(),
      reducer: z
        .enum(["mosaic", "median", "mean", "min", "max", "first", "mode"])
        .optional(),
      min_value: z.number().optional(),
      max_value: z.number().optional(),
      palette: z.string().optional(),
      clip_collection_asset_id: z.string().optional(),
      clip_filter_property: z.string().optional(),
      clip_filter_value: z.string().optional(),
      oauth_client_id: z.string().optional(),
      project_id: z.string().optional(),
    };
    const tools: Tool[] = [
      tool({
        name: "list_layers",
        description:
          "List layers currently present in the browser MapLibre map.",
        inputSchema: z.object({}),
        callback: () => this.runCommand("list_layers"),
      }),
      tool({
        name: "get_map_state",
        description:
          "Return the browser map camera state, bounds, pitch, bearing, and user layers.",
        inputSchema: z.object({}),
        callback: () => this.runCommand("get_map_state"),
      }),
      tool({
        name: "set_center",
        description:
          "Center the browser map on a latitude/longitude coordinate.",
        inputSchema: z.object({
          lat: z.number().describe("Latitude in decimal degrees."),
          lon: z.number().describe("Longitude in decimal degrees."),
          zoom: z.number().optional().describe("Optional zoom level."),
        }),
        callback: (input) => this.runCommand("set_center", input),
      }),
      tool({
        name: "fly_to",
        description:
          "Animate the browser map to a latitude/longitude coordinate.",
        inputSchema: z.object({
          lat: z.number().describe("Latitude in decimal degrees."),
          lon: z.number().describe("Longitude in decimal degrees."),
          zoom: z.number().optional().describe("Optional zoom level."),
        }),
        callback: (input) => this.runCommand("fly_to", input),
      }),
      tool({
        name: "set_zoom",
        description: "Set the browser map zoom level.",
        inputSchema: z.object({
          zoom: z.number().describe("MapLibre zoom level."),
        }),
        callback: (input) => this.runCommand("set_zoom", input),
      }),
      tool({
        name: "zoom_to_bounds",
        description:
          "Zoom the browser map to a west/south/east/north bounding box.",
        inputSchema: z.object({
          west: z.number(),
          south: z.number(),
          east: z.number(),
          north: z.number(),
        }),
        callback: (input) => this.runCommand("zoom_to_bounds", input),
      }),
      tool({
        name: "add_basemap",
        description:
          "Add a raster basemap, such as Google satellite imagery, beneath existing user overlays without replacing the current MapLibre style.",
        inputSchema: z.object({
          provider: z
            .enum(["google_satellite", "google_hybrid", "esri_world_imagery"])
            .optional()
            .describe("Known raster basemap provider."),
          url: z.string().optional().describe("Custom XYZ tile URL template."),
          name: z.string().optional().describe("Layer name."),
          attribution: z.string().optional(),
          opacity: z.number().min(0).max(1).optional(),
        }),
        callback: (input) => this.runCommand("add_basemap", input),
      }),
      tool({
        name: "change_basemap",
        description:
          "Replace the entire browser MapLibre style by URL or known style id. Prefer add_basemap for satellite imagery or raster background layers.",
        inputSchema: z.object({
          style: z.string().describe("Known style id or MapLibre style URL."),
        }),
        callback: (input) => this.runCommand("change_basemap", input),
      }),
      tool({
        name: "add_marker",
        description: "Add a marker to the browser map.",
        inputSchema: z.object({
          lat: z.number(),
          lon: z.number(),
          popup: z.string().optional(),
          tooltip: z.string().optional(),
          name: z.string().optional(),
          color: z.string().optional(),
        }),
        callback: (input) => this.runCommand("add_marker", input),
      }),
      tool({
        name: "add_geojson_data",
        description: "Add an in-memory GeoJSON object to the browser map.",
        inputSchema: z.object({
          data: z
            .any()
            .describe(
              "GeoJSON Feature, FeatureCollection, or Geometry object.",
            ),
          name: z.string().describe("Layer name."),
          style: optionalStyleSchema,
        }),
        callback: (input) => this.runCommand("add_geojson_data", input),
      }),
      tool({
        name: "add_vector_data",
        description: "Add a GeoJSON URL to the browser map.",
        inputSchema: z.object({
          url: z.string().url().describe("URL to a GeoJSON document."),
          name: z.string().describe("Layer name."),
          style: optionalStyleSchema,
        }),
        callback: (input) => this.runCommand("add_vector_data", input),
      }),
      tool({
        name: "add_xyz_tile_layer",
        description: "Add an XYZ raster tile layer to the browser map.",
        inputSchema: z.object({
          url: z.string().describe("XYZ tile URL template."),
          name: z.string().describe("Layer name."),
          attribution: z.string().optional(),
        }),
        callback: (input) => this.runCommand("add_xyz_tile_layer", input),
      }),
      tool({
        name: "add_map_source",
        description:
          "Add a native MapLibre source specification to the browser map.",
        inputSchema: z.object({
          source_id: z.string().describe("Source id to add."),
          source: sourceSpecSchema,
        }),
        callback: (input) => this.runCommand("add_map_source", input),
      }),
      tool({
        name: "remove_map_source",
        description:
          "Remove a native MapLibre source when no active layers depend on it.",
        inputSchema: z.object({
          source_id: z.string().describe("Source id to remove."),
        }),
        callback: (input) => this.runCommand("remove_map_source", input),
      }),
      tool({
        name: "add_map_layer",
        description:
          "Add a native MapLibre layer specification to the browser map.",
        inputSchema: z.object({
          layer: layerSpecSchema,
          before_id: z
            .string()
            .optional()
            .describe("Optional layer id to insert before."),
        }),
        callback: (input) => this.runCommand("add_map_layer", input),
      }),
      tool({
        name: "remove_map_layer",
        description: "Remove an arbitrary native MapLibre style layer.",
        inputSchema: z.object({
          layer_id: z.string().describe("Layer id to remove."),
        }),
        callback: (input) => this.runCommand("remove_map_layer", input),
      }),
      tool({
        name: "move_layer",
        description:
          "Move a MapLibre layer before another layer, or to the top if before_id is omitted.",
        inputSchema: z.object({
          layer_id: z.string(),
          before_id: z.string().optional(),
        }),
        callback: (input) => this.runCommand("move_layer", input),
      }),
      tool({
        name: "set_paint_property",
        description: "Set a MapLibre paint property on an existing layer.",
        inputSchema: z.object({
          layer_id: z.string(),
          property: z.string(),
          value: z.any(),
        }),
        callback: (input) => this.runCommand("set_paint_property", input),
      }),
      tool({
        name: "set_layout_property",
        description: "Set a MapLibre layout property on an existing layer.",
        inputSchema: z.object({
          layer_id: z.string(),
          property: z.string(),
          value: z.any(),
        }),
        callback: (input) => this.runCommand("set_layout_property", input),
      }),
      tool({
        name: "set_layer_filter",
        description:
          "Set or clear a MapLibre filter expression on an existing layer.",
        inputSchema: z.object({
          layer_id: z.string(),
          filter: filterSchema,
        }),
        callback: (input) => this.runCommand("set_layer_filter", input),
      }),
      tool({
        name: "update_geojson_source",
        description:
          "Update data for an existing GeoJSON source by source id or layer name.",
        inputSchema: z.object({
          source_id: z
            .string()
            .describe(
              "Exact source id, or a layer name whose source is {name}-source.",
            ),
          data: z.any().describe("GeoJSON data for the source."),
        }),
        callback: (input) => this.runCommand("update_geojson_source", input),
      }),
      tool({
        name: "query_source_features",
        description: "Query source features from a MapLibre source.",
        inputSchema: z.object({
          source_id: z.string(),
          source_layer: z.string().optional(),
          filter: z.array(z.any()).optional(),
        }),
        callback: (input) => this.runCommand("query_source_features", input),
      }),
      tool({
        name: "add_image_layer",
        description:
          "Add a georeferenced image overlay as a MapLibre image source and raster layer.",
        inputSchema: z.object({
          id: z
            .string()
            .optional()
            .describe("Layer id. Defaults to image-overlay."),
          url: z.string().url(),
          coordinates: cornerCoordinatesSchema,
          opacity: z.number().min(0).max(1).optional(),
        }),
        callback: (input) => this.runCommand("add_image_layer", input),
      }),
      tool({
        name: "add_cluster_layer",
        description:
          "Add a clustered GeoJSON point layer with cluster circles, count labels, and unclustered points.",
        inputSchema: z.object({
          data: z
            .any()
            .describe("GeoJSON FeatureCollection containing point features."),
          name: z.string(),
          cluster_radius: z.number().optional(),
          cluster_max_zoom: z.number().optional(),
          cluster_colors: z.array(z.string()).optional(),
          cluster_steps: z.array(z.number()).optional(),
          cluster_min_radius: z.number().optional(),
          cluster_max_radius: z.number().optional(),
          unclustered_color: z.string().optional(),
          unclustered_radius: z.number().optional(),
          show_cluster_count: z.boolean().optional(),
          fit_bounds: z.boolean().optional(),
        }),
        callback: (input) => this.runCommand("add_cluster_layer", input),
      }),
      tool({
        name: "add_choropleth_layer",
        description:
          "Add a polygon choropleth fill layer and outline layer from GeoJSON and a MapLibre color expression.",
        inputSchema: z.object({
          data: z
            .any()
            .describe("GeoJSON FeatureCollection containing polygon features."),
          name: z.string(),
          color_expression: z
            .array(z.any())
            .describe("MapLibre expression for fill-color."),
          fill_opacity: z.number().min(0).max(1).optional(),
          line_color: z.string().optional(),
          line_width: z.number().optional(),
          fit_bounds: z.boolean().optional(),
        }),
        callback: (input) => this.runCommand("add_choropleth_layer", input),
      }),
      tool({
        name: "set_layer_visibility",
        description: "Show or hide a browser map layer.",
        inputSchema: z.object({
          name: z.string().describe("Layer or overlay name."),
          visible: z.boolean(),
        }),
        callback: (input) => this.runCommand("set_layer_visibility", input),
      }),
      tool({
        name: "set_layer_opacity",
        description: "Set browser map layer opacity between 0 and 1.",
        inputSchema: z.object({
          name: z.string().describe("Layer or overlay name."),
          opacity: z.number().min(0).max(1),
        }),
        callback: (input) => this.runCommand("set_layer_opacity", input),
      }),
      tool({
        name: "query_rendered_features",
        description: "Query rendered features from the browser map.",
        inputSchema: z.object({
          layers: z.array(z.string()).optional(),
          x: z
            .number()
            .optional()
            .describe("Canvas x coordinate; defaults to map center."),
          y: z
            .number()
            .optional()
            .describe("Canvas y coordinate; defaults to map center."),
        }),
        callback: (input) => this.runCommand("query_rendered_features", input),
      }),
      tool({
        name: "remove_layer",
        description: "Remove a user-added layer from the browser map.",
        inputSchema: z.object({
          name: z.string().describe("User-added layer name."),
        }),
        callback: (input) => {
          this.requireDestructiveApproval("Layer removal");
          return this.runCommand("remove_layer", input);
        },
      }),
      tool({
        name: "clear_layers",
        description: "Remove all user-added layers from the browser map.",
        inputSchema: z.object({}),
        callback: () => {
          this.requireDestructiveApproval("Clearing layers");
          return this.runCommand("clear_layers");
        },
      }),
      // Engine-specific tools come from the subclass: the WebGL-only batch on
      // MapLibre/Mapbox, nothing on the 2D shim engines.
      ...this.engineTools(),
    ];

    if (this.allowCodeExecution()) {
      if (this.earthEngine) {
        tools.push(
          tool({
            name: "run_gee_javascript_snippet",
            description:
              "Run an Earth Engine JavaScript snippet (executed with new Function, not sandboxed) that adds one or more MapLibre raster tile layers.",
            inputSchema: z.object({
              code: z
                .string()
                .describe(
                  "JavaScript using ee plus Map.addLayer(...), addLayer(...), getEeLayer(name), and listEeLayers().",
                ),
              description: z.string().optional(),
            }),
            callback: (input) =>
              this.runCommand("run_gee_javascript_snippet", input),
          }),
        );
      }
      tools.push(this.scriptTool());
    }

    if (this.earthEngine) {
      tools.push(
        tool({
          name: "search_gee_datasets",
          description:
            "Search official and community Google Earth Engine data catalogs.",
          inputSchema: z.object({
            query: z.string().optional(),
            category: z.string().optional(),
            data_type: z.string().optional(),
            source: z.enum(["official", "community"]).optional(),
            max_results: z.number().optional(),
            include_community: z.boolean().optional(),
          }),
          callback: (input) => this.runCommand("search_gee_datasets", input),
        }),
        tool({
          name: "get_gee_dataset_info",
          description:
            "Return catalog metadata for a Google Earth Engine asset id.",
          inputSchema: z.object({
            asset_id: z.string(),
            include_community: z.boolean().optional(),
          }),
          callback: (input) => this.runCommand("get_gee_dataset_info", input),
        }),
        tool({
          name: "summarize_gee_catalog",
          description: "Summarize Earth Engine catalog counts by category.",
          inputSchema: z.object({
            include_community: z.boolean().optional(),
          }),
          callback: (input) => this.runCommand("summarize_gee_catalog", input),
        }),
        tool({
          name: "initialize_earth_engine",
          description:
            "Authenticate and initialize Google Earth Engine with browser OAuth.",
          inputSchema: z.object({
            oauth_client_id: z.string().optional(),
            project_id: z.string().optional(),
            force: z.boolean().optional(),
          }),
          callback: (input) =>
            this.runCommand("initialize_earth_engine", input),
        }),
        tool({
          name: "load_gee_dataset",
          description:
            "Load a Google Earth Engine Image, ImageCollection, or FeatureCollection into the browser map as raster tiles.",
          inputSchema: z.object({
            ...geeCommonLoadSchema,
            bands: z.string().optional(),
            diagnose: z.boolean().optional(),
          }),
          callback: (input) => this.runCommand("load_gee_dataset", input),
        }),
        tool({
          name: "calculate_gee_normalized_difference",
          description:
            "Calculate and display an Earth Engine normalized difference index such as NDVI, NDWI, MNDWI, or NBR.",
          inputSchema: z.object({
            ...geeCommonLoadSchema,
            positive_band: z.string(),
            negative_band: z.string(),
            index_name: z.string().optional(),
          }),
          callback: (input) =>
            this.runCommand("calculate_gee_normalized_difference", input),
        }),
        tool({
          name: "list_loaded_gee_layers",
          description:
            "List Earth Engine layers registered by the browser GeoAgent.",
          inputSchema: z.object({}),
          callback: () => this.runCommand("list_loaded_gee_layers"),
        }),
        tool({
          name: "set_gee_layer_visualization",
          description:
            "Re-render a loaded Earth Engine layer with updated visualization parameters.",
          inputSchema: z.object({
            layer_name: z.string(),
            bands: z.string().optional(),
            min_value: z.number().optional(),
            max_value: z.number().optional(),
            palette: z.string().optional(),
            output_layer_name: z.string().optional(),
          }),
          callback: (input) =>
            this.runCommand("set_gee_layer_visualization", input),
        }),
        tool({
          name: "calculate_gee_layer_statistics",
          description:
            "Calculate bounded server-side statistics for a loaded Earth Engine image layer.",
          inputSchema: z.object({
            layer_name: z.string(),
            band: z.string().optional(),
            statistics: z.string().optional(),
            scale: z.number().optional(),
            max_pixels: z.number().optional(),
            best_effort: z.boolean().optional(),
            tile_scale: z.number().optional(),
            timeout_seconds: z.number().optional(),
            region_collection_asset_id: z.string().optional(),
            region_filter_property: z.string().optional(),
            region_filter_value: z.string().optional(),
          }),
          callback: (input) =>
            this.runCommand("calculate_gee_layer_statistics", input),
        }),
      );
    }

    return tools;
  }

  /**
   * The `run_maplibre_script` schema, worded for the active engine: the
   * description and the `code` parameter name the real bindings user scripts
   * receive (map / namespace / helpers), so the model never writes
   * `maplibregl.Marker(...)` against a Leaflet map.
   */
  protected scriptTool(): Tool {
    return tool({
      name: "run_maplibre_script",
      description: this.scriptToolDescription(),
      inputSchema: z.object({
        code: z
          .string()
          .describe(
            `JavaScript code to execute against map, ${this.scriptNamespaceName()}, and helpers.`,
          ),
        description: z.string().optional(),
      }),
      callback: (input) => this.runCommand("run_maplibre_script", input),
    });
  }

  async runCommand(command: string, args: unknown = {}): Promise<JSONValue> {
    return toJsonValue(
      await this.executeCommand(command, (args ?? {}) as JsonObject),
    );
  }

  private async executeCommand(
    command: string,
    args: JsonObject = {},
  ): Promise<unknown> {
    await this.ensureEngineNamespace();
    await this.waitForMapIdle();

    if (command === "list_layers") {
      const styleLayers = (this.map.getStyle().layers ?? []).map((layer) => ({
        id: layer.id,
        type: layer.type,
        source: "source" in layer ? layer.source : null,
        visible: layer.layout?.visibility !== "none",
        user_added: this.isOverlayLayerId(layer.id),
      }));
      const markerLayers = Array.from(this.overlays.values())
        .filter((overlay) => overlay.kind === "marker")
        .map((overlay) => ({
          id: overlay.name,
          type: "marker",
          source: null,
          // Reflect the set_layer_visibility toggle instead of always true.
          visible: overlay.marker?.getElement().style.display !== "none",
          user_added: true,
        }));
      return [...styleLayers, ...markerLayers];
    }

    if (command === "get_map_state") {
      const center = this.map.getCenter();
      const bounds = this.map.getBounds();
      // Read both spellings: MapLibre reports `{ type }`, mapbox-gl `{ name }`.
      const projection = this.map.getProjection() as
        | { type?: string; name?: string }
        | undefined;
      return {
        center: [center.lng, center.lat],
        zoom: this.map.getZoom(),
        bearing: this.map.getBearing(),
        pitch: this.map.getPitch(),
        projection: projection?.type ?? projection?.name ?? "mercator",
        bounds: {
          west: bounds.getWest(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          north: bounds.getNorth(),
        },
        user_layers: Array.from(this.overlays.keys()),
      };
    }

    if (command === "set_center") {
      // zoom goes through the same finite-number validation as lat/lon, so a
      // bad value errors cleanly instead of handing the camera a NaN.
      const zoom = args.zoom == null ? this.map.getZoom() : numberArg(args, "zoom");
      this.map.jumpTo({
        center: [numberArg(args, "lon"), numberArg(args, "lat")],
        zoom,
      });
      return "Centered map.";
    }

    if (command === "fly_to") {
      const zoom = args.zoom == null ? this.map.getZoom() : numberArg(args, "zoom");
      this.map.flyTo({
        center: [numberArg(args, "lon"), numberArg(args, "lat")],
        zoom,
      });
      return "Moved map.";
    }

    if (command === "set_zoom") {
      this.map.setZoom(numberArg(args, "zoom"));
      return "Zoom updated.";
    }

    if (command === "zoom_to_bounds") {
      this.map.fitBounds(
        [
          [numberArg(args, "west"), numberArg(args, "south")],
          [numberArg(args, "east"), numberArg(args, "north")],
        ],
        { padding: 48, maxZoom: 16 },
      );
      return "Zoomed to bounds.";
    }

    if (command === "add_basemap") {
      const providerKey = stringArg(args, "provider")
        .trim()
        .toLowerCase();
      const provider = providerKey ? RASTER_BASEMAPS[providerKey] : undefined;
      const url = stringArg(args, "url") || provider?.url;
      if (!url) {
        throw new Error(
          "add_basemap requires provider or url. Known providers: google_satellite, google_hybrid, esri_world_imagery.",
        );
      }
      const name =
        stringArg(args, "name") ||
        provider?.name ||
        providerKey ||
        "Raster Basemap";
      await this.addBasemapOverlay({
        name,
        url,
        attribution: stringArg(args, "attribution") || provider?.attribution,
        opacity:
          args.opacity == null
            ? undefined
            : Math.max(0, Math.min(1, Number(args.opacity))),
      });
      return `Added basemap ${name}.`;
    }

    if (command === "change_basemap") {
      const rawStyle = stringArg(args, "style", "liberty").trim();
      let style = this.basemaps[rawStyle.toLowerCase()] ?? rawStyle;
      if (typeof style === "string" && this.basemaps[style]) {
        style = this.basemaps[style];
      }
      this.map.setStyle(style);
      const styleLoaded = await this.waitForMapEvent("style.load");
      if (!styleLoaded) {
        throw new Error(
          `Basemap change to ${rawStyle} timed out waiting for style.load.`,
        );
      }
      await this.restoreOverlaysAfterStyleChange();
      return `Basemap changed to ${rawStyle}.`;
    }

    if (command === "add_marker") {
      const name = this.addMarkerOverlay(args);
      return `Added marker ${name}.`;
    }

    if (command === "add_geojson_data") {
      await this.addGeoJsonOverlay({
        name: stringArg(args, "name", "geojson"),
        data: args.data as GeoJSON.GeoJSON,
        style: objectArg(args, "style"),
        zoomTo: true,
      });
      return `Added GeoJSON layer ${stringArg(args, "name", "geojson")}.`;
    }

    if (command === "add_vector_data") {
      await this.addGeoJsonOverlay({
        name: stringArg(args, "name", "vector-data"),
        url: stringArg(args, "url"),
        style: objectArg(args, "style"),
        zoomTo: true,
      });
      return `Added GeoJSON URL layer ${stringArg(args, "name", "vector-data")}.`;
    }

    if (command === "add_xyz_tile_layer") {
      await this.addRasterOverlay({
        name: stringArg(args, "name", "xyz-tiles"),
        url: stringArg(args, "url"),
        attribution: stringArg(args, "attribution"),
      });
      return `Added XYZ tile layer ${stringArg(args, "name", "xyz-tiles")}.`;
    }

    if (command === "add_map_source") {
      const sourceId = stringArg(args, "source_id");
      if (!sourceId) {
        throw new Error("add_map_source requires source_id.");
      }
      await this.addNativeOverlay({
        name: sourceId,
        sourceSpecs: {
          [sourceId]: objectArg(args, "source") as SourceSpecification,
        },
      });
      return `Added MapLibre source ${sourceId}.`;
    }

    if (command === "remove_map_source") {
      this.requireDestructiveApproval("Source removal");
      const sourceId = stringArg(args, "source_id");
      if (!sourceId) {
        throw new Error("remove_map_source requires source_id.");
      }
      const dependentLayers = this.layersUsingSource(sourceId);
      if (dependentLayers.length > 0) {
        throw new Error(
          `Cannot remove source ${sourceId}; active layers depend on it: ${dependentLayers.join(", ")}`,
        );
      }
      const overlayName = this.overlayNameForSource(sourceId);
      if (
        overlayName &&
        this.overlays.get(overlayName)?.terrain?.source === sourceId
      ) {
        this.removeOverlay(overlayName);
      } else {
        if (!this.map.getSource(sourceId)) {
          throw new Error(`Source not found: ${sourceId}`);
        }
        this.map.removeSource(sourceId);
        this.pruneOverlaySource(sourceId);
      }
      return `Removed MapLibre source ${sourceId}.`;
    }

    if (command === "add_map_layer") {
      const layer = objectArg(args, "layer") as LayerSpecification;
      if (!layer.id) {
        throw new Error("add_map_layer requires layer.id.");
      }
      const beforeId = stringArg(args, "before_id") || undefined;
      // Validate here so the agent gets an actionable error on every engine
      // (native MapLibre only logs an error event and silently skips).
      if (beforeId && !this.map.getLayer(beforeId)) {
        throw new Error(
          `Cannot add layer ${layer.id}; before_id not found: ${beforeId}`,
        );
      }
      await this.addNativeOverlay({
        name: layer.id,
        layerSpecs: [{ layer, beforeId }],
      });
      return `Added MapLibre layer ${layer.id}.`;
    }

    if (command === "remove_map_layer") {
      this.requireDestructiveApproval("Layer removal");
      const layerId = stringArg(args, "layer_id");
      if (!layerId) {
        throw new Error("remove_map_layer requires layer_id.");
      }
      if (!this.map.getLayer(layerId)) {
        throw new Error(`Layer not found: ${layerId}`);
      }
      this.map.removeLayer(layerId);
      this.pruneOverlayLayer(layerId);
      return `Removed MapLibre layer ${layerId}.`;
    }

    if (command === "move_layer") {
      const layerId = stringArg(args, "layer_id");
      const beforeId = stringArg(args, "before_id") || undefined;
      this.requireLayer(layerId);
      if (beforeId) {
        this.requireLayer(beforeId);
      }
      this.map.moveLayer(layerId, beforeId);
      this.updateOverlayLayerBeforeId(layerId, beforeId);
      return `Moved layer ${layerId}.`;
    }

    if (command === "set_paint_property") {
      const layerId = stringArg(args, "layer_id");
      const property = stringArg(args, "property");
      this.requireLayer(layerId);
      if (!property) {
        throw new Error("set_paint_property requires property.");
      }
      this.map.setPaintProperty(layerId, property, args.value);
      this.updateOverlayLayerSpec(layerId, (layer) => {
        layer.paint = {
          ...(layer.paint ?? {}),
          [property]: args.value,
        } as LayerSpecification["paint"];
      });
      return `Updated paint property ${property} on ${layerId}.`;
    }

    if (command === "set_layout_property") {
      const layerId = stringArg(args, "layer_id");
      const property = stringArg(args, "property");
      this.requireLayer(layerId);
      if (!property) {
        throw new Error("set_layout_property requires property.");
      }
      this.map.setLayoutProperty(layerId, property, args.value);
      this.updateOverlayLayerSpec(layerId, (layer) => {
        layer.layout = {
          ...(layer.layout ?? {}),
          [property]: args.value,
        } as LayerSpecification["layout"];
      });
      return `Updated layout property ${property} on ${layerId}.`;
    }

    if (command === "set_layer_filter") {
      const layerId = stringArg(args, "layer_id");
      this.requireLayer(layerId);
      if (!("filter" in args)) {
        throw new Error(
          "set_layer_filter requires filter (use null to clear).",
        );
      }
      const filter =
        args.filter === null ? null : (args.filter as FilterSpecification);
      this.map.setFilter(layerId, filter);
      this.updateOverlayLayerSpec(layerId, (layer) => {
        const mutableLayer = layer as LayerSpecification & {
          filter?: FilterSpecification;
        };
        if (filter == null) {
          delete mutableLayer.filter;
        } else {
          mutableLayer.filter = filter;
        }
      });
      return `Updated filter on ${layerId}.`;
    }

    if (command === "update_geojson_source") {
      const requestedSourceId = stringArg(args, "source_id");
      const sourceId = this.resolveGeoJsonSourceId(requestedSourceId);
      const source = this.map.getSource(sourceId) as {
        setData?: (data: GeoJSON.GeoJSON) => void;
      };
      if (!source?.setData) {
        throw new Error(
          `GeoJSON source not found or not updateable: ${requestedSourceId}`,
        );
      }
      source.setData(args.data as GeoJSON.GeoJSON);
      this.updateOverlaySourceSpec(sourceId, (sourceSpec) => {
        if (sourceSpec.type === "geojson") {
          (sourceSpec as { data?: unknown }).data = args.data;
        }
      });
      const overlay = this.overlayForSource(sourceId);
      if (overlay?.kind === "geojson") {
        overlay.data = args.data as GeoJSON.GeoJSON;
      }
      return `Updated GeoJSON source ${sourceId}.`;
    }

    if (command === "query_source_features") {
      const sourceId = stringArg(args, "source_id");
      if (!sourceId) {
        throw new Error("query_source_features requires source_id.");
      }
      const options: { sourceLayer?: string; filter?: FilterSpecification } =
        {};
      const sourceLayer = stringArg(args, "source_layer");
      if (sourceLayer) {
        options.sourceLayer = sourceLayer;
      }
      if (Array.isArray(args.filter)) {
        options.filter = args.filter as FilterSpecification;
      }
      return {
        type: "FeatureCollection",
        features: this.map
          .querySourceFeatures(sourceId, options)
          .map((feature) => ({
            type: "Feature",
            geometry: feature.geometry ?? null,
            properties: feature.properties ?? {},
            id: feature.id,
          })),
      };
    }

    if (command === "add_image_layer") {
      const id = slug(stringArg(args, "id", "image-overlay"));
      const url = stringArg(args, "url");
      const coordinates = this.cornerCoordinates(args.coordinates);
      const opacity = Math.max(0, Math.min(1, Number(args.opacity ?? 1)));
      const sourceId = `${id}-source`;
      await this.addNativeOverlay({
        name: id,
        sourceSpecs: {
          [sourceId]: {
            type: "image",
            url,
            coordinates,
          } as SourceSpecification,
        },
        layerSpecs: [
          {
            layer: {
              id,
              type: "raster",
              source: sourceId,
              paint: { "raster-opacity": opacity },
            } as LayerSpecification,
          },
        ],
      });
      return `Added image layer ${id}.`;
    }

    if (command === "add_cluster_layer") {
      await this.addClusterLayer(args);
      return `Added cluster layer ${stringArg(args, "name")}.`;
    }

    if (command === "add_choropleth_layer") {
      await this.addChoroplethLayer(args);
      return `Added choropleth layer ${stringArg(args, "name")}.`;
    }

    if (command === "set_layer_visibility") {
      const name = stringArg(args, "name");
      const overlay = this.overlays.get(name);
      const visibility = args.visible ? "visible" : "none";
      if (overlay) {
        // Markers have no style layers; toggle the marker element instead so
        // the tool does not claim success while the marker stays on screen.
        if (overlay.kind === "marker" && overlay.marker) {
          overlay.marker.getElement().style.display = args.visible ? "" : "none";
          return `Layer ${name} visibility updated.`;
        }
        for (const layerId of overlay.layerIds) {
          if (this.map.getLayer(layerId)) {
            this.map.setLayoutProperty(layerId, "visibility", visibility);
          }
        }
        return `Layer ${name} visibility updated.`;
      }
      if (this.map.getLayer(name)) {
        this.map.setLayoutProperty(name, "visibility", visibility);
        return `Layer ${name} visibility updated.`;
      }
      throw new Error(`Layer not found: ${name}`);
    }

    if (command === "set_layer_opacity") {
      const name = stringArg(args, "name");
      const opacity = Math.max(0, Math.min(1, numberArg(args, "opacity")));
      const overlay = this.overlays.get(name);
      const layerIds = overlay ? overlay.layerIds : [name];
      let changed = false;
      for (const layerId of layerIds) {
        const layer = this.map.getLayer(layerId);
        if (!layer) {
          continue;
        }
        const prop =
          layer.type === "raster"
            ? "raster-opacity"
            : layer.type === "fill"
              ? "fill-opacity"
              : layer.type === "line"
                ? "line-opacity"
                : layer.type === "circle"
                  ? "circle-opacity"
                  : null;
        if (prop) {
          this.map.setPaintProperty(layerId, prop, opacity);
          changed = true;
        }
      }
      if (!changed) {
        throw new Error(`Layer not found or opacity unsupported: ${name}`);
      }
      return `Layer ${name} opacity updated.`;
    }

    if (command === "query_rendered_features") {
      const canvas = this.map.getCanvas();
      const point: [number, number] =
        args.x == null || args.y == null
          ? [canvas.clientWidth / 2, canvas.clientHeight / 2]
          : [Number(args.x), Number(args.y)];
      const layers: string[] = [];
      if (Array.isArray(args.layers)) {
        for (const requested of args.layers) {
          const layerName = String(requested);
          const overlay = this.overlays.get(layerName);
          if (overlay) {
            layers.push(...overlay.layerIds);
          } else if (this.map.getLayer(layerName)) {
            layers.push(layerName);
          } else {
            // Unknown names must not degrade the query to a whole-map scan —
            // the model asked for specific layers and would otherwise get
            // unrelated results with no error.
            throw new Error(`Layer not found: ${layerName}`);
          }
        }
      }
      return this.map
        .queryRenderedFeatures(point, layers.length ? { layers } : {})
        .slice(0, 50)
        .map(this.serializableFeature);
    }

    if (command === "remove_layer") {
      const name = stringArg(args, "name");
      if (!this.removeOverlay(name)) {
        throw new Error(`User-added layer not found: ${name}`);
      }
      return `Removed layer ${name}.`;
    }

    if (command === "clear_layers") {
      this.clearOverlays();
      return "Cleared user-added layers.";
    }

    if (command === "search_gee_datasets") {
      return this.requireEarthEngine().searchDatasets({
        query: stringArg(args, "query"),
        category: stringArg(args, "category") || undefined,
        data_type: stringArg(args, "data_type") || undefined,
        source: stringArg(args, "source") || undefined,
        max_results: args.max_results == null ? undefined : Number(args.max_results),
        include_community:
          args.include_community == null ? undefined : Boolean(args.include_community),
      });
    }

    if (command === "get_gee_dataset_info") {
      const assetId = stringArg(args, "asset_id");
      if (!assetId) {
        throw new Error("get_gee_dataset_info requires asset_id.");
      }
      return this.requireEarthEngine().getDatasetInfo(
        assetId,
        args.include_community == null ? true : Boolean(args.include_community),
      );
    }

    if (command === "summarize_gee_catalog") {
      return this.requireEarthEngine().summarizeCatalog(
        args.include_community == null ? true : Boolean(args.include_community),
      );
    }

    if (command === "initialize_earth_engine") {
      const result = await this.requireEarthEngine().initialize({
        oauthClientId: stringArg(args, "oauth_client_id") || undefined,
        projectId: stringArg(args, "project_id") || undefined,
        force: Boolean(args.force),
      });
      this.publishEarthEngineState();
      return result;
    }

    if (command === "load_gee_dataset") {
      const layer = await this.requireEarthEngine().buildDatasetLayer(args);
      const tileUrl = await this.requireEarthEngine().getTileUrl(
        layer.eeObject as never,
        layer.vis_params,
      );
      await this.addGeeRasterOverlay({
        name: layer.layer_name,
        url: tileUrl,
      });
      this.requireEarthEngine().registerLayer({
        name: layer.layer_name,
        asset_id: layer.asset_id,
        asset_type: layer.asset_type,
        object_type: String(layer.asset_type),
        vis_params: layer.vis_params,
        tile_url: tileUrl,
        source: "earth_engine",
        metadata: {
          composite_method: layer.composite_method,
          requested_reducer: layer.requested_reducer,
          rendered_band: layer.rendered_band,
          bbox: layer.bbox,
          bounds: layer.bounds,
          clip: layer.clip,
        },
        eeObject: layer.eeObject,
      });
      if (layer.bbox) {
        this.zoomToGeoJsonBounds(layer.bbox as BBox);
      }
      this.publishEarthEngineState();
      return {
        success: true,
        asset_id: layer.asset_id,
        asset_type: layer.asset_type,
        layer_name: layer.layer_name,
        composite_method: layer.composite_method,
        requested_reducer: layer.requested_reducer,
        rendered_band: layer.rendered_band,
        diagnostics: layer.diagnostics,
        bbox: layer.bbox,
        bounds: layer.bounds,
        earth_engine_javascript_snippet: this.buildLoadGeeDatasetSnippet(args),
        vis_params: layer.vis_params,
        tile_url: tileUrl,
        clip: layer.clip,
      };
    }

    if (command === "calculate_gee_normalized_difference") {
      const layer = await this.requireEarthEngine().buildNormalizedDifferenceLayer(
        args,
      );
      const tileUrl = await this.requireEarthEngine().getTileUrl(
        layer.eeObject as never,
        layer.vis_params,
      );
      await this.addGeeRasterOverlay({
        name: layer.layer_name,
        url: tileUrl,
      });
      this.requireEarthEngine().registerLayer({
        name: layer.layer_name,
        asset_id: layer.asset_id,
        asset_type: layer.asset_type,
        object_type: "Image",
        vis_params: layer.vis_params,
        tile_url: tileUrl,
        source: "earth_engine",
        metadata: {
          index_name: layer.index_name,
          formula: layer.formula,
          bands: layer.bands,
          composite_method: layer.composite_method,
          requested_reducer: layer.requested_reducer,
          bbox: layer.bbox,
          bounds: layer.bounds,
          clip: layer.clip,
        },
        eeObject: layer.eeObject,
      });
      if (layer.bbox) {
        this.zoomToGeoJsonBounds(layer.bbox as BBox);
      }
      this.publishEarthEngineState();
      return {
        success: true,
        asset_id: layer.asset_id,
        asset_type: layer.asset_type,
        layer_name: layer.layer_name,
        index_name: layer.index_name,
        formula: layer.formula,
        bands: layer.bands,
        composite_method: layer.composite_method,
        requested_reducer: layer.requested_reducer,
        vis_params: layer.vis_params,
        bbox: layer.bbox,
        bounds: layer.bounds,
        tile_url: tileUrl,
        earth_engine_javascript_snippet: this.buildNormalizedDifferenceSnippet(args),
        clip: layer.clip,
      };
    }

    if (command === "list_loaded_gee_layers") {
      const layers = this.requireEarthEngine().listLoadedLayers();
      return { count: layers.length, layers };
    }

    if (command === "set_gee_layer_visualization") {
      const result = await this.requireEarthEngine().setLayerVisualization(args);
      await this.addGeeRasterOverlay({
        name: result.layer_name,
        url: result.tile_url,
      });
      this.requireEarthEngine().registerLayer({
        name: result.layer_name,
        object_type: "EarthEngineObject",
        vis_params: result.vis_params,
        tile_url: result.tile_url,
        source: "earth_engine",
        eeObject: result.eeObject,
      });
      if (result.source_layer_name !== result.layer_name) {
        this.requireEarthEngine().unregisterLayer(result.source_layer_name);
      }
      this.publishEarthEngineState();
      return {
        success: result.success,
        layer_name: result.layer_name,
        source_layer_name: result.source_layer_name,
        vis_params: result.vis_params,
        tile_url: result.tile_url,
      };
    }

    if (command === "calculate_gee_layer_statistics") {
      try {
        return await this.requireEarthEngine().calculateLayerStatistics(args);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          layer_name: stringArg(args, "layer_name"),
          band: stringArg(args, "band") || null,
          statistics: stringArg(args, "statistics", "mean"),
          scale: Number(args.scale ?? 1000),
          max_pixels: Number(args.max_pixels ?? 100000000),
          best_effort: args.best_effort !== false,
          tile_scale: Number(args.tile_scale ?? 4),
          timeout_seconds: Number(args.timeout_seconds ?? 60),
          hint:
            "For large regions, retry with a coarser scale such as 2000 or 5000 meters, or provide a smaller region.",
        };
      }
    }

    if (command === "run_gee_javascript_snippet") {
      if (!this.allowCodeExecution()) {
        throw new Error("Earth Engine JavaScript execution is disabled.");
      }
      const code = stringArg(args, "code").trim();
      const result = await this.requireEarthEngine().runSnippet(
        code,
        async (eeObject, visParams, name) => {
          const tileUrl = await this.requireEarthEngine().getTileUrl(
            eeObject as never,
            visParams,
          );
          await this.addGeeRasterOverlay({ name, url: tileUrl });
          this.requireEarthEngine().registerLayer({
            name,
            object_type:
              (eeObject as { constructor?: { name?: string } })?.constructor
                ?.name ?? typeof eeObject,
            vis_params: visParams,
            tile_url: tileUrl,
            source: "earth_engine",
            eeObject,
          });
        },
      );
      this.publishEarthEngineState();
      return { ...result, description: stringArg(args, "description") };
    }

    if (command === "run_maplibre_script") {
      if (!this.allowCodeExecution()) {
        throw new Error(
          `${this.engineDisplayName()} JavaScript execution is disabled.`,
        );
      }
      return this.runEngineScript(args);
    }

    // Anything else is engine-specific: the WebGL-only commands on
    // MapLibre/Mapbox, explicit capability errors on the 2D engines.
    return this.executeEngineCommand(command, args);
  }

  private waitForMapEvent(eventName: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        resolve(value);
      };
      const timeoutId = window.setTimeout(
        () => finish(false),
        MAP_EVENT_TIMEOUT_MS,
      );
      this.map.once(eventName, () => finish(true));
    });
  }

  private async waitForMapIdle(): Promise<void> {
    if (this.map.loaded()) {
      return;
    }
    await this.waitForMapEvent("idle");
  }

  private firstUserOverlayLayerId(excludingName?: string): string | undefined {
    for (const overlay of this.overlays.values()) {
      if (overlay.name === excludingName || overlay.kind === "basemap") {
        continue;
      }
      const layerId = overlay.layerIds.find((id) => this.map.getLayer(id));
      if (layerId) {
        return layerId;
      }
    }
    return undefined;
  }

  private uniqueSourceId(baseId: string): string {
    let sourceId = baseId;
    let index = 2;
    while (this.map.getSource(sourceId)) {
      sourceId = `${baseId}-${index}`;
      index += 1;
    }
    return sourceId;
  }

  private uniqueLayerBaseId(baseId: string, suffixes: string[]): string {
    let layerBaseId = baseId;
    let index = 2;
    while (
      suffixes.some((suffix) => this.map.getLayer(`${layerBaseId}${suffix}`))
    ) {
      layerBaseId = `${baseId}-${index}`;
      index += 1;
    }
    return layerBaseId;
  }

  private isOverlayLayerId(layerId: string): boolean {
    return Array.from(this.overlays.values()).some((overlay) =>
      overlay.layerIds.includes(layerId),
    );
  }

  private layerSourceId(layer: LayerSpecification): string | null {
    return "source" in layer && typeof layer.source === "string"
      ? layer.source
      : null;
  }

  private layersUsingSource(sourceId: string): string[] {
    return (this.map.getStyle().layers ?? [])
      .filter(
        (layer) => this.layerSourceId(layer as LayerSpecification) === sourceId,
      )
      .map((layer) => layer.id);
  }

  private overlayForSource(sourceId: string): Overlay | undefined {
    return Array.from(this.overlays.values()).find((overlay) =>
      overlay.sourceIds.includes(sourceId),
    );
  }

  private overlayNameForSource(sourceId: string): string | null {
    const entry = Array.from(this.overlays.entries()).find(([, overlay]) =>
      overlay.sourceIds.includes(sourceId),
    );
    return entry?.[0] ?? null;
  }

  private requireLayer(layerId: string): void {
    if (!layerId) {
      throw new Error("Layer id is required.");
    }
    if (!this.map.getLayer(layerId)) {
      throw new Error(`Layer not found: ${layerId}`);
    }
  }

  protected removeOverlay(name: string): boolean {
    const key = Array.from(this.overlays.keys()).find(
      (item) => item === name || slug(item) === slug(name),
    );
    if (!key) {
      return false;
    }
    const overlay = this.overlays.get(key);
    if (!overlay) {
      return false;
    }
    if (overlay.terrain) {
      this.clearTerrain();
    }
    if (overlay.sky) {
      this.clearSky();
    }
    for (const layerId of overlay.layerIds) {
      if (this.map.getLayer(layerId)) {
        this.map.removeLayer(layerId);
      }
    }
    for (const sourceId of overlay.sourceIds) {
      if (this.map.getSource(sourceId)) {
        this.map.removeSource(sourceId);
      }
    }
    overlay.marker?.remove();
    if (overlay.kind === "gee" && overlay.geeLayerName) {
      this.earthEngine?.unregisterLayer(overlay.geeLayerName);
      this.publishEarthEngineState();
    }
    this.overlays.delete(key);
    return true;
  }

  private pruneOverlayLayer(layerId: string): void {
    for (const [name, overlay] of Array.from(this.overlays.entries())) {
      const layerIndex = overlay.layerIds.indexOf(layerId);
      if (layerIndex >= 0) {
        overlay.layerIds.splice(layerIndex, 1);
      }
      if (overlay.layerSpecs) {
        overlay.layerSpecs = overlay.layerSpecs.filter(
          (entry) => entry.layer.id !== layerId,
        );
      }
      if (
        overlay.kind === "native" &&
        overlay.layerIds.length === 0 &&
        overlay.sourceIds.length === 0 &&
        !overlay.terrain &&
        !overlay.sky
      ) {
        this.overlays.delete(name);
      }
    }
  }

  private pruneOverlaySource(sourceId: string): void {
    for (const [name, overlay] of Array.from(this.overlays.entries())) {
      const sourceIndex = overlay.sourceIds.indexOf(sourceId);
      if (sourceIndex >= 0) {
        overlay.sourceIds.splice(sourceIndex, 1);
      }
      if (overlay.sourceSpecs) {
        delete overlay.sourceSpecs[sourceId];
      }
      if (
        overlay.kind === "native" &&
        overlay.layerIds.length === 0 &&
        overlay.sourceIds.length === 0 &&
        !overlay.terrain &&
        !overlay.sky
      ) {
        this.overlays.delete(name);
      }
    }
  }

  private updateOverlayLayerBeforeId(
    layerId: string,
    beforeId: string | undefined,
  ): void {
    for (const overlay of this.overlays.values()) {
      const entry = overlay.layerSpecs?.find(
        (item) => item.layer.id === layerId,
      );
      if (entry) {
        entry.beforeId = beforeId;
      }
    }
  }

  private updateOverlayLayerSpec(
    layerId: string,
    update: (layer: LayerSpecification) => void,
  ): void {
    for (const overlay of this.overlays.values()) {
      const entry = overlay.layerSpecs?.find(
        (item) => item.layer.id === layerId,
      );
      if (entry) {
        update(entry.layer);
      }
    }
  }

  private updateOverlaySourceSpec(
    sourceId: string,
    update: (source: SourceSpecification) => void,
  ): void {
    for (const overlay of this.overlays.values()) {
      const sourceSpec = overlay.sourceSpecs?.[sourceId];
      if (sourceSpec) {
        update(sourceSpec);
      }
    }
  }

  private clearOverlays(): void {
    for (const name of Array.from(this.overlays.keys())) {
      this.removeOverlay(name);
    }
  }

  private requireEarthEngine(): EarthEngineService {
    if (!this.earthEngine) {
      throw new Error(
        "Google Earth Engine tools are disabled. Pass earthEngine configuration when creating GeoAgentControl.",
      );
    }
    return this.earthEngine;
  }

  private publishEarthEngineState(): void {
    if (!this.earthEngine || !this.onStateDataChange) {
      return;
    }
    this.onStateDataChange({
      earthEngine: {
        enabled: true,
        initialized: this.earthEngine.initializedState,
        layerCount: this.earthEngine.listLoadedLayers().length,
      },
    });
  }

  private serializableFeature(feature: MapGeoJSONFeature): JsonObject {
    return {
      type: "Feature",
      geometry: feature.geometry ?? null,
      properties: feature.properties ?? {},
      layer: feature.layer
        ? {
            id: feature.layer.id,
            type: feature.layer.type,
            source: feature.layer.source,
          }
        : undefined,
    };
  }

  private async fetchGeoJson(url: string): Promise<GeoJSON.GeoJSON> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Could not fetch GeoJSON (${response.status}) from ${url}`,
      );
    }
    return (await response.json()) as GeoJSON.GeoJSON;
  }

  private zoomToGeoJsonBounds(bounds: BBox | null): boolean {
    if (!bounds) {
      return false;
    }
    const [west, south, east, north] = bounds;
    if (![west, south, east, north].every(Number.isFinite)) {
      return false;
    }
    if (west === east && south === north) {
      this.map.easeTo({
        center: [west, south],
        zoom: Math.max(this.map.getZoom(), 12),
      });
      return true;
    }
    this.map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 48, maxZoom: 16 },
    );
    return true;
  }

  private async addGeoJsonOverlay(overlay: {
    name: string;
    data?: GeoJSON.GeoJSON;
    url?: string;
    style?: JsonObject;
    zoomTo?: boolean;
  }): Promise<void> {
    await this.waitForMapIdle();
    this.removeOverlay(overlay.name);
    const sourceId = this.uniqueSourceId(`${slug(overlay.name)}-source`);
    const style = overlay.style ?? {};
    const paint = geojsonLayerPaint(style);
    let sourceData = overlay.data;
    if (!sourceData && overlay.url) {
      // Surfaced, not swallowed: a failed fetch here means MapLibre's own
      // fetch of the same URL will fail too, so the layer would render
      // nothing while the tool result claimed success.
      sourceData = await this.fetchGeoJson(overlay.url);
    }
    const initialLayerDefs = geojsonLayerDefs(
      slug(overlay.name),
      paint,
      sourceData,
    );
    const baseId = this.uniqueLayerBaseId(
      slug(overlay.name),
      initialLayerDefs.map((item) => item.suffix),
    );
    const layerDefs = geojsonLayerDefs(baseId, paint, sourceData);
    this.map.addSource(sourceId, {
      type: "geojson",
      data:
        sourceData ??
        overlay.url ??
        ({
          type: "FeatureCollection",
          features: [],
        } as GeoJSON.FeatureCollection),
    });
    for (const layer of layerDefs) {
      const { suffix: _suffix, ...layerDefinition } = layer;
      this.map.addLayer({
        ...layerDefinition,
        source: sourceId,
      } as LayerSpecification);
    }
    this.overlays.set(overlay.name, {
      kind: "geojson",
      name: overlay.name,
      data: overlay.data,
      url: overlay.url,
      style,
      sourceIds: [sourceId],
      layerIds: layerDefs.map((item) => item.id),
    });
    if (overlay.zoomTo) {
      this.zoomToGeoJsonBounds(geoJsonBounds(sourceData ?? overlay.data));
    }
  }

  private async addRasterOverlay(overlay: {
    name: string;
    url: string;
    attribution?: string;
  }): Promise<void> {
    await this.waitForMapIdle();
    this.removeOverlay(overlay.name);
    const sourceId = this.uniqueSourceId(`${slug(overlay.name)}-source`);
    const layerId = this.uniqueLayerBaseId(slug(overlay.name), [""]);
    this.map.addSource(sourceId, {
      type: "raster",
      tiles: [overlay.url],
      tileSize: 256,
      attribution: overlay.attribution ?? "",
    });
    this.map.addLayer({
      id: layerId,
      type: "raster",
      source: sourceId,
    });
    this.overlays.set(overlay.name, {
      kind: "raster",
      name: overlay.name,
      url: overlay.url,
      attribution: overlay.attribution,
      sourceIds: [sourceId],
      layerIds: [layerId],
    });
  }

  private async addBasemapOverlay(overlay: {
    name: string;
    url: string;
    attribution?: string;
    opacity?: number;
  }): Promise<void> {
    await this.waitForMapIdle();
    this.removeOverlay(overlay.name);
    const sourceId = this.uniqueSourceId(`${slug(overlay.name)}-source`);
    const layerId = this.uniqueLayerBaseId(slug(overlay.name), [""]);
    this.map.addSource(sourceId, {
      type: "raster",
      tiles: [overlay.url],
      tileSize: 256,
      attribution: overlay.attribution ?? "",
    });
    this.map.addLayer(
      {
        id: layerId,
        type: "raster",
        source: sourceId,
        paint: { "raster-opacity": overlay.opacity ?? 1 },
      },
      this.firstUserOverlayLayerId(overlay.name),
    );
    this.overlays.set(overlay.name, {
      kind: "basemap",
      name: overlay.name,
      url: overlay.url,
      attribution: overlay.attribution,
      style: { opacity: overlay.opacity ?? 1 },
      sourceIds: [sourceId],
      layerIds: [layerId],
    });
  }

  private async addGeeRasterOverlay(overlay: {
    name: string;
    url: string;
  }): Promise<void> {
    await this.waitForMapIdle();
    this.removeOverlay(overlay.name);
    const sourceId = this.uniqueSourceId(`${slug(overlay.name)}-source`);
    const layerId = this.uniqueLayerBaseId(slug(overlay.name), [""]);
    this.map.addSource(sourceId, {
      type: "raster",
      tiles: [overlay.url],
      tileSize: 256,
      attribution: "Google Earth Engine",
    });
    this.map.addLayer({
      id: layerId,
      type: "raster",
      source: sourceId,
      paint: { "raster-opacity": 1 },
    });
    this.overlays.set(overlay.name, {
      kind: "gee",
      name: overlay.name,
      url: overlay.url,
      attribution: "Google Earth Engine",
      sourceIds: [sourceId],
      layerIds: [layerId],
      geeLayerName: overlay.name,
    });
  }

  private cloneSpec<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  protected async addNativeOverlay(overlay: {
    name: string;
    sourceSpecs?: Record<string, SourceSpecification>;
    layerSpecs?: Array<{ layer: LayerSpecification; beforeId?: string }>;
    terrain?: { source: string; exaggeration?: number };
    sky?: JsonObject;
  }): Promise<void> {
    await this.waitForMapIdle();
    this.removeOverlay(overlay.name);
    const sourceSpecs = overlay.sourceSpecs
      ? this.cloneSpec(overlay.sourceSpecs)
      : undefined;
    const layerSpecs = overlay.layerSpecs
      ? this.cloneSpec(overlay.layerSpecs)
      : undefined;
    await this.replayNativeOverlay(
      {
        kind: "native",
        name: overlay.name,
        sourceIds: Object.keys(sourceSpecs ?? {}),
        layerIds: layerSpecs?.map((entry) => entry.layer.id) ?? [],
        sourceSpecs,
        layerSpecs,
        terrain: overlay.terrain,
        sky: overlay.sky,
      },
      false,
    );
  }

  private async replayNativeOverlay(
    overlay: Overlay,
    allowExisting = true,
  ): Promise<void> {
    await this.waitForMapIdle();
    for (const [sourceId, sourceSpec] of Object.entries(
      overlay.sourceSpecs ?? {},
    )) {
      if (this.map.getSource(sourceId)) {
        if (!allowExisting) {
          throw new Error(`Source already exists: ${sourceId}`);
        }
        continue;
      }
      this.map.addSource(sourceId, this.cloneSpec(sourceSpec));
    }
    for (const { layer, beforeId } of overlay.layerSpecs ?? []) {
      if (this.map.getLayer(layer.id)) {
        if (!allowExisting) {
          throw new Error(`Layer already exists: ${layer.id}`);
        }
        continue;
      }
      const sourceId = this.layerSourceId(layer);
      if (sourceId && !this.map.getSource(sourceId)) {
        throw new Error(
          `Cannot add layer ${layer.id}; source not found: ${sourceId}`,
        );
      }
      // A recorded beforeId may reference a layer of the previous style (the
      // replay path runs after change_basemap); drop it rather than losing
      // the overlay — on native MapLibre the add would silently no-op, and on
      // the shim engines it would throw and discard the whole overlay.
      const effectiveBeforeId =
        beforeId && this.map.getLayer(beforeId) ? beforeId : undefined;
      this.map.addLayer(this.cloneSpec(layer), effectiveBeforeId);
    }
    if (overlay.terrain) {
      this.setTerrain(overlay.terrain);
    }
    if (overlay.sky) {
      this.setSky(overlay.sky);
    }
    this.overlays.set(overlay.name, overlay);
  }

  private cornerCoordinates(
    value: unknown,
  ): [[number, number], [number, number], [number, number], [number, number]] {
    if (!Array.isArray(value) || value.length !== 4) {
      throw new Error("Expected exactly four corner coordinates.");
    }
    return value.map((coordinate) => {
      if (!Array.isArray(coordinate) || coordinate.length < 2) {
        throw new Error("Each corner coordinate must be [lon, lat].");
      }
      const lon = Number(coordinate[0]);
      const lat = Number(coordinate[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        throw new Error("Corner coordinates must be finite numbers.");
      }
      return [lon, lat] as [number, number];
    }) as [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ];
  }

  protected setTerrain(terrain: { source: string; exaggeration?: number }): void {
    this.map.setTerrain({
      source: terrain.source,
      exaggeration: terrain.exaggeration ?? 1,
    });
  }

  protected clearTerrain(): void {
    this.map.setTerrain(null);
  }

  protected setSky(sky: JsonObject): void {
    const mapWithSky = this.map as unknown as {
      setSky?: (sky: JsonObject) => void;
    };
    if (typeof mapWithSky.setSky !== "function") {
      throw new Error(
        // mapbox-gl has no setSky at all (it draws sky through a style layer),
        // so this is reachable on a Mapbox host as well as an old MapLibre.
        "Sky is not supported by this map engine.",
      );
    }
    mapWithSky.setSky(sky);
  }

  protected clearSky(): void {
    const mapWithSky = this.map as unknown as {
      setSky?: (sky: undefined) => void;
    };
    if (typeof mapWithSky.setSky !== "function") {
      throw new Error(
        // mapbox-gl has no setSky at all (it draws sky through a style layer),
        // so this is reachable on a Mapbox host as well as an old MapLibre.
        "Sky is not supported by this map engine.",
      );
    }
    mapWithSky.setSky(undefined);
  }

  private resolveGeoJsonSourceId(sourceId: string): string {
    if (!sourceId) {
      throw new Error("update_geojson_source requires source_id.");
    }
    const exactSource = this.map.getSource(sourceId);
    if (exactSource) {
      return sourceId;
    }
    const suffixedSourceId = sourceId.endsWith("-source")
      ? sourceId
      : `${sourceId}-source`;
    if (this.map.getSource(suffixedSourceId)) {
      return suffixedSourceId;
    }
    return sourceId;
  }

  private async addClusterLayer(args: JsonObject): Promise<void> {
    const name = stringArg(args, "name");
    if (!name) {
      throw new Error("add_cluster_layer requires name.");
    }
    const sourceId = `${slug(name)}-source`;
    const clusterLayerId = `${slug(name)}-clusters`;
    const countLayerId = `${slug(name)}-cluster-count`;
    const unclusteredLayerId = `${slug(name)}-unclustered`;
    const clusterColors = Array.isArray(args.cluster_colors)
      ? args.cluster_colors.map(String)
      : ["#51bbd6", "#f1f075", "#f28cb1"];
    const clusterSteps = Array.isArray(args.cluster_steps)
      ? args.cluster_steps.map(Number).filter(Number.isFinite)
      : [100, 750];
    const clusterMinRadius = Number(args.cluster_min_radius ?? 15);
    const clusterMaxRadius = Number(args.cluster_max_radius ?? 30);
    const colorExpr: unknown[] = [
      "step",
      ["get", "point_count"],
      clusterColors[0] ?? "#51bbd6",
    ];
    for (let index = 0; index < clusterSteps.length; index += 1) {
      colorExpr.push(
        clusterSteps[index],
        clusterColors[index + 1] ?? clusterColors.at(-1) ?? "#f28cb1",
      );
    }
    const radiusExpr: unknown[] = [
      "step",
      ["get", "point_count"],
      clusterMinRadius,
    ];
    const radiusStep =
      clusterSteps.length > 0
        ? (clusterMaxRadius - clusterMinRadius) / clusterSteps.length
        : 0;
    for (let index = 0; index < clusterSteps.length; index += 1) {
      radiusExpr.push(
        clusterSteps[index],
        clusterMinRadius + radiusStep * (index + 1),
      );
    }
    const layerSpecs: Array<{ layer: LayerSpecification }> = [
      {
        layer: {
          id: clusterLayerId,
          type: "circle",
          source: sourceId,
          filter: ["has", "point_count"],
          paint: {
            "circle-color": colorExpr,
            "circle-radius": radiusExpr,
          },
        } as LayerSpecification,
      },
    ];
    if (args.show_cluster_count !== false) {
      layerSpecs.push({
        layer: {
          id: countLayerId,
          type: "symbol",
          source: sourceId,
          filter: ["has", "point_count"],
          layout: {
            "text-field": "{point_count_abbreviated}",
            "text-size": 12,
          },
          paint: {
            "text-color": "#ffffff",
          },
        } as LayerSpecification,
      });
    }
    layerSpecs.push({
      layer: {
        id: unclusteredLayerId,
        type: "circle",
        source: sourceId,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": stringArg(args, "unclustered_color", "#11b4da"),
          "circle-radius": Number(args.unclustered_radius ?? 8),
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
        },
      } as LayerSpecification,
    });
    await this.addNativeOverlay({
      name,
      sourceSpecs: {
        [sourceId]: {
          type: "geojson",
          data: args.data as GeoJSON.GeoJSON,
          cluster: true,
          clusterMaxZoom: Number(args.cluster_max_zoom ?? 14),
          clusterRadius: Number(args.cluster_radius ?? 50),
        } as SourceSpecification,
      },
      layerSpecs,
    });
    if (args.fit_bounds !== false) {
      this.zoomToGeoJsonBounds(geoJsonBounds(args.data as GeoJSON.GeoJSON));
    }
  }

  private async addChoroplethLayer(args: JsonObject): Promise<void> {
    const name = stringArg(args, "name");
    if (!name) {
      throw new Error("add_choropleth_layer requires name.");
    }
    if (!Array.isArray(args.color_expression)) {
      throw new Error("add_choropleth_layer requires color_expression.");
    }
    const sourceId = `${slug(name)}-source`;
    const fillLayerId = slug(name);
    const lineLayerId = `${slug(name)}-outline`;
    const fillOpacity = Math.max(
      0,
      Math.min(1, Number(args.fill_opacity ?? 0.7)),
    );
    await this.addNativeOverlay({
      name,
      sourceSpecs: {
        [sourceId]: {
          type: "geojson",
          data: args.data as GeoJSON.GeoJSON,
          generateId: true,
        } as SourceSpecification,
      },
      layerSpecs: [
        {
          layer: {
            id: fillLayerId,
            type: "fill",
            source: sourceId,
            paint: {
              "fill-color": args.color_expression,
              "fill-opacity": fillOpacity,
            },
          } as LayerSpecification,
        },
        {
          layer: {
            id: lineLayerId,
            type: "line",
            source: sourceId,
            paint: {
              "line-color": stringArg(args, "line_color", "#000000"),
              "line-width": Number(args.line_width ?? 1),
            },
          } as LayerSpecification,
        },
      ],
    });
    if (args.fit_bounds !== false) {
      this.zoomToGeoJsonBounds(geoJsonBounds(args.data as GeoJSON.GeoJSON));
    }
  }

  // Monotonic counter for default marker names. The overlay-map size would
  // collide (add three markers, remove the first, the next default name
  // would replace an existing marker).
  private markerSeq = 0;

  private addMarkerOverlay(args: JsonObject): string {
    const name = stringArg(args, "name", `marker-${(this.markerSeq += 1)}`);
    this.removeOverlay(name);
    // The marker is built by the engine subclass (createEngineMarker): the
    // host engine's own Marker class on MapLibre/Mapbox — MapLibre's Marker
    // reads `map._camera.transform` and throws on a mapbox-gl map — or the
    // shim's marker adapter on Leaflet/OpenLayers.
    const marker = this.createEngineMarker(
      stringArg(args, "color", "#3388ff"),
    )
      .setLngLat([numberArg(args, "lon"), numberArg(args, "lat")])
      .addTo(this.map);
    marker.getElement().title =
      stringArg(args, "tooltip") || stringArg(args, "popup") || name;
    const popup = stringArg(args, "popup");
    if (popup) {
      marker.setPopup(this.createEnginePopup().setText(popup));
    }
    this.overlays.set(name, {
      kind: "marker",
      name,
      marker,
      sourceIds: [],
      layerIds: [],
    });
    return name;
  }

  /**
   * Shared `run_maplibre_script` implementation. The engine subclasses supply
   * the bindings: `scriptMap()` (the raw map on shim engines), the namespace
   * name, and the resolved namespace object.
   */
  protected async runEngineScript(args: JsonObject): Promise<JsonObject> {
    const code = stringArg(args, "code").trim();
    if (!code) {
      throw new Error(
        `No ${this.engineDisplayName()} JavaScript code was provided.`,
      );
    }
    const description = stringArg(args, "description");
    const helpers = Object.freeze({
      overlayNames: () => Array.from(this.overlays.keys()),
      waitForMapIdle: () => this.waitForMapIdle(),
      slug,
      removeOverlay: (name: string) => {
        this.requireDestructiveApproval("Layer removal");
        return this.removeOverlay(name);
      },
      addGeoJsonOverlay: (overlay: {
        name: string;
        data?: GeoJSON.GeoJSON;
        url?: string;
        style?: JsonObject;
        zoomTo?: boolean;
      }) => this.addGeoJsonOverlay(overlay),
      addRasterOverlay: (overlay: {
        name: string;
        url: string;
        attribution?: string;
      }) => this.addRasterOverlay(overlay),
      addMarkerOverlay: (input: JsonObject) => this.addMarkerOverlay(input),
      serializeScriptResult: toJsonValue,
    });
    // The namespace binding is named after the engine actually drawing the
    // map (maplibregl / mapboxgl / L / ol), matching what the tool schema
    // tells the model is in scope.
    const namespaceName = this.scriptNamespaceName();
    const fn = new Function(
      "map",
      namespaceName,
      "helpers",
      `"use strict"; return (async () => {\n${code}\n})()`,
    ) as (
      map: MapLibreMap,
      mapEngineApi: GeoAgentStyleSpecNamespace,
      helpersArg: Record<string, unknown>,
    ) => Promise<unknown>;
    // Hand user code the engine actually drawing the map, so a script that
    // constructs a Marker or a LngLatBounds builds the right one. On a
    // Leaflet host that means the real L.Map plus the L namespace; on an
    // OpenLayers host the real ol/Map plus the ol namespace — user scripts
    // there write native engine code, not MapLibre code, and bypass the shim
    // registry (they ARE the escape hatch).
    const result = await fn(this.scriptMap(), this.requireNamespace(), helpers);
    return {
      success: true,
      message: description || `${this.engineDisplayName()} script executed.`,
      result: toJsonValue(result),
      description,
      maplibre_script: code,
    };
  }

  private buildLoadGeeDatasetSnippet(args: JsonObject): string {
    const assetId = stringArg(args, "asset_id");
    const assetType = stringArg(args, "asset_type", "Image");
    const visParams = buildGeeVisParams({
      bands: args.bands,
      min_value: args.min_value,
      max_value: args.max_value,
      palette: args.palette,
      forFeatureCollection: assetType === "FeatureCollection",
    });
    const lines = [
      `const assetId = ${JSON.stringify(assetId)};`,
      `let layer = ee.${assetType || "Image"}(assetId);`,
    ];
    if (assetType === "ImageCollection") {
      lines.push("let collection = ee.ImageCollection(assetId);");
      if (args.start_date || args.end_date) {
        lines.push(
          `collection = collection.filterDate(${JSON.stringify(args.start_date ?? null)}, ${JSON.stringify(args.end_date ?? null)});`,
        );
      }
      if (args.bbox) {
        const bbox = parseBbox(args.bbox);
        if (bbox) {
          lines.push(
            `collection = collection.filterBounds(ee.Geometry.Rectangle(${JSON.stringify(bbox)}));`,
          );
        }
      }
      const reducer = stringArg(args, "reducer", "mosaic");
      lines.push(
        reducer === "mosaic"
          ? "layer = collection.mosaic();"
          : reducer === "mode"
            ? "layer = collection.reduce(ee.Reducer.mode());"
            : `layer = collection.${reducer}();`,
      );
    }
    lines.push(
      `Map.addLayer(layer, ${JSON.stringify(visParams)}, ${JSON.stringify(stringArg(args, "layer_name", assetId.split("/").at(-1) ?? assetId))});`,
    );
    return lines.join("\n");
  }

  private buildNormalizedDifferenceSnippet(args: JsonObject): string {
    const assetId = stringArg(args, "asset_id");
    const indexName = stringArg(args, "index_name", "NDVI") || "ND";
    const positiveBand = stringArg(args, "positive_band");
    const negativeBand = stringArg(args, "negative_band");
    const visParams = buildGeeVisParams({
      bands: indexName,
      min_value: args.min_value ?? -1,
      max_value: args.max_value ?? 1,
      palette: args.palette,
    });
    return [
      `const assetId = ${JSON.stringify(assetId)};`,
      `const source = ee.Image(assetId);`,
      `const image = source.normalizedDifference([${JSON.stringify(positiveBand)}, ${JSON.stringify(negativeBand)}]).rename(${JSON.stringify(indexName)});`,
      `Map.addLayer(image, ${JSON.stringify(visParams)}, ${JSON.stringify(stringArg(args, "layer_name", `${assetId.split("/").at(-1) ?? assetId} ${indexName}`))});`,
    ].join("\n");
  }

  private async restoreOverlaysAfterStyleChange(): Promise<void> {
    const saved = Array.from(this.overlays.values()).map((overlay) => ({
      ...overlay,
    }));
    this.overlays.clear();
    for (const overlay of saved) {
      try {
        if (overlay.kind === "geojson") {
          await this.addGeoJsonOverlay({
            name: overlay.name,
            data: overlay.data,
            url: overlay.url,
            style: overlay.style,
          });
        } else if (overlay.kind === "raster" && overlay.url) {
          await this.addRasterOverlay({
            name: overlay.name,
            url: overlay.url,
            attribution: overlay.attribution,
          });
        } else if (overlay.kind === "basemap" && overlay.url) {
          await this.addBasemapOverlay({
            name: overlay.name,
            url: overlay.url,
            attribution: overlay.attribution,
            opacity: Number(overlay.style?.opacity ?? 1),
          });
        } else if (overlay.kind === "gee" && overlay.url) {
          await this.addGeeRasterOverlay({
            name: overlay.name,
            url: overlay.url,
          });
        } else if (overlay.kind === "marker" && overlay.marker) {
          overlay.marker.addTo(this.map);
          this.overlays.set(overlay.name, overlay);
        } else if (overlay.kind === "native") {
          await this.replayNativeOverlay(overlay);
        }
      } catch (error) {
        console.error(
          `Failed to restore overlay "${overlay.name}" after style change:`,
          error,
        );
      }
    }
  }

  private requireDestructiveApproval(action: string): void {
    if (!this.allowDestructiveTools()) {
      throw new Error(`${action} is disabled. Enable layer removal first.`);
    }
  }
}
