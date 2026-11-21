/**
 * ArcGIS Maps SDK for JavaScript host support for the GeoAgent control.
 *
 * The GeoAgent tools drive the map through the MapLibre GL JS API surface:
 * Style Spec sources/layers, setStyle, queryRenderedFeatures, and friends.
 * The ArcGIS Maps SDK has a different object model entirely — a Map (with a
 * basemap and operational layers), a MapView with center/zoom/extent, and
 * renderers + symbols instead of a style document.
 *
 * ArcGISMapShim bridges the gap. It keeps a Style-Spec-like registry of
 * sources and layers, materializes them as real ArcGIS layers (raster XYZ as
 * WebTileLayer, GeoJSON as a client-side FeatureLayer whose graphics carry
 * per-feature symbols evaluated with the shared MapLibre-expression engine),
 * and exposes the subset of the maplibregl.Map API that the tools call.
 * Capabilities the ArcGIS MapView genuinely lacks (globe projection, terrain,
 * sky, fill-extrusion/heatmap/vector-tile/image sources) throw explicit
 * errors instead of failing silently — the same contract the other engines
 * document. What ArcGIS CAN do beyond the 2D shims (canvas screenshots via
 * `view.takeScreenshot`) is exposed as a real `screenshot_map` tool.
 *
 * Nothing here imports "@arcgis/*"; hosts pass their own namespace with the
 * handful of esri classes the shim constructs. The map handed to the control
 * is either a `MapView`/`SceneView` or an `@arcgis/map-components` element
 * (`<arcgis-map>` / `<arcgis-scene>`) whose `view` property is already set —
 * hosts can await {@link waitForArcGISComponent} for that.
 *
 *   import { GeoAgentControl, addGeoAgentToArcGISMap } from "web-geoagent";
 *   new GeoAgentControl({ mapEngine: { kind: "arcgis", namespace } });
 *   addGeoAgentToArcGISMap(control, view); // ArcGIS has no addControl slot
 */

import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoAgentControl } from "../control/GeoAgentControl";
import type { ExpressionContext, PixelProjector } from "./leaflet-engine";
import {
  colorValueFrom,
  computeClusteredFeatures,
  evaluateExpression,
  expressionTruthy,
  featureContextFor,
  hitTestFeature,
  normalizeFeatureCollection,
  normalizeGeometryType,
  numberValueFrom,
  resolveBasemapStyle,
  textFieldTextFrom,
} from "./leaflet-engine";

/* -------------------------------------------------------------------------- */
/* Structural ArcGIS types (the shim never imports "@arcgis/*" itself)        */
/* -------------------------------------------------------------------------- */

export interface ArcGISWatchHandle {
  remove(): void;
}

export interface ArcGISLayerLike {
  visible: boolean;
  opacity?: number;
  title?: string;
}

export interface ArcGISCollectionLike<T> {
  add(item: T, index?: number): unknown;
  remove(item: T): unknown;
  items?: T[];
  length?: number;
}

export interface ArcGISWebMapLike {
  layers: ArcGISCollectionLike<ArcGISLayerLike>;
  basemap?: unknown;
}

export interface ArcGISPointLike {
  longitude?: number;
  latitude?: number;
  x?: number;
  y?: number;
}

export interface ArcGISExtentLike {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  spatialReference?: {
    wkid?: number;
    isWebMercator?: boolean;
    isWGS84?: boolean;
  };
}

export interface ArcGISSpatialReferenceLike {
  isWebMercator?: boolean;
  isWGS84?: boolean;
  wkid?: number;
}

export interface ArcGISScreenshotLike {
  dataUrl?: string;
  data?: { width?: number; height?: number };
}

export interface ArcGISViewLike {
  container: HTMLElement;
  ready?: boolean;
  spatialReference?: ArcGISSpatialReferenceLike;
  center: ArcGISPointLike;
  zoom: number;
  rotation: number;
  extent: ArcGISExtentLike;
  size?: { width: number; height: number };
  map: ArcGISWebMapLike;
  goTo(target: unknown, options?: unknown): Promise<void> | void;
  when?(callback?: () => void, errback?: (error: unknown) => void): unknown;
  takeScreenshot?(options?: unknown): Promise<ArcGISScreenshotLike>;
  on(type: string, listener: (event?: unknown) => void): ArcGISWatchHandle;
  watch(
    property: string,
    listener: (newValue?: unknown, oldValue?: unknown) => void,
  ): ArcGISWatchHandle;
  /** SceneView-only: the camera model (position/heading/tilt). */
  camera?: {
    position?: { longitude?: number; latitude?: number; z?: number };
    heading?: number;
    tilt?: number;
  };
  /** SceneView-only: the map scale at the view center. */
  scale?: number;
  /** Sync screen projection (MapView and SceneView both expose it). */
  toScreen?(point: unknown, options?: unknown): { x: number; y: number };
}

/**
 * The `<arcgis-map>` / `<arcgis-scene>` component shape (@arcgis/map-components).
 * Note: these web components have no `when()` method of their own — the
 * element inherits the modern native `EventTarget.prototype.when(type)`, which
 * takes a REQUIRED event name and has nothing to do with view readiness. Use
 * {@link waitForArcGISComponent} to await the view.
 */
export interface ArcGISComponentLike {
  view?: ArcGISViewLike | null;
  map?: ArcGISWebMapLike;
}

/**
 * Resolve the MapView/SceneView behind an `@arcgis/map-components` element,
 * waiting (via the component's `arcgisViewReadyChange` event, with an interval
 * poll as a fallback) until the element exposes its `.view`. Resolves
 * immediately when the view is already present.
 */
export function waitForArcGISComponent(
  component: ArcGISComponentLike,
  timeoutMs = 30000,
): Promise<ArcGISViewLike> {
  const immediate = component.view;
  if (isArcGISView(immediate)) {
    return Promise.resolve(immediate);
  }
  return new Promise<ArcGISViewLike>((resolve, reject) => {
    const element = component as unknown as HTMLElement;
    const cleanup = (): void => {
      if (typeof element?.addEventListener === "function") {
        element.removeEventListener("arcgisViewReadyChange", onChange);
      }
      window.clearInterval(poll);
      window.clearTimeout(timer);
    };
    const onChange = (): void => {
      if (isArcGISView(component.view)) {
        cleanup();
        resolve(component.view);
      }
    };
    const poll = window.setInterval(onChange, 150);
    const timer = window.setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `The ArcGIS component did not expose its view within ${Math.round(timeoutMs / 1000)}s — the element may still be loading (network/authentication) or is not an @arcgis/map-components element.`,
        ),
      );
    }, timeoutMs);
    if (typeof element?.addEventListener === "function") {
      element.addEventListener("arcgisViewReadyChange", onChange);
    }
  });
}

/**
 * The pieces of the ArcGIS Maps SDK the shim constructs. Hosts assemble it
 * once:
 *
 *   import WebTileLayer from "@arcgis/core/layers/WebTileLayer";
 *   import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
 *   import Graphic from "@arcgis/core/Graphic";
 *   import SimpleFillSymbol from "@arcgis/core/symbols/SimpleFillSymbol";
 *   import SimpleLineSymbol from "@arcgis/core/symbols/SimpleLineSymbol";
 *   import SimpleMarkerSymbol from "@arcgis/core/symbols/SimpleMarkerSymbol";
 *   import TextSymbol from "@arcgis/core/symbols/TextSymbol";
 *   import PictureMarkerSymbol from "@arcgis/core/symbols/PictureMarkerSymbol";
 *
 *   const namespace = { WebTileLayer, FeatureLayer, Graphic, SimpleFillSymbol,
 *     SimpleLineSymbol, SimpleMarkerSymbol, TextSymbol, PictureMarkerSymbol };
 *
 * Geometries and extents are handed to the SDK as auto-cast plain objects, so
 * no geometry classes are required.
 */
export interface ArcGISNamespace {
  WebTileLayer: new (options?: Record<string, unknown>) => ArcGISLayerLike;
  FeatureLayer: new (options?: Record<string, unknown>) => ArcGISLayerLike;
  Graphic: new (options?: Record<string, unknown>) => unknown;
  SimpleFillSymbol: new (options?: Record<string, unknown>) => unknown;
  SimpleLineSymbol: new (options?: Record<string, unknown>) => unknown;
  SimpleMarkerSymbol: new (options?: Record<string, unknown>) => unknown;
  TextSymbol: new (options?: Record<string, unknown>) => unknown;
  PictureMarkerSymbol: new (options?: Record<string, unknown>) => unknown;
}

const REQUIRED_ARCGIS_KEYS: Array<keyof ArcGISNamespace> = [
  "WebTileLayer",
  "FeatureLayer",
  "Graphic",
  "SimpleFillSymbol",
  "SimpleLineSymbol",
  "SimpleMarkerSymbol",
  "TextSymbol",
  "PictureMarkerSymbol",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArcGISNamespace(
  namespace: Record<string, unknown>,
): ArcGISNamespace {
  const missing = REQUIRED_ARCGIS_KEYS.filter(
    (key) => namespace[key] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `mapEngine { kind: "arcgis" } needs a namespace with the ArcGIS Maps SDK classes: missing ${missing.join(", ")}. See the README's ArcGIS section for the full namespace object.`,
    );
  }
  return namespace as unknown as ArcGISNamespace;
}

/** Duck-type check: does this look like an ArcGIS MapView? */
export function isArcGISView(value: unknown): value is ArcGISViewLike {
  if (!isRecord(value)) {
    return false;
  }
  const candidate = value as unknown as ArcGISViewLike;
  return (
    typeof candidate.goTo === "function" &&
    isRecord(candidate.center) &&
    isRecord(candidate.map) &&
    isRecord(candidate.map.layers) &&
    typeof candidate.watch === "function" &&
    typeof candidate.on === "function"
  );
}

/**
 * ArcGIS SceneView detection (3D globe): only SceneViews expose a `camera`.
 * The shim adapts its camera model per kind — a MapView drives
 * center/zoom/rotation, a SceneView drives center/scale/camera.heading/tilt.
 */
export function isArcGISSceneView(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord((value as { camera?: unknown }).camera) &&
    typeof (value as { goTo?: unknown }).goTo === "function"
  );
}

/** Duck-type check: does this look like an `<arcgis-map>` component? */
export function isArcGISComponent(value: unknown): value is ArcGISComponentLike {
  return (
    isRecord(value) &&
    typeof (value as { when?: unknown }).when === "function" &&
    "view" in value
  );
}

/**
 * Resolve the MapView behind the value hosts hand to the control: a MapView
 * directly, or an `@arcgis/map-components` element whose `view` is set (the
 * view only exists after `await element.when()`).
 */
export function resolveArcGISView(value: unknown): ArcGISViewLike {
  if (isArcGISView(value)) {
    return value;
  }
  if (isArcGISComponent(value)) {
    const view = value.view;
    if (!isArcGISView(view)) {
      throw new Error(
        "The ArcGIS component's view is not ready yet. Pass the element only after its view exists (e.g. await waitForArcGISComponent(element)) or await the arcgisViewReadyChange event first.",
      );
    }
    return view;
  }
  throw new Error(
    'ArcGIS hosts must pass an ArcGIS Maps SDK MapView (or an <arcgis-map> element with a ready .view) as the map, with mapEngine { kind: "arcgis", namespace }.',
  );
}

/* -------------------------------------------------------------------------- */
/* Web Mercator + color helpers                                               */
/* -------------------------------------------------------------------------- */

const MERCATOR_RADIUS = 6378137;

/**
 * The standard Web Mercator scale at tile zoom 0 (meters-per-inch convention
 * used by the ArcGIS SDK), and the zoom↔scale ladder built on it. Used to
 * drive a SceneView's zoom through its `scale` property.
 */
const BASE_MAP_SCALE = 591657527.591555;

function zoomToScale(zoom: number): number {
  return BASE_MAP_SCALE / Math.pow(2, zoom);
}

function lonToMercatorX(lon: number): number {
  return (lon * Math.PI) / 180 * MERCATOR_RADIUS;
}

function latToMercatorY(lat: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return (
    MERCATOR_RADIUS *
    Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360))
  );
}

function mercatorXToLon(x: number): number {
  return (x / MERCATOR_RADIUS) * (180 / Math.PI);
}

function mercatorYToLat(y: number): number {
  return (2 * Math.atan(Math.exp(y / MERCATOR_RADIUS)) - Math.PI / 2) *
    (180 / Math.PI);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1, Math.max(0, value));
}

function sanitizeCssColor(value: string): string {
  // Only allow characters valid in a CSS color token; the value is embedded
  // into an inline SVG string.
  return /^#[0-9a-fA-F]{3,8}$|^[a-zA-Z]+$|^rgba?\([\d.,\s%]+\)$/.test(
    value.trim(),
  )
    ? value.trim()
    : "#3388ff";
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseCssColor(value: string): Rgba | null {
  const trimmed = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(trimmed);
  if (hex) {
    const digits = hex[1];
    const expand = (pair: string): number =>
      pair.length === 1 ? parseInt(pair.repeat(2), 16) : parseInt(pair, 16);
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits.slice(0, 1)),
        g: expand(digits.slice(1, 2)),
        b: expand(digits.slice(2, 3)),
        a: digits.length === 4 ? expand(digits.slice(3, 4)) / 255 : 1,
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: expand(digits.slice(0, 2)),
        g: expand(digits.slice(2, 4)),
        b: expand(digits.slice(4, 6)),
        a: digits.length === 8 ? expand(digits.slice(6, 8)) / 255 : 1,
      };
    }
    return null;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(trimmed);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter((part) => part.length > 0);
    const number = (part: string | undefined): number => {
      if (part === undefined) {
        return NaN;
      }
      return part.endsWith("%")
        ? (parseFloat(part) / 100) * 255
        : parseFloat(part);
    };
    const r = number(parts[0]);
    const g = number(parts[1]);
    const b = number(parts[2]);
    const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
    if ([r, g, b, a].some((value2) => !Number.isFinite(value2))) {
      return null;
    }
    return { r, g, b, a };
  }
  return null;
}

function withOpacity(color: string, opacity: number): string {
  const alpha = clamp01(Number.isFinite(opacity) ? opacity : 1);
  if (alpha >= 1) {
    return color;
  }
  const parsed = parseCssColor(color);
  if (!parsed) {
    return color;
  }
  const a = Math.round(parsed.a * alpha * 1000) / 1000;
  return `rgba(${Math.round(parsed.r)}, ${Math.round(parsed.g)}, ${Math.round(parsed.b)}, ${a})`;
}

/**
 * `change_basemap` names that map to real ArcGIS basemaps (set on
 * `map.basemap`) instead of an agent-managed XYZ layer. A few MapLibre style
 * aliases from DEFAULT_BASEMAPS map onto their closest ArcGIS basemap.
 */
const ARCGIS_BASEMAPS = new Set([
  "satellite",
  "hybrid",
  "topo",
  "terrain",
  "oceans",
  "osm",
  "streets",
  "gray",
  "dark-gray",
  "light-gray",
  "national-park",
  "community",
  "human-geometry",
  "chart-buffer",
  "colored-labels",
  "midcentury",
  "modern",
  "newspaper",
  "nova",
  "pastel",
  "hillshade",
]);

const ARCGIS_BASEMAP_ALIASES: Record<string, string> = {
  satellite: "satellite",
  google_satellite: "satellite",
  esri_world_imagery: "satellite",
  dark: "dark-gray",
  darkgray: "dark-gray",
  positron: "light-gray",
  light: "light-gray",
  voyager: "community",
  osm: "osm",
  openstreetmap: "osm",
  topo: "topo",
};

/* -------------------------------------------------------------------------- */
/* Source / layer registry                                                    */
/* -------------------------------------------------------------------------- */

const GEOJSON_LAYER_TYPES = ["fill", "line", "circle", "symbol"];

interface ArcGisShimLayer {
  id: string;
  type: string;
  source: string;
  spec: Record<string, unknown>;
  visible: boolean;
  esriLayer: ArcGISLayerLike | null;
}

class ArcGisShimSource {
  readonly id: string;
  readonly type: string;
  readonly cluster: boolean;
  readonly clusterRadius: number;
  readonly clusterMaxZoom: number;
  spec: Record<string, unknown>;
  data: GeoJSON.FeatureCollection = emptyFeatureCollection();
  private clusterCache: { zoom: number; features: GeoJSON.Feature[] } | null =
    null;
  private readonly shim: ArcGISMapShim;

  constructor(shim: ArcGISMapShim, id: string, spec: Record<string, unknown>) {
    this.shim = shim;
    this.id = id;
    this.spec = cloneJson(spec);
    this.type = String(spec.type ?? "unknown");
    this.cluster = this.type === "geojson" && Boolean(spec.cluster);
    this.clusterRadius = Number(spec.clusterRadius ?? 50);
    this.clusterMaxZoom = Number(spec.clusterMaxZoom ?? 14);
    if (this.type === "geojson") {
      const data = spec.data;
      if (typeof data === "string") {
        void shim
          .fetchGeoJson(data)
          .then((loaded) => this.setData(loaded))
          .catch((error: unknown) => {
            console.warn(
              `ArcGIS engine: could not load GeoJSON source "${id}":`,
              error,
            );
          });
      } else {
        this.data = normalizeFeatureCollection(data);
      }
    } else if (this.type === "raster") {
      const tiles = Array.isArray(spec.tiles) ? spec.tiles : [];
      if (typeof tiles[0] !== "string" || !tiles[0]) {
        throw new Error(
          `Raster source "${id}" needs a tiles URL template; the ArcGIS engine renders rasters as XYZ WebTileLayers.`,
        );
      }
    } else if (this.type === "raster-dem") {
      throw new Error(
        shim.isScene
          ? "SceneView terrain comes from the scene's ground ElevationLayers; raster-dem tile sources are not applicable to a scene."
          : "Terrain (raster-dem) is not supported by the ArcGIS engine's 2D MapView.",
      );
    } else if (this.type === "vector") {
      throw new Error(
        `Vector tile sources are not supported by the ArcGIS engine (source "${id}"). Vector basemaps and 3D buildings require maplibre-gl or mapbox-gl.`,
      );
    } else if (this.type === "image") {
      throw new Error(
        `Image sources are not supported by the ArcGIS engine (source "${id}"): MapView cannot warp a georeferenced image quad.`,
      );
    } else {
      throw new Error(
        `"${this.type}" sources are not supported by the ArcGIS engine (source "${id}").`,
      );
    }
  }

  setData(data: unknown): void {
    this.data = normalizeFeatureCollection(data);
    this.spec.data = data;
    this.clusterCache = null;
  }

  invalidateClusterCache(): void {
    this.clusterCache = null;
  }

  resolvedFeatures(): GeoJSON.Feature[] {
    if (!this.cluster) {
      return this.data.features;
    }
    const zoom = this.shim.getZoom();
    if (this.clusterCache && this.clusterCache.zoom === zoom) {
      return this.clusterCache.features;
    }
    const features =
      zoom >= this.clusterMaxZoom
        ? this.data.features
        : computeClusteredFeatures(
            this.data.features,
            this.clusterRadius,
            (lat, lng) => this.shim.projectPoint(lat, lng),
          );
    this.clusterCache = { zoom, features };
    return features;
  }
}

/* -------------------------------------------------------------------------- */
/* The shim                                                                   */
/* -------------------------------------------------------------------------- */

interface MarkerWrapper {
  element: HTMLElement;
  lngLat: [number, number] | null;
  popupElement: HTMLElement | null;
}

export class ArcGISMapShim {
  private readonly view: ArcGISViewLike;
  private readonly ns: ArcGISNamespace;
  private readonly sources = new Map<string, ArcGisShimSource>();
  private readonly layers = new Map<string, ArcGisShimLayer>();
  private layerOrder: string[] = [];
  private agentBaseLayer: ArcGISLayerLike | null = null;
  private readonly markers = new Set<MarkerWrapper>();
  private readonly watchHandles: ArcGISWatchHandle[] = [];
  private clickHandle: ArcGISWatchHandle | null = null;

  constructor(map: ArcGISViewLike, namespace: Record<string, unknown>) {
    this.view = map;
    this.ns = asArcGISNamespace(namespace);
    this.validateSpatialReference();
    this.injectShadowStyles();
    if (this.isScene) {
      // A SceneView navigates through the camera; watching it covers zoom
      // (scale), heading, tilt, and pan in one handler.
      this.watchHandles.push(
        map.watch("camera", () => {
          for (const source of this.sources.values()) {
            source.invalidateClusterCache();
          }
          this.syncVisibilityAll();
          this.syncMarkers();
        }),
      );
    } else {
      this.watchHandles.push(
        map.watch("zoom", () => {
          for (const source of this.sources.values()) {
            source.invalidateClusterCache();
          }
          this.syncVisibilityAll();
          this.syncMarkers();
        }),
      );
      this.watchHandles.push(
        map.watch("extent", () => this.syncMarkers()),
      );
      this.watchHandles.push(
        map.watch("rotation", () => this.syncMarkers()),
      );
    }
    this.clickHandle = map.on("click", () => this.hideMarkerPopups());
  }

  /**
   * Marker/popup elements live in `view.container`. On an
   * `@arcgis/map-components` host that container sits inside the component's
   * SHADOW ROOT, where the page stylesheet (geoagent-control.css) does not
   * reach — the popup would render as unstyled raw text. When the container
   * is inside a shadow root, inject a self-contained copy of the marker and
   * popup rules into that root; in the light DOM the page stylesheet already
   * applies and injection is skipped.
   */
  private injectShadowStyles(): void {
    const container = this.view.container;
    const root = container?.getRootNode?.() as
      | ShadowRoot
      | Document
      | null
      | undefined;
    if (!root || root === document) {
      return;
    }
    if (root.querySelector?.("style[data-geoagent-arcgis]")) {
      return;
    }
    const style = document.createElement("style");
    style.dataset.geoagentArcgis = "";
    style.textContent = `
.geoagent-arcgis-marker-icon { background: transparent; border: none; }
.geoagent-arcgis-marker-icon svg { display: block; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35)); cursor: pointer; }
.geoagent-arcgis-popup-content {
  background: #ffffff;
  border-radius: 8px;
  padding: 8px 12px;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #1f2933;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.25);
  max-width: 260px;
  white-space: pre-wrap;
}
`;
    root.appendChild(style);
  }

  getRawView(): ArcGISViewLike {
    return this.view;
  }

  getNamespace(): ArcGISNamespace {
    return this.ns;
  }

  /** Whether the wrapped view is a SceneView (3D globe) instead of a MapView. */
  get isScene(): boolean {
    return isArcGISSceneView(this.view);
  }

  /** The shim requires a Web Mercator or WGS84 view; fail honestly otherwise. */
  private validateSpatialReference(): void {
    const sr = this.view.spatialReference;
    if (!sr) {
      return;
    }
    const webMercator =
      sr.isWebMercator === true ||
      sr.wkid === 3857 ||
      sr.wkid === 102100;
    const wgs84 = sr.isWGS84 === true || sr.wkid === 4326;
    if (!webMercator && !wgs84) {
      throw new Error(
        `The ArcGIS engine reads Web Mercator (3857/102100) or WGS84 (4326) views; the view uses spatial reference ${sr.wkid ?? "unknown"}. Reproject the view or use a projected-basemap engine.`,
      );
    }
  }

  async fetchGeoJson(url: string): Promise<unknown> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Could not fetch GeoJSON (${response.status}) from ${url}`,
      );
    }
    return response.json();
  }

  /* ------------------------------ map basics ----------------------------- */

  getContainer(): HTMLElement {
    return this.view.container;
  }

  getCenter(): { lng: number; lat: number } {
    const center = this.view.center;
    if (
      typeof center?.longitude === "number" &&
      typeof center?.latitude === "number"
    ) {
      return { lng: center.longitude, lat: center.latitude };
    }
    // A projected center point (x/y in the view's spatial reference).
    if (typeof center?.x === "number" && typeof center?.y === "number") {
      const bounds = this.extentLonLatBounds(this.view.extent);
      return { lng: (bounds.west + bounds.east) / 2, lat: (bounds.south + bounds.north) / 2 };
    }
    return { lng: 0, lat: 0 };
  }

  getZoom(): number {
    if (this.isScene) {
      // SceneViews expose the map scale, not a tile zoom; convert through the
      // standard Web Mercator zoom↔scale ladder (zoom 0 = 591657527.59).
      const scale = Number(this.view.scale ?? 0);
      return scale > 0 ? Math.log2(BASE_MAP_SCALE / scale) : 0;
    }
    const zoom = this.view.zoom;
    return typeof zoom === "number" && Number.isFinite(zoom) ? zoom : 0;
  }

  getSize(): [number, number] {
    const size = this.view.size;
    if (size && size.width > 0 && size.height > 0) {
      return [size.width, size.height];
    }
    const width = this.view.container?.clientWidth ?? 0;
    const height = this.view.container?.clientHeight ?? 0;
    // Zero-size environments (jsdom, pre-layout) would make the pixel math
    // degenerate; fall back to a sane square so hit-testing keeps working.
    return [width > 0 ? width : 512, height > 0 ? height : 512];
  }

  /**
   * MapLibre bearing is clockwise from north. A SceneView's camera.heading is
   * the compass direction the camera faces (clockwise), so it maps directly;
   * a MapView's rotation is counter-clockwise and needs negating.
   */
  getBearing(): number {
    if (this.isScene) {
      const heading = Number(this.view.camera?.heading ?? 0);
      return ((heading % 360) + 360) % 360;
    }
    const rotation = Number(this.view.rotation ?? 0);
    return ((360 - rotation) % 360 + 360) % 360;
  }

  /**
   * MapLibre pitch is degrees off nadir; a SceneView's camera.tilt uses the
   * same convention. A flat MapView has no tilt.
   */
  getPitch(): number {
    if (this.isScene) {
      const tilt = Number(this.view.camera?.tilt ?? 0);
      return Number.isFinite(tilt) ? tilt : 0;
    }
    return 0;
  }

  loaded(): boolean {
    return this.view.ready !== false;
  }

  private extentLonLatBounds(extent: ArcGISExtentLike): {
    west: number;
    south: number;
    east: number;
    north: number;
  } {
    const sr = extent.spatialReference ?? this.view.spatialReference;
    const webMercator =
      sr?.isWebMercator === true || sr?.wkid === 3857 || sr?.wkid === 102100;
    const wgs84 = sr?.isWGS84 === true || sr?.wkid === 4326;
    let west = extent.xmin;
    let south = extent.ymin;
    let east = extent.xmax;
    let north = extent.ymax;
    if (webMercator) {
      west = mercatorXToLon(extent.xmin);
      south = mercatorYToLat(extent.ymin);
      east = mercatorXToLon(extent.xmax);
      north = mercatorYToLat(extent.ymax);
    } else if (!wgs84) {
      throw new Error(
        `The ArcGIS engine reads Web Mercator or WGS84 extents; got spatial reference ${String(sr?.wkid ?? "unknown")}.`,
      );
    }
    return { west, south, east, north };
  }

  /** MapLibre-compatible LngLatBounds-like: getWest()/getSouth()/... methods. */
  getBounds(): {
    getWest(): number;
    getSouth(): number;
    getEast(): number;
    getNorth(): number;
  } {
    const bounds = this.extentLonLatBounds(this.view.extent);
    return {
      getWest: () => bounds.west,
      getSouth: () => bounds.south,
      getEast: () => bounds.east,
      getNorth: () => bounds.north,
    };
  }

  /**
   * Screen-pixel projector for the current view. When the view exposes
   * `toScreen` (MapView and SceneView both do), use the SDK's exact
   * projection — mandatory for a tilted SceneView, where the extent-linear
   * math below would be wrong. Otherwise fall back to linear-in-Mercator
   * interpolation against the extent corners (pre-frame MapViews, mocks, or
   * when the auto-cast plain point is rejected). View rotation is not
   * compensated by the fallback (same limitation as the other shims).
   */
  projectPoint(lat: number, lng: number): { x: number; y: number } {
    if (typeof this.view.toScreen === "function") {
      try {
        const screen = this.view.toScreen({
          type: "point",
          longitude: lng,
          latitude: lat,
          spatialReference: { wkid: 4326 },
        }) as { x?: unknown; y?: unknown } | null | undefined;
        const x = Number(screen?.x);
        const y = Number(screen?.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          return { x, y };
        }
      } catch {
        // Plain-object auto-cast rejected → extent-linear fallback.
      }
    }
    const [width, height] = this.getSize();
    const bounds = this.extentLonLatBounds(this.view.extent);
    const westX = lonToMercatorX(bounds.west);
    const eastX = lonToMercatorX(bounds.east);
    const southY = latToMercatorY(bounds.south);
    const northY = latToMercatorY(bounds.north);
    const x = lonToMercatorX(lng);
    const y = latToMercatorY(lat);
    const spanX = eastX - westX;
    const spanY = northY - southY;
    const px = spanX !== 0 ? ((x - westX) / spanX) * width : 0;
    const py = spanY !== 0 ? ((northY - y) / spanY) * height : 0;
    return { x: px, y: py };
  }

  private screenProjector(): PixelProjector {
    return (coordinate) => this.projectPoint(coordinate[1], coordinate[0]);
  }

  jumpTo(options: { center?: [number, number]; zoom?: number }): void {
    if (options.center) {
      this.view.center = { longitude: options.center[0], latitude: options.center[1] };
    }
    if (options.zoom !== undefined && options.zoom !== null) {
      if (this.isScene) {
        this.view.scale = zoomToScale(Number(options.zoom));
      } else {
        this.view.zoom = Number(options.zoom);
      }
    }
    this.syncMarkers();
  }

  flyTo(options: { center?: [number, number]; zoom?: number }): void {
    this.animateTo(options, { duration: 1200 });
  }

  easeTo(options: { center?: [number, number]; zoom?: number }): void {
    this.animateTo(options, { duration: 300 });
  }

  private animateTo(
    options: { center?: [number, number]; zoom?: number },
    animOptions: Record<string, unknown>,
  ): void {
    const target: Record<string, unknown> = { ...animOptions };
    if (options.center) {
      target.center = [options.center[0], options.center[1]];
    }
    if (options.zoom !== undefined && options.zoom !== null) {
      target.zoom = Number(options.zoom);
    }
    void Promise.resolve(this.view.goTo(target)).catch(() => {
      // goTo rejects when the view is destroyed mid-flight; nothing to do.
    });
  }

  setZoom(zoom: number): void {
    if (this.isScene) {
      this.view.scale = zoomToScale(Number(zoom));
    } else {
      this.view.zoom = Number(zoom);
    }
    this.syncMarkers();
  }

  fitBounds(
    corners: [[number, number], [number, number]],
    options?: { padding?: number; maxZoom?: number },
  ): void {
    const [[west, south], [east, north]] = corners;
    // WGS84 extent; the SDK auto-casts and reprojects against the view.
    const extent = {
      xmin: west,
      ymin: south,
      xmax: east,
      ymax: north,
      spatialReference: { wkid: 4326 },
    };
    void Promise.resolve(this.view.goTo({ extent })).catch(() => {
      // Same fire-and-forget contract as flyTo.
    });
    // `padding`/`maxZoom` have no direct ArcGIS equivalent; the extent fit is
    // best-effort (noted in the engine capability prompt).
    void options;
  }

  getProjection(): { type: "mercator" } | { type: "globe" } {
    return this.isScene ? { type: "globe" } : { type: "mercator" };
  }

  setProjection(projection: unknown): void {
    const type =
      typeof projection === "string"
        ? projection
        : isRecord(projection)
          ? String(projection.type ?? "")
          : "";
    if (this.isScene) {
      if (type === "globe") {
        // A global SceneView already renders the globe.
        return;
      }
      throw new Error(
        `The ArcGIS SceneView renders a 3D globe; projection "${type || "unknown"}" is not applicable. A flat map requires an ArcGIS MapView or a maplibre-gl map.`,
      );
    }
    if (type !== "mercator") {
      throw new Error(
        `The ArcGIS engine's MapView renders Web Mercator only; projection "${type || "unknown"}" is not supported. Globe rendering requires maplibre-gl, mapbox-gl, or an ArcGIS SceneView.`,
      );
    }
  }

  /* ------------------------------- events -------------------------------- */

  on(type: string, listener: (event?: unknown) => void): this {
    this.view.on(type, listener);
    return this;
  }

  off(type: string, listener?: (event?: unknown) => void): this {
    // esri watch/on handles are removed explicitly; the shim only registers
    // its own listeners, so off() is a no-op for foreign listeners.
    void type;
    void listener;
    return this;
  }

  once(type: string, listener: (event?: unknown) => void): this {
    if (type === "idle") {
      // MapLibre code (waitForMapIdle) waits for "idle" before every command;
      // ArcGIS has no idle event, so emulate with when() (fires immediately
      // when the view is already ready).
      if (typeof this.view.when === "function") {
        void Promise.resolve(this.view.when(() => listener())).catch(() => {
          listener();
        });
      } else {
        listener();
      }
      return this;
    }
    if (type === "style.load") {
      // esri views never fire "style.load"; setStyle flushes these callbacks
      // on a macrotask after it applies the basemap change.
      this.addStyleLoadCallback(listener);
      return this;
    }
    const handle = this.view.on(type, () => {
      handle.remove();
      listener();
    });
    return this;
  }

  fire(type: string, data?: Record<string, unknown>): this {
    // esri views have no arbitrary-event dispatch; setStyle uses setTimeout
    // to resolve "style.load" waiters instead.
    void type;
    void data;
    return this;
  }

  /* -------------------------- style & basemap ----------------------------- */

  /**
   * Style URLs the tools' basemap registry hands down (DEFAULT_BASEMAPS
   * resolves "dark"/"positron"/… before the shim sees the name) mapped onto
   * the esri basemaps they represent. Anything else goes through
   * resolveBasemapStyle as an agent-managed XYZ WebTileLayer.
   */
  private static basemapNameFor(style: unknown): string | undefined {
    if (typeof style === "string") {
      const name = ARCGIS_BASEMAP_ALIASES[style.trim().toLowerCase()];
      if (name && ARCGIS_BASEMAPS.has(name)) {
        return name;
      }
    }
    if (typeof style !== "string") {
      return undefined;
    }
    const url = style.toLowerCase();
    if (url.includes("dark-matter")) {
      return "dark-gray";
    }
    if (url.includes("positron")) {
      return "light-gray";
    }
    if (url.includes("voyager")) {
      return "community";
    }
    if (url.includes("tile.openstreetmap.org") || url === "osm") {
      return "osm";
    }
    return undefined;
  }

  setStyle(style: unknown): void {
    // An esri basemap swap is the real "replace the whole style" analog on
    // this engine; the tools' basemap registry may also resolve an alias into
    // one of the known style URLs above.
    const basemapName = ArcGISMapShim.basemapNameFor(style);
    if (basemapName) {
      this.view.map.basemap = basemapName;
      this.removeAgentBaseLayer();
      this.flushStyleLoadCallbacks();
      return;
    }
    const resolved = resolveBasemapStyle(style, "ArcGIS Maps SDK");
    if (this.agentBaseLayer) {
      this.view.map.layers.remove(this.agentBaseLayer);
    }
    const tileLayer = new this.ns.WebTileLayer({
      urlTemplate: resolved.url,
      title: "geoagent-basemap",
    });
    tileLayer.opacity = 1;
    this.view.map.layers.add(tileLayer, 0);
    this.agentBaseLayer = tileLayer;
    this.flushStyleLoadCallbacks();
  }

  /**
   * change_basemap waits for "style.load"; the esri view never fires it, so
   * the shim resolves the waiter on a macrotask after applying the change
   * (mirroring MapLibre's asynchronous style.load contract).
   */
  private flushStyleLoadCallbacks(): void {
    window.setTimeout(() => {
      this.onStyleLoadCallbacks.forEach((cb) => cb());
      this.onStyleLoadCallbacks = [];
    }, 0);
  }

  private removeAgentBaseLayer(): void {
    if (this.agentBaseLayer) {
      this.view.map.layers.remove(this.agentBaseLayer);
      this.agentBaseLayer = null;
    }
  }

  private onStyleLoadCallbacks: Array<() => void> = [];

  /** Hook used by once("style.load") so setStyle can resolve the waiter. */
  private addStyleLoadCallback(callback: () => void): ArcGISWatchHandle {
    this.onStyleLoadCallbacks.push(callback);
    return { remove: () => {
      const index = this.onStyleLoadCallbacks.indexOf(callback);
      if (index >= 0) {
        this.onStyleLoadCallbacks.splice(index, 1);
      }
    } };
  }

  getStyle(): {
    version: number;
    sources: Record<string, Record<string, unknown>>;
    layers: Array<Record<string, unknown>>;
  } {
    const sources: Record<string, Record<string, unknown>> = {};
    for (const [id, source] of this.sources) {
      sources[id] = cloneJson(source.spec);
    }
    const layers: Array<Record<string, unknown>> = [];
    for (const id of this.layerOrder) {
      const entry = this.layers.get(id);
      if (entry) {
        layers.push(cloneJson(entry.spec));
      }
    }
    return { version: 8, sources, layers };
  }

  /* -------------------------- sources & layers ---------------------------- */

  addSource(id: string, spec: Record<string, unknown>): void {
    if (this.sources.has(id)) {
      throw new Error(`Source already exists: ${id}`);
    }
    this.sources.set(id, new ArcGisShimSource(this, id, spec));
  }

  getSource(id: string): ArcGisShimSource | undefined {
    return this.sources.get(id);
  }

  removeSource(id: string): void {
    const source = this.sources.get(id);
    if (!source) {
      throw new Error(`Source not found: ${id}`);
    }
    const dependents = this.layerOrder.filter(
      (layerId) =>
        String(this.layers.get(layerId)?.spec.source ?? "") === id,
    );
    if (dependents.length > 0) {
      throw new Error(
        `Cannot remove source ${id}; active layers depend on it: ${dependents.join(", ")}`,
      );
    }
    this.sources.delete(id);
  }

  addLayer(spec: Record<string, unknown>, beforeId?: string): void {
    const id = String(spec.id ?? "");
    if (!id) {
      throw new Error("addLayer requires a layer id.");
    }
    if (this.layers.has(id)) {
      throw new Error(`Layer already exists: ${id}`);
    }
    const type = String(spec.type ?? "");
    if (!GEOJSON_LAYER_TYPES.includes(type) && type !== "raster") {
      throw new Error(
        `The ArcGIS engine does not support "${type || "unknown"}" layers (layer "${id}"). Supported types: ${[...GEOJSON_LAYER_TYPES, "raster"].join(", ")}. Fill-extrusion, heatmap, and vector-tile layers require maplibre-gl or mapbox-gl.`,
      );
    }
    const sourceId = String(spec.source ?? "");
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new Error(`Cannot add layer ${id}; source not found: ${sourceId}`);
    }
    if (beforeId && !this.layerOrder.includes(beforeId)) {
      throw new Error(`Cannot add layer ${id}; beforeId not found: ${beforeId}`);
    }
    const layout = isRecord(spec.layout) ? spec.layout : {};
    const entry: ArcGisShimLayer = {
      id,
      type,
      source: sourceId,
      spec: cloneJson(spec),
      visible: layout.visibility !== "none",
      esriLayer: null,
    };
    this.materializeLayer(entry);
    if (entry.esriLayer) {
      entry.esriLayer.visible = entry.visible && this.isEntryInZoomRange(entry);
    }
    this.layers.set(id, entry);
    const insertIndex = beforeId
      ? this.layerOrder.indexOf(beforeId)
      : this.layerOrder.length;
    this.layerOrder.splice(insertIndex, 0, id);
    this.syncLayerOrder();
  }

  getLayer(id: string): Record<string, unknown> | undefined {
    return this.layers.get(id)?.spec;
  }

  removeLayer(id: string): void {
    const entry = this.layers.get(id);
    if (!entry) {
      throw new Error(`Layer not found: ${id}`);
    }
    if (entry.esriLayer) {
      this.view.map.layers.remove(entry.esriLayer);
    }
    this.layers.delete(id);
    this.layerOrder = this.layerOrder.filter((layerId) => layerId !== id);
  }

  moveLayer(id: string, beforeId?: string): void {
    if (!this.layers.has(id)) {
      throw new Error(`Layer not found: ${id}`);
    }
    if (beforeId && !this.layers.has(beforeId)) {
      throw new Error(`Layer not found: ${beforeId}`);
    }
    this.layerOrder = this.layerOrder.filter((layerId) => layerId !== id);
    const insertIndex = beforeId
      ? this.layerOrder.indexOf(beforeId)
      : this.layerOrder.length;
    this.layerOrder.splice(insertIndex, 0, id);
    this.syncLayerOrder();
  }

  /** Rebuild the esri layer collection so registry order is honored. */
  private syncLayerOrder(): void {
    const collection = this.view.map.layers;
    for (const entry of this.layers.values()) {
      if (entry.esriLayer) {
        collection.remove(entry.esriLayer);
      }
    }
    if (this.agentBaseLayer) {
      collection.remove(this.agentBaseLayer);
      collection.add(this.agentBaseLayer, 0);
    }
    for (const id of this.layerOrder) {
      const entry = this.layers.get(id);
      if (entry?.esriLayer) {
        collection.add(entry.esriLayer);
      }
    }
  }

  setPaintProperty(id: string, property: string, value: unknown): void {
    const entry = this.requireLayer(id);
    const paint = isRecord(entry.spec.paint) ? { ...entry.spec.paint } : {};
    paint[property] = value;
    entry.spec.paint = paint;
    if (entry.type === "raster" && property === "raster-opacity") {
      if (entry.esriLayer) {
        entry.esriLayer.opacity = clamp01(Number(value));
      }
      return;
    }
    // Symbols are baked per graphic on ArcGIS; refresh re-materializes.
    this.refreshLayer(entry);
  }

  setLayoutProperty(id: string, property: string, value: unknown): void {
    const entry = this.requireLayer(id);
    const layout = isRecord(entry.spec.layout) ? { ...entry.spec.layout } : {};
    layout[property] = value;
    entry.spec.layout = layout;
    if (property === "visibility") {
      entry.visible = value !== "none";
      if (entry.esriLayer) {
        entry.esriLayer.visible = entry.visible && this.isEntryInZoomRange(entry);
      }
      return;
    }
    this.refreshLayer(entry);
  }

  setFilter(id: string, filter: unknown): void {
    const entry = this.requireLayer(id);
    if (filter === null || filter === undefined) {
      delete entry.spec.filter;
    } else {
      entry.spec.filter = cloneJson(filter);
    }
    this.refreshLayer(entry);
  }

  private requireLayer(id: string): ArcGisShimLayer {
    const entry = this.layers.get(id);
    if (!entry) {
      throw new Error(`Layer not found: ${id}`);
    }
    return entry;
  }

  private isEntryInZoomRange(entry: ArcGisShimLayer): boolean {
    const zoom = this.getZoom();
    const spec = entry.spec;
    if (typeof spec.minzoom === "number" && zoom < spec.minzoom) {
      return false;
    }
    if (typeof spec.maxzoom === "number" && zoom >= spec.maxzoom) {
      return false;
    }
    return true;
  }

  private syncVisibilityAll(): void {
    for (const id of this.layerOrder) {
      const entry = this.layers.get(id);
      if (entry?.esriLayer) {
        entry.esriLayer.visible = entry.visible && this.isEntryInZoomRange(entry);
      }
    }
  }

  /* ------------------------------ materialization ------------------------- */

  private materializeLayer(entry: ArcGisShimLayer): void {
    if (entry.type === "raster") {
      const source = this.sources.get(entry.source);
      const tiles = Array.isArray(source?.spec.tiles)
        ? (source?.spec.tiles as unknown[])
        : [];
      if (typeof tiles[0] !== "string") {
        throw new Error(
          `Raster layer ${entry.id} needs a raster source with a tiles URL template.`,
        );
      }
      const paint = isRecord(entry.spec.paint) ? entry.spec.paint : {};
      const layer = new this.ns.WebTileLayer({
        urlTemplate: tiles[0],
        title: entry.id,
      });
      layer.opacity = clamp01(Number(paint["raster-opacity"] ?? 1));
      entry.esriLayer = layer;
      return;
    }
    const source = this.sources.get(entry.source);
    if (!source || source.type !== "geojson") {
      throw new Error(
        `${entry.type} layers on the ArcGIS engine require a geojson source (source "${entry.source}" is ${source?.type ?? "missing"}).`,
      );
    }
    entry.esriLayer = this.buildFeatureLayer(entry, source);
  }

  private refreshLayer(entry: ArcGisShimLayer): void {
    if (entry.type === "raster") {
      // Raster layers only carry opacity paint; nothing else to refresh.
      return;
    }
    const source = this.sources.get(entry.source);
    if (!source) {
      return;
    }
    const previous = entry.esriLayer;
    const index = this.layerOrder.indexOf(entry.id);
    if (previous) {
      this.view.map.layers.remove(previous);
    }
    this.materializeLayer(entry);
    if (entry.esriLayer) {
      entry.esriLayer.visible = entry.visible && this.isEntryInZoomRange(entry);
      this.view.map.layers.add(entry.esriLayer);
      if (previous) {
        // Rebuild puts the layer at the top; restore registry order.
        this.syncLayerOrder();
      }
    }
    void index;
  }

  /** Field-name sanitizer for client-side FeatureLayer field declarations. */
  private static esriFieldName(name: string, used: Set<string>): string {
    let field = name.replace(/[^a-zA-Z0-9_]/g, "_");
    if (/^[0-9]/.test(field)) {
      field = `f_${field}`;
    }
    if (!field) {
      field = "field";
    }
    let unique = field;
    let index = 2;
    while (used.has(unique)) {
      unique = `${field}_${index}`;
      index += 1;
    }
    used.add(unique);
    return unique;
  }

  private buildFeatureLayer(
    entry: ArcGisShimLayer,
    source: ArcGisShimSource,
  ): ArcGISLayerLike {
    const features = source.resolvedFeatures();
    const zoom = this.getZoom();
    const spec = entry.spec;
    // Client-side FeatureLayers need one geometry type; pick the majority
    // geometry and drop features of other types (same as MapLibre rendering
    // geometry-type-filtered layers).
    const geometryType = geometryTypeForFeatures(features);
    const usable = features.filter(
      (feature) =>
        geojsonToEsriGeometryType(feature.geometry?.type) === geometryType &&
        this.featurePassesFilter(spec, feature, zoom),
    );
    const fieldMap = new Map<string, string>();
    const used = new Set<string>(["__geoagent_oid"]);
    for (const feature of usable) {
      for (const key of Object.keys(feature.properties ?? {}).slice(0, 100)) {
        if (!fieldMap.has(key)) {
          fieldMap.set(key, ArcGISMapShim.esriFieldName(key, used));
        }
      }
    }
    const fields = [
      { name: "__geoagent_oid", type: "oid" },
      ...Array.from(fieldMap.entries()).map(([name, field]) => ({
        name: field,
        type:
          typeof (usable.find((feature) => feature.properties?.[name] != null)
            ?.properties?.[name]) === "number"
            ? "double"
            : "string",
      })),
    ];
    const graphics = usable.map((feature, index) => {
      const attributes: Record<string, unknown> = { __geoagent_oid: index };
      for (const [key, value] of Object.entries(feature.properties ?? {})) {
        const field = fieldMap.get(key);
        if (field) {
          attributes[field] =
            typeof value === "number" || typeof value === "string" ||
            typeof value === "boolean"
              ? value
              : JSON.stringify(value);
        }
      }
      return new this.ns.Graphic({
        geometry: geojsonToEsriGeometry(feature.geometry),
        attributes,
        symbol: this.symbolFor(spec, feature, zoom),
      });
    });
    // A simple renderer backs graphics that somehow lack a symbol; per-feature
    // symbols (which carry the data-driven paint) always take precedence.
    const paint = isRecord(spec.paint) ? spec.paint : {};
    const context = featureContextFor(undefined, zoom);
    const rendererSymbol =
      entry.type === "fill"
        ? this.fillSymbolFor(paint, context)
        : entry.type === "line"
          ? this.lineSymbolFor(paint, context)
          : entry.type === "circle"
            ? this.circleSymbolFor(paint, context)
            : undefined;
    return new this.ns.FeatureLayer({
      source: graphics,
      objectIdField: "__geoagent_oid",
      fields,
      geometryType,
      spatialReference: { wkid: 4326 },
      title: entry.id,
      renderer: rendererSymbol
        ? { type: "simple", symbol: rendererSymbol }
        : undefined,
    });
  }

  private featurePassesFilter(
    spec: Record<string, unknown>,
    feature: GeoJSON.Feature,
    zoom: number,
  ): boolean {
    if (!spec.filter) {
      return true;
    }
    return expressionTruthy(
      evaluateExpression(spec.filter, featureContextFor(feature, zoom)),
    );
  }

  private fillSymbolFor(
    paint: Record<string, unknown>,
    context: ExpressionContext,
  ): unknown {
    // MapLibre fills have no outline unless fill-outline-color is set, and
    // fill-opacity applies to the whole layer including that outline.
    const fillOpacity = numberValueFrom(paint["fill-opacity"], context, 1);
    const outlineColor = paint["fill-outline-color"];
    return new this.ns.SimpleFillSymbol({
      color: withOpacity(
        colorValueFrom(paint["fill-color"], context, "#1c7ed6"),
        fillOpacity,
      ),
      outline:
        outlineColor != null
          ? new this.ns.SimpleLineSymbol({
              color: withOpacity(
                colorValueFrom(outlineColor, context, "#1c7ed6"),
                fillOpacity,
              ),
              width: 1,
              style: "solid",
            })
          : null,
    });
  }

  private lineSymbolFor(
    paint: Record<string, unknown>,
    context: ExpressionContext,
  ): unknown {
    return new this.ns.SimpleLineSymbol({
      color: withOpacity(
        colorValueFrom(paint["line-color"], context, "#1c7ed6"),
        numberValueFrom(paint["line-opacity"], context, 1),
      ),
      width: Math.max(0.5, numberValueFrom(paint["line-width"], context, 1)),
      style: "solid",
    });
  }

  private circleSymbolFor(
    paint: Record<string, unknown>,
    context: ExpressionContext,
  ): unknown {
    const strokeWidth = numberValueFrom(paint["circle-stroke-width"], context, 0);
    return new this.ns.SimpleMarkerSymbol({
      color: withOpacity(
        colorValueFrom(paint["circle-color"], context, "#1c7ed6"),
        numberValueFrom(paint["circle-opacity"], context, 1),
      ),
      size: Math.max(1, numberValueFrom(paint["circle-radius"], context, 5) * 2),
      outline:
        strokeWidth > 0
          ? new this.ns.SimpleLineSymbol({
              color: withOpacity(
                colorValueFrom(
                  paint["circle-stroke-color"],
                  context,
                  "#ffffff",
                ),
                numberValueFrom(paint["circle-stroke-opacity"], context, 1),
              ),
              width: strokeWidth,
              style: "solid",
            })
          : null,
    });
  }

  private textSymbolFor(
    spec: Record<string, unknown>,
    feature: GeoJSON.Feature,
    zoom: number,
  ): unknown {
    const paint = isRecord(spec.paint) ? spec.paint : {};
    const layout = isRecord(spec.layout) ? spec.layout : {};
    const context = featureContextFor(feature, zoom);
    const text = textFieldTextFrom(layout["text-field"], context);
    const size = Math.max(4, numberValueFrom(layout["text-size"], context, 12));
    return new this.ns.TextSymbol({
      text,
      color: colorValueFrom(paint["text-color"], context, "#ffffff"),
      haloColor: "rgba(0, 0, 0, 0.85)",
      haloSize: 1.5,
      font: { size, family: "sans-serif", weight: "bold" },
    });
  }

  private symbolFor(
    spec: Record<string, unknown>,
    feature: GeoJSON.Feature,
    zoom: number,
  ): unknown {
    const paint = isRecord(spec.paint) ? spec.paint : {};
    const context = featureContextFor(feature, zoom);
    switch (String(spec.type ?? "")) {
      case "fill":
        return this.fillSymbolFor(paint, context);
      case "line":
        return this.lineSymbolFor(paint, context);
      case "circle":
        return this.circleSymbolFor(paint, context);
      case "symbol":
        return this.textSymbolFor(spec, feature, zoom);
      default:
        return undefined;
    }
  }

  /* ------------------------------- queries -------------------------------- */

  /**
   * Minimal canvas surface for query_rendered_features' default-center math.
   * Direct canvas capture is meaningless here (the tools use takeScreenshot),
   * so toDataURL throws the honest capability error.
   */
  getCanvas(): {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    toDataURL(): string;
  } {
    const [width, height] = this.getSize();
    return {
      clientWidth: width,
      clientHeight: height,
      width,
      height,
      toDataURL(): never {
        throw new Error(
          "Direct canvas capture is not supported by the ArcGIS engine; use screenshot_map (view.takeScreenshot), which composites the view client-side.",
        );
      },
    };
  }

  querySourceFeatures(
    sourceId: string,
    options?: { sourceLayer?: string; filter?: unknown },
  ): GeoJSON.Feature[] {
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new Error(`Source not found: ${sourceId}`);
    }
    if (source.type !== "geojson") {
      return [];
    }
    const zoom = this.getZoom();
    return source.resolvedFeatures().filter((feature) => {
      if (!options?.filter) {
        return true;
      }
      return expressionTruthy(
        evaluateExpression(options.filter, featureContextFor(feature, zoom)),
      );
    });
  }

  queryRenderedFeatures(
    point: [number, number],
    options?: { layers?: string[] },
  ): Array<Record<string, unknown>> {
    const [x, y] = point;
    const wanted = options?.layers;
    const zoom = this.getZoom();
    const toPixel = this.screenProjector();
    const results: Array<Record<string, unknown>> = [];
    for (const id of this.layerOrder) {
      if (results.length >= 50) {
        break;
      }
      const entry = this.layers.get(id);
      if (!entry || !entry.visible || !this.isEntryInZoomRange(entry)) {
        continue;
      }
      if (wanted && wanted.length > 0 && !wanted.includes(id)) {
        continue;
      }
      if (!GEOJSON_LAYER_TYPES.includes(String(entry.spec.type))) {
        continue;
      }
      const source = this.sources.get(String(entry.spec.source ?? ""));
      if (!source || source.type !== "geojson") {
        continue;
      }
      for (const feature of source.resolvedFeatures()) {
        if (!this.featurePassesFilter(entry.spec, feature, zoom)) {
          continue;
        }
        if (
          hitTestFeature(entry.spec, feature, x, y, toPixel,
            featureContextFor(feature, zoom))
        ) {
          results.push(feature as unknown as Record<string, unknown>);
        }
      }
    }
    return results;
  }

  /* ------------------------------ screenshot ------------------------------ */

  /**
   * `screenshot_map`: the MapView genuinely supports this via takeScreenshot
   * (which composites basemap + layers client-side).
   */
  async takeScreenshot(): Promise<{
    data_url: string;
    width: number;
    height: number;
  }> {
    if (typeof this.view.takeScreenshot !== "function") {
      throw new Error(
        "screenshot_map requires a MapView with takeScreenshot(); this view does not expose it.",
      );
    }
    const screenshot = await this.view.takeScreenshot({ format: "png" });
    const dataUrl = screenshot?.dataUrl;
    if (!dataUrl) {
      throw new Error("The ArcGIS view did not return a screenshot data URL.");
    }
    return {
      data_url: dataUrl,
      width: screenshot?.data?.width ?? 0,
      height: screenshot?.data?.height ?? 0,
    };
  }

  /* --------------------------- markers & popups --------------------------- */

  /**
   * GeoAgentMarker-compatible wrapper around a positioned DOM element in the
   * view container (ArcGIS has no marker primitive). Position tracks the
   * view via the watch handles registered in the constructor.
   */
  createMarker(color?: string): {
    setLngLat(lngLat: [number, number]): unknown;
    addTo(map: unknown): unknown;
    setPopup(popup: unknown): unknown;
    getElement(): HTMLElement;
    remove(): unknown;
  } {
    const safeColor = sanitizeCssColor(color || "#3388ff");
    const element = document.createElement("div");
    element.className = "geoagent-arcgis-marker-icon";
    element.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 36" width="26" height="36"><path d="M13 0C5.8 0 0 5.8 0 13c0 9.8 11.6 22.2 12.1 22.7.5.5 1.3.5 1.8 0C14.4 35.2 26 22.8 26 13 26 5.8 20.2 0 13 0z" fill="${safeColor}"/><circle cx="13" cy="13" r="5.5" fill="#ffffff"/></svg>`;
    const container = this.view.container;
    const wrapper: MarkerWrapper = {
      element,
      lngLat: null,
      popupElement: null,
    };
    this.markers.add(wrapper);
    const self = {
      setLngLat: (lngLat: [number, number]): unknown => {
        wrapper.lngLat = [lngLat[0], lngLat[1]];
        this.syncMarkers();
        return self;
      },
      addTo: (_map: unknown): unknown => {
        element.style.position = "absolute";
        element.style.transform = "translate(-13px, -36px)";
        element.style.zIndex = "30";
        element.style.pointerEvents = "auto";
        element.style.cursor = "pointer";
        container.appendChild(element);
        this.syncMarkers();
        return self;
      },
      setPopup: (popup: unknown): unknown => {
        const content = extractArcGISPopupElement(popup);
        if (!content) {
          return self;
        }
        wrapper.popupElement = content;
        element.addEventListener("click", (event) => {
          event.stopPropagation();
          if (!wrapper.lngLat) {
            return;
          }
          this.showMarkerPopup(wrapper);
        });
        return self;
      },
      getElement: (): HTMLElement => element,
      remove: (): unknown => {
        if (wrapper.popupElement?.parentNode) {
          wrapper.popupElement.parentNode.removeChild(wrapper.popupElement);
        }
        if (element.parentNode) {
          element.parentNode.removeChild(element);
        }
        this.markers.delete(wrapper);
        return undefined;
      },
    };
    return self;
  }

  private showMarkerPopup(wrapper: MarkerWrapper): void {
    if (!wrapper.lngLat || !wrapper.popupElement) {
      return;
    }
    const popup = wrapper.popupElement;
    popup.classList.add("geoagent-arcgis-popup-content");
    popup.style.position = "absolute";
    popup.style.zIndex = "31";
    popup.style.pointerEvents = "auto";
    this.view.container.appendChild(popup);
    const toPixel = this.screenProjector();
    const px = toPixel(wrapper.lngLat);
    popup.style.left = `${px.x}px`;
    popup.style.top = `${Math.max(0, px.y - 44)}px`;
    popup.style.transform = "translate(-50%, -100%)";
  }

  private hideMarkerPopups(): void {
    for (const wrapper of this.markers) {
      if (wrapper.popupElement?.parentNode) {
        wrapper.popupElement.parentNode.removeChild(wrapper.popupElement);
      }
    }
  }

  private syncMarkers(): void {
    if (this.markers.size === 0) {
      return;
    }
    const toPixel = this.screenProjector();
    for (const wrapper of this.markers) {
      if (!wrapper.lngLat) {
        continue;
      }
      const px = toPixel(wrapper.lngLat);
      wrapper.element.style.left = `${px.x}px`;
      wrapper.element.style.top = `${px.y}px`;
      if (
        wrapper.popupElement?.parentNode &&
        wrapper.popupElement.style.position === "absolute"
      ) {
        wrapper.popupElement.style.left = `${px.x}px`;
        wrapper.popupElement.style.top = `${Math.max(0, px.y - 44)}px`;
      }
    }
  }

  /** GeoAgentPopup-compatible wrapper around a popup content element. */
  createPopup(): {
    setText(text: string): unknown;
    __geoAgentArcGISPopupElement: HTMLElement;
  } {
    const element = document.createElement("div");
    element.className = "geoagent-arcgis-popup-content";
    const self = {
      setText(text: string): unknown {
        // textContent — model-supplied popup text must never become HTML.
        element.textContent = text;
        return self;
      },
      __geoAgentArcGISPopupElement: element,
    };
    return self;
  }

  /* -------------------------------- teardown ------------------------------ */

  /**
   * Unbind the shim's watch/on listeners. Called by the tools layer on
   * dispose; without it, re-attaching to the same view leaks one listener set
   * per attach, and stale handlers keep re-syncing detached layers.
   */
  destroy(): void {
    for (const handle of this.watchHandles) {
      handle.remove();
    }
    this.watchHandles.length = 0;
    if (this.clickHandle) {
      this.clickHandle.remove();
      this.clickHandle = null;
    }
    for (const wrapper of Array.from(this.markers)) {
      (wrapper as unknown as { remove?: () => void }).remove?.();
    }
    this.markers.clear();
  }
}

function geometryTypeForFeatures(features: GeoJSON.Feature[]): string {
  for (const feature of features) {
    const type = geojsonToEsriGeometryType(feature.geometry?.type);
    if (type) {
      return type;
    }
  }
  return "point";
}

function geojsonToEsriGeometryType(type: string | undefined): string {
  const normalized = normalizeGeometryType(String(type ?? ""));
  switch (normalized) {
    case "Point":
      return "point";
    case "LineString":
      return "polyline";
    case "Polygon":
      return "polygon";
    default:
      return "";
  }
}

/**
 * GeoJSON geometry → auto-cast plain object the ArcGIS SDK accepts as a
 * Graphic geometry (WGS84 lon/lat). Multi* variants are merged into the
 * corresponding paths/rings arrays.
 */
function geojsonToEsriGeometry(geometry: GeoJSON.Geometry | null | undefined):
  | Record<string, unknown>
  | null {
  if (!geometry) {
    return null;
  }
  const sr = { wkid: 4326 };
  switch (geometry.type) {
    case "Point":
    case "MultiPoint": {
      const coords =
        geometry.type === "Point"
          ? [geometry.coordinates]
          : geometry.coordinates;
      const first = coords.find(
        (coord) =>
          Array.isArray(coord) &&
          Number.isFinite(coord[0]) &&
          Number.isFinite(coord[1]),
      );
      if (!first) {
        return null;
      }
      return { type: "point", longitude: first[0], latitude: first[1] };
    }
    case "LineString":
    case "MultiLineString": {
      const paths =
        geometry.type === "LineString"
          ? [geometry.coordinates]
          : geometry.coordinates;
      return { type: "polyline", paths, spatialReference: sr };
    }
    case "Polygon":
    case "MultiPolygon": {
      const rings =
        geometry.type === "Polygon"
          ? geometry.coordinates
          : geometry.coordinates.flat();
      return { type: "polygon", rings, spatialReference: sr };
    }
    default:
      return null;
  }
}

function extractArcGISPopupElement(popup: unknown): HTMLElement | null {
  if (
    isRecord(popup) &&
    (popup as { __geoAgentArcGISPopupElement?: unknown })
      .__geoAgentArcGISPopupElement instanceof HTMLElement
  ) {
    return (popup as { __geoAgentArcGISPopupElement: HTMLElement })
      .__geoAgentArcGISPopupElement;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Factory + control mounting                                                 */
/* -------------------------------------------------------------------------- */

export function createArcGISMapShim(
  map: ArcGISViewLike,
  namespace: Record<string, unknown>,
): ArcGISMapShim {
  return new ArcGISMapShim(map, namespace);
}

export function isArcGISMapShim(value: unknown): value is ArcGISMapShim {
  return value instanceof ArcGISMapShim;
}

export interface ArcGISControlAttachment {
  remove(): void;
}

type CornerPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

function normalizeCorner(position: string): CornerPosition {
  const compact = position.trim().toLowerCase().replace(/[\s_-]/g, "");
  switch (compact) {
    case "topleft":
      return "top-left";
    case "bottomleft":
      return "bottom-left";
    case "bottomright":
      return "bottom-right";
    default:
      return "top-right";
  }
}

/**
 * Attach a GeoAgentControl to an ArcGIS MapView (or a ready `<arcgis-map>`
 * element). ArcGIS has no map.addControl slot for foreign controls, so this
 * mounts the control element into the view container and absolutely positions
 * it in the requested corner. The control must have been created with
 * mapEngine { kind: "arcgis", namespace }.
 *
 *   const control = new GeoAgentControl({ mapEngine: { kind: "arcgis", namespace } });
 *   const attachment = addGeoAgentToArcGISMap(control, view, { position: "top-left" });
 *   // later: attachment.remove();
 */
export function addGeoAgentToArcGISMap(
  control: GeoAgentControl,
  map: unknown,
  options?: { position?: string },
): ArcGISControlAttachment {
  const view = resolveArcGISView(map);
  const internal = control as unknown as {
    options?: { position?: string; mapEngine?: { kind?: string } };
    onRemove(): void;
  };
  const engineKind = internal.options?.mapEngine?.kind;
  if (engineKind && engineKind !== "arcgis") {
    throw new Error(
      `GeoAgentControl was created with mapEngine.kind "${engineKind}"; ArcGIS hosts need { kind: "arcgis", namespace }.`,
    );
  }
  const position = normalizeCorner(
    options?.position ?? internal.options?.position ?? "top-right",
  );
  if (internal.options && internal.options.position !== position) {
    // GeoAgentControl positions its expanded panel from options.position;
    // keep it consistent with the corner we actually mount into.
    internal.options.position = position;
  }
  // The panel is appended to the view container and absolutely positioned;
  // make sure that container is a positioning context.
  const container = view.container;
  if (container && window.getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }
  const element = control.onAdd(view as unknown as MapLibreMap);
  element.classList.add("geoagent-arcgis-control");
  const [vertical, horizontal] = position.split("-") as [string, string];
  element.style.position = "absolute";
  element.style.zIndex = "10";
  element.style.pointerEvents = "auto";
  if (vertical === "top") {
    element.style.top = "10px";
    element.style.bottom = "";
  } else {
    element.style.bottom = "10px";
    element.style.top = "";
  }
  if (horizontal === "left") {
    element.style.left = "10px";
    element.style.right = "";
  } else {
    element.style.right = "10px";
    element.style.left = "";
  }
  container.appendChild(element);
  return {
    remove(): void {
      internal.onRemove.call(control);
      element.remove();
    },
  };
}
