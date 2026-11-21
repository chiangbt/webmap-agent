/**
 * OpenLayers host support for the GeoAgent control.
 *
 * The GeoAgent tools drive the map through the MapLibre GL JS API surface:
 * Style Spec sources/layers, setStyle, queryRenderedFeatures, and friends.
 * OpenLayers has a different object model entirely — Layers with Sources, a
 * View in EPSG:3857, and style functions instead of a style document.
 *
 * OpenLayersMapShim bridges the gap. It keeps a Style-Spec-like registry of
 * sources and layers, materializes them as real ol layers (VectorLayer with a
 * style function that evaluates MapLibre expressions, TileLayer with XYZ for
 * rasters), and exposes the subset of the maplibregl.Map API that the tools
 * call. Capabilities OpenLayers genuinely lacks (globe projection, terrain,
 * sky, fill-extrusion/heatmap layers, canvas screenshots) throw explicit
 * errors instead of failing silently — the same contract the README documents
 * for mapbox-gl and Leaflet hosts.
 *
 * Nothing here imports "ol"; hosts pass their own namespace:
 *
 *   import Map from "ol/Map";
 *   import { GeoAgentControl, addGeoAgentToOpenLayersMap } from "web-geoagent";
 *   new GeoAgentControl({ mapEngine: { kind: "openlayers", namespace } })
 *   addGeoAgentToOpenLayersMap(control, map); // OpenLayers has no addControl slot
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
/* Structural OpenLayers types (the shim never imports "ol" itself)           */
/* -------------------------------------------------------------------------- */

export interface OpenLayersGeometryLike {
  getType(): string;
}

export interface OpenLayersFeatureLike {
  getGeometry(): OpenLayersGeometryLike | undefined;
  getProperties(): Record<string, unknown>;
  getId(): string | number | undefined;
}

export interface OpenLayersVectorSourceLike {
  clear(): void;
  addFeatures(features: unknown[]): void;
  getFeatures(): OpenLayersFeatureLike[];
}

export interface OpenLayersLayerLike {
  getSource(): unknown;
  setSource(source: unknown): void;
  setVisible(visible: boolean): void;
  getVisible(): boolean;
  setOpacity(opacity: number): void;
  changed(): void;
}

export interface OpenLayersCollectionLike<T> {
  getArray(): T[];
  getLength(): number;
  insertAt(index: number, item: T): void;
  remove(item: T): T | undefined;
}

export interface OpenLayersOverlayLike {
  setPosition(coordinate: number[] | undefined): void;
  getPosition(): number[] | undefined;
}

export interface OpenLayersGeoJSONFormatLike {
  readFeatures(
    source: unknown,
    options?: Record<string, unknown>,
  ): OpenLayersFeatureLike[];
}

export interface OpenLayersViewLike {
  getCenter(): number[] | undefined;
  setCenter(center: number[]): void;
  getZoom(): number | undefined;
  setZoom(zoom: number): void;
  getRotation(): number;
  getProjection(): { getCode(): string };
  calculateExtent(size: number[]): number[];
  fit(extent: number[], options?: Record<string, unknown>): void;
  animate(options: Record<string, unknown>): void;
}

export interface OpenLayersMapLike {
  getView(): OpenLayersViewLike | undefined;
  getLayers(): OpenLayersCollectionLike<OpenLayersLayerLike>;
  getViewport(): HTMLElement;
  getTargetElement(): HTMLElement | null | undefined;
  getSize(): number[] | undefined;
  addLayer(layer: OpenLayersLayerLike): void;
  removeLayer(layer: OpenLayersLayerLike): void;
  addOverlay(overlay: OpenLayersOverlayLike): void;
  removeOverlay(overlay: OpenLayersOverlayLike): void;
  getPixelFromCoordinate(
    coordinate: number[],
  ): number[] | null | undefined;
  on(type: string, listener: (event?: unknown) => void): unknown;
  un(type: string, listener: (event?: unknown) => void): unknown;
  dispatchEvent(event: unknown): unknown;
}

/**
 * The pieces of the "ol" package the shim needs. Hosts assemble it once:
 *
 *   const namespace = {
 *     Feature, Point, Overlay,                       // ol/Feature, ol/geom/Point, ol/Overlay
 *     VectorLayer, TileLayer,                        // ol/layer/*
 *     VectorSource, XYZ,                             // ol/source/*
 *     GeoJSON,                                       // ol/format/GeoJSON
 *     Style, Fill, Stroke, CircleStyle: Circle, Text,// ol/style/*
 *     fromLonLat, toLonLat, transformExtent,         // ol/proj
 *   };
 */
export interface OpenLayersNamespace {
  Feature: new (values?: unknown) => OpenLayersFeatureLike;
  Point: new (coordinates: number[]) => OpenLayersGeometryLike;
  Overlay: new (options: Record<string, unknown>) => OpenLayersOverlayLike;
  VectorLayer: new (options?: Record<string, unknown>) => OpenLayersLayerLike;
  TileLayer: new (options?: Record<string, unknown>) => OpenLayersLayerLike;
  VectorSource: new (
    options?: Record<string, unknown>,
  ) => OpenLayersVectorSourceLike;
  XYZ: new (options?: Record<string, unknown>) => unknown;
  GeoJSON: new (options?: Record<string, unknown>) => OpenLayersGeoJSONFormatLike;
  Style: new (options?: Record<string, unknown>) => unknown;
  Fill: new (options?: Record<string, unknown>) => unknown;
  Stroke: new (options?: Record<string, unknown>) => unknown;
  CircleStyle: new (options?: Record<string, unknown>) => unknown;
  Text: new (options?: Record<string, unknown>) => unknown;
  fromLonLat: (coordinate: number[]) => number[];
  toLonLat: (coordinate: number[]) => number[];
  transformExtent: (
    extent: number[],
    from: string,
    to: string,
  ) => number[];
}

const REQUIRED_OPENLAYERS_KEYS: Array<keyof OpenLayersNamespace> = [
  "Feature",
  "Point",
  "Overlay",
  "VectorLayer",
  "TileLayer",
  "VectorSource",
  "XYZ",
  "GeoJSON",
  "Style",
  "Fill",
  "Stroke",
  "CircleStyle",
  "Text",
  "fromLonLat",
  "toLonLat",
  "transformExtent",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOpenLayersNamespace(
  namespace: Record<string, unknown>,
): OpenLayersNamespace {
  const missing = REQUIRED_OPENLAYERS_KEYS.filter(
    (key) => namespace[key] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `mapEngine { kind: "openlayers" } needs a namespace with the ol classes and helpers: missing ${missing.join(", ")}. See the OpenLayers example for the full namespace object.`,
    );
  }
  return namespace as unknown as OpenLayersNamespace;
}

/** Duck-type check: does this look like an ol/Map instance? */
export function isOpenLayersMap(value: unknown): value is OpenLayersMapLike {
  if (!isRecord(value)) {
    return false;
  }
  const candidate = value as unknown as OpenLayersMapLike;
  return (
    typeof candidate.getView === "function" &&
    typeof candidate.getLayers === "function" &&
    typeof candidate.getViewport === "function" &&
    typeof candidate.addOverlay === "function"
  );
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

/* -------------------------------------------------------------------------- */
/* Color helpers (opacity blending for Fill/Stroke colors)                    */
/* -------------------------------------------------------------------------- */

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
      pair.length === 1
        ? parseInt(pair.repeat(2), 16)
        : parseInt(pair, 16);
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

/* -------------------------------------------------------------------------- */
/* Source / layer registry                                                    */
/* -------------------------------------------------------------------------- */

const GEOJSON_LAYER_TYPES = ["fill", "line", "circle", "symbol"];

interface OlShimLayer {
  id: string;
  type: string;
  source: string;
  spec: Record<string, unknown>;
  visible: boolean;
  olLayer: OpenLayersLayerLike | null;
}

class OlShimSource {
  readonly id: string;
  readonly type: string;
  readonly cluster: boolean;
  readonly clusterRadius: number;
  readonly clusterMaxZoom: number;
  spec: Record<string, unknown>;
  data: GeoJSON.FeatureCollection = emptyFeatureCollection();
  readonly vectorSource: OpenLayersVectorSourceLike | null;
  readonly tileSource: unknown;
  private clusterCache: { zoom: number; features: GeoJSON.Feature[] } | null =
    null;
  private readonly shim: OpenLayersMapShim;

  constructor(shim: OpenLayersMapShim, id: string, spec: Record<string, unknown>) {
    this.shim = shim;
    this.id = id;
    this.spec = cloneJson(spec);
    this.type = String(spec.type ?? "unknown");
    this.cluster = this.type === "geojson" && Boolean(spec.cluster);
    this.clusterRadius = Number(spec.clusterRadius ?? 50);
    this.clusterMaxZoom = Number(spec.clusterMaxZoom ?? 14);
    if (this.type === "geojson") {
      this.vectorSource = new (shim.getNamespace().VectorSource)();
      this.tileSource = null;
      const data = spec.data;
      if (typeof data === "string") {
        void shim
          .fetchGeoJson(data)
          .then((loaded) => this.setData(loaded))
          .catch((error: unknown) => {
            console.warn(
              `OpenLayers engine: could not load GeoJSON source "${id}":`,
              error,
            );
          });
      } else {
        this.data = normalizeFeatureCollection(data);
        this.syncOlFeatures();
      }
    } else if (this.type === "raster") {
      this.vectorSource = null;
      const tiles = Array.isArray(spec.tiles) ? spec.tiles : [];
      const url = typeof tiles[0] === "string" ? tiles[0] : "";
      if (!url) {
        throw new Error(
          `Raster source "${id}" needs a tiles URL template; the OpenLayers engine renders rasters as XYZ tile layers.`,
        );
      }
      this.tileSource = new (shim.getNamespace().XYZ)({
        url,
        attributions:
          typeof spec.attribution === "string" && spec.attribution
            ? [spec.attribution]
            : undefined,
      });
    } else if (this.type === "raster-dem") {
      throw new Error(
        "Terrain (raster-dem) is not supported by the OpenLayers engine.",
      );
    } else if (this.type === "vector") {
      throw new Error(
        `Vector tile sources are not supported by the OpenLayers engine (source "${id}"). 3D buildings and vector basemaps require maplibre-gl or mapbox-gl.`,
      );
    } else {
      throw new Error(
        `"${this.type}" sources are not supported by the OpenLayers engine (source "${id}").`,
      );
    }
  }

  setData(data: unknown): void {
    this.data = normalizeFeatureCollection(data);
    this.spec.data = data;
    this.clusterCache = null;
    this.syncOlFeatures();
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

  syncOlFeatures(): void {
    if (!this.vectorSource) {
      return;
    }
    this.vectorSource.clear();
    const collection: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: this.resolvedFeatures(),
    };
    const olFeatures = this.shim
      .getFormat()
      .readFeatures(collection, { featureProjection: "EPSG:3857" });
    this.vectorSource.addFeatures(olFeatures);
  }
}

/* -------------------------------------------------------------------------- */
/* The shim                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Presents the MapLibre Map API surface the GeoAgent tools speak on top of a
 * real ol/Map. Mirrors LeafletMapShim; see that class for the contract.
 */
export class OpenLayersMapShim {
  private readonly raw: OpenLayersMapLike;
  private readonly ns: OpenLayersNamespace;
  private readonly format: OpenLayersGeoJSONFormatLike;
  private readonly sources = new Map<string, OlShimSource>();
  private readonly layers = new Map<string, OlShimLayer>();
  private layerOrder: string[] = [];
  private baseLayer: OpenLayersLayerLike | null = null;
  private readonly clusterHandler: (event?: unknown) => void;

  constructor(map: OpenLayersMapLike, namespace: Record<string, unknown>) {
    this.raw = map;
    this.ns = asOpenLayersNamespace(namespace);
    this.format = new this.ns.GeoJSON();
    const array = this.raw.getLayers().getArray();
    // Convention: the bottom-most existing layer is the host's basemap; we
    // swap its source on change_basemap instead of stacking tiles forever.
    this.baseLayer = array.length > 0 ? array[0] : null;
    this.clusterHandler = () => {
      for (const source of this.sources.values()) {
        if (source.cluster) {
          source.invalidateClusterCache();
          source.syncOlFeatures();
        }
      }
    };
    this.raw.on("moveend", this.clusterHandler);
  }

  getRawMap(): OpenLayersMapLike {
    return this.raw;
  }

  getNamespace(): OpenLayersNamespace {
    return this.ns;
  }

  getFormat(): OpenLayersGeoJSONFormatLike {
    return this.format;
  }

  async fetchGeoJson(url: string): Promise<GeoJSON.FeatureCollection> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch GeoJSON from ${url}: ${response.status}`);
    }
    return normalizeFeatureCollection(await response.json());
  }

  /* ----------------------------- map plumbing ---------------------------- */

  getContainer(): HTMLElement {
    return this.raw.getViewport();
  }

  private requireView(): OpenLayersViewLike {
    const view = this.raw.getView();
    if (!view) {
      throw new Error("The OpenLayers map has no view attached.");
    }
    return view;
  }

  loaded(): boolean {
    return Boolean(this.raw.getView());
  }

  /** MapLibre-compatible LngLat-like: `.lng` / `.lat` properties. */
  getCenter(): { lng: number; lat: number } {
    const center = this.raw.getView()?.getCenter();
    if (!center) {
      return { lng: 0, lat: 0 };
    }
    const lonLat = this.ns.toLonLat(center);
    return { lng: lonLat[0], lat: lonLat[1] };
  }

  getZoom(): number {
    const zoom = this.raw.getView()?.getZoom();
    return typeof zoom === "number" && Number.isFinite(zoom) ? zoom : 0;
  }

  /**
   * ol/View rotation is clockwise radians, the same convention as MapLibre's
   * bearing (clockwise degrees).
   */
  getBearing(): number {
    const view = this.raw.getView();
    if (!view) {
      return 0;
    }
    return (view.getRotation() * 180) / Math.PI;
  }

  getPitch(): number {
    // OpenLayers has no pitched camera.
    return 0;
  }

  /** MapLibre-compatible LngLatBounds-like: getWest()/getSouth()/... methods. */
  getBounds(): {
    getWest(): number;
    getSouth(): number;
    getEast(): number;
    getNorth(): number;
  } {
    const view = this.requireView();
    const size = this.effectiveSize();
    const extent = this.ns.transformExtent(
      view.calculateExtent(size),
      "EPSG:3857",
      "EPSG:4326",
    );
    return {
      getWest: () => extent[0],
      getSouth: () => extent[1],
      getEast: () => extent[2],
      getNorth: () => extent[3],
    };
  }

  private effectiveSize(): [number, number] {
    const size = this.raw.getSize();
    if (size && size[0] > 0 && size[1] > 0) {
      return [size[0], size[1]];
    }
    const viewport = this.raw.getViewport();
    const width = viewport?.clientWidth ?? 0;
    const height = viewport?.clientHeight ?? 0;
    // jsdom and other zero-size environments would make View.fit/calculateExtent
    // degenerate; fall back to a sane square so camera math keeps working.
    return [width > 0 ? width : 512, height > 0 ? height : 512];
  }

  getSize(): [number, number] {
    return this.effectiveSize();
  }

  projectPoint(lat: number, lng: number): { x: number; y: number } {
    const pixel = this.raw.getPixelFromCoordinate(
      this.ns.fromLonLat([lng, lat]),
    );
    if (pixel && Number.isFinite(pixel[0]) && Number.isFinite(pixel[1])) {
      return { x: pixel[0], y: pixel[1] };
    }
    // Before the first rendered frame (or in jsdom), ol returns null;
    // fall back to pure Web Mercator math against the current view.
    return this.mercatorProject(lat, lng);
  }

  private mercatorProject(lat: number, lng: number): { x: number; y: number } {
    const view = this.raw.getView();
    const zoom = view?.getZoom();
    const center = view?.getCenter();
    const size = this.effectiveSize();
    const z = typeof zoom === "number" && Number.isFinite(zoom) ? zoom : 0;
    const worldSize = 256 * Math.pow(2, z);
    const toWorldX = (lon: number) => ((lon + 180) / 360) * worldSize;
    const toWorldY = (latDeg: number) => {
      const clamped = Math.max(-85.05112878, Math.min(85.05112878, latDeg));
      const sinLat = Math.sin((clamped * Math.PI) / 180);
      return (
        (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) *
        worldSize
      );
    };
    let centerX = worldSize / 2;
    let centerY = worldSize / 2;
    if (center) {
      const lonLat = this.ns.toLonLat(center);
      centerX = toWorldX(lonLat[0]);
      centerY = toWorldY(lonLat[1]);
    }
    return {
      x: toWorldX(lng) - centerX + size[0] / 2,
      y: toWorldY(lat) - centerY + size[1] / 2,
    };
  }

  jumpTo(options: { center?: [number, number]; zoom?: number }): void {
    const view = this.requireView();
    if (options.center) {
      view.setCenter(this.ns.fromLonLat(options.center));
    }
    if (options.zoom !== undefined && options.zoom !== null) {
      view.setZoom(Number(options.zoom));
    }
  }

  flyTo(options: { center?: [number, number]; zoom?: number }): void {
    const animation: Record<string, unknown> = { duration: 1200 };
    if (options.center) {
      animation.center = this.ns.fromLonLat(options.center);
    }
    if (options.zoom !== undefined && options.zoom !== null) {
      animation.zoom = Number(options.zoom);
    }
    this.requireView().animate(animation);
  }

  easeTo(options: { center?: [number, number]; zoom?: number }): void {
    const animation: Record<string, unknown> = { duration: 300 };
    if (options.center) {
      animation.center = this.ns.fromLonLat(options.center);
    }
    if (options.zoom !== undefined && options.zoom !== null) {
      animation.zoom = Number(options.zoom);
    }
    this.requireView().animate(animation);
  }

  setZoom(zoom: number): void {
    this.requireView().setZoom(Number(zoom));
  }

  fitBounds(
    corners: [[number, number], [number, number]],
    options?: { padding?: number; maxZoom?: number; duration?: number },
  ): void {
    const [[west, south], [east, north]] = corners;
    const extent = this.ns.transformExtent(
      [west, south, east, north],
      "EPSG:4326",
      "EPSG:3857",
    );
    const padding = Number(options?.padding ?? 48);
    this.requireView().fit(extent, {
      padding: [padding, padding, padding, padding],
      maxZoom: Number(options?.maxZoom ?? 24),
      size: this.effectiveSize(),
      duration: Number(options?.duration ?? 0),
    });
  }

  getProjection(): { type: "mercator" } {
    return { type: "mercator" };
  }

  setProjection(projection: unknown): void {
    const type =
      typeof projection === "string"
        ? projection
        : isRecord(projection)
          ? String(projection.type ?? "")
          : "";
    if (type !== "mercator") {
      throw new Error(
        `The OpenLayers engine only supports the "mercator" projection (received "${type || "unknown"}"). WebGL globe rendering requires maplibre-gl or mapbox-gl.`,
      );
    }
  }

  /* -------------------------------- events ------------------------------- */

  on(type: string, listener: (event?: unknown) => void): this {
    this.raw.on(type, listener);
    return this;
  }

  off(type: string, listener?: (event?: unknown) => void): this {
    if (listener) {
      this.raw.un(type, listener);
    }
    return this;
  }

  once(type: string, listener: (event?: unknown) => void): this {
    const wrapper = (event?: unknown): void => {
      this.raw.un(type, wrapper);
      listener(event);
    };
    this.raw.on(type, wrapper);
    return this;
  }

  fire(type: string, data?: Record<string, unknown>): this {
    this.raw.dispatchEvent(data ? { type, ...data } : type);
    return this;
  }

  /* ------------------------------ style ---------------------------------- */

  /**
   * change_basemap: swap the base tile layer's XYZ source. MapLibre style
   * documents with vector sources are rejected by resolveBasemapStyle with an
   * actionable message; raster styles and XYZ templates and the built-in
   * basemap aliases all resolve to a tile URL.
   */
  setStyle(style: unknown): void {
    const resolved = resolveBasemapStyle(style, "OpenLayers");
    const source = new this.ns.XYZ({
      url: resolved.url,
      attributions: resolved.attribution ? [resolved.attribution] : undefined,
    });
    if (this.baseLayer) {
      this.baseLayer.setSource(source);
    } else {
      this.baseLayer = new this.ns.TileLayer({ source });
      this.raw.getLayers().insertAt(0, this.baseLayer);
    }
    // change_basemap waits for "style.load"; mirror MapLibre's async fire.
    setTimeout(() => {
      this.fire("style.load");
    }, 0);
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

  /* ------------------------- sources & layers ----------------------------- */

  addSource(id: string, spec: Record<string, unknown>): void {
    if (this.sources.has(id)) {
      throw new Error(`Source already exists: ${id}`);
    }
    this.sources.set(id, new OlShimSource(this, id, spec));
  }

  getSource(id: string): OlShimSource | undefined {
    return this.sources.get(id);
  }

  removeSource(id: string): void {
    const source = this.sources.get(id);
    if (!source) {
      throw new Error(`Source not found: ${id}`);
    }
    // Mirror MapLibre and the Leaflet shim: refuse while layers depend on the
    // source, so dependents are not left rendering from a detached source.
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
        `The OpenLayers engine does not support "${type || "unknown"}" layers (layer "${id}"). Supported types: ${[...GEOJSON_LAYER_TYPES, "raster"].join(", ")}.`,
      );
    }
    const sourceId = String(spec.source ?? "");
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new Error(`Cannot add layer ${id}; source not found: ${sourceId}`);
    }
    // MapLibre's addLayer throws for an unknown beforeId; mirror that instead
    // of silently appending, so the agent can correct itself on every engine.
    if (beforeId && !this.layerOrder.includes(beforeId)) {
      throw new Error(`Cannot add layer ${id}; beforeId not found: ${beforeId}`);
    }
    const layout = isRecord(spec.layout) ? spec.layout : {};
    const entry: OlShimLayer = {
      id,
      type,
      source: sourceId,
      spec: cloneJson(spec),
      visible: layout.visibility !== "none",
      olLayer: null,
    };
    if (type === "raster") {
      if (!source.tileSource) {
        throw new Error(
          `Cannot add raster layer ${id}; source ${sourceId} is not a raster tile source.`,
        );
      }
      const paint = isRecord(spec.paint) ? spec.paint : {};
      entry.olLayer = new this.ns.TileLayer({
        source: source.tileSource,
        opacity: clamp01(Number(paint["raster-opacity"] ?? 1)),
      });
    } else {
      if (!source.vectorSource) {
        throw new Error(
          `Cannot add ${type} layer ${id}; source ${sourceId} is not a GeoJSON source.`,
        );
      }
      entry.olLayer = new this.ns.VectorLayer({
        source: source.vectorSource,
        style: (feature: OpenLayersFeatureLike) => this.styleFor(entry, feature),
      });
    }
    entry.olLayer.setVisible(entry.visible);
    this.layers.set(id, entry);
    if (beforeId && this.layerOrder.includes(beforeId)) {
      this.layerOrder.splice(this.layerOrder.indexOf(beforeId), 0, id);
    } else {
      this.layerOrder.push(id);
    }
    this.syncLayerOrder();
  }

  /** Rebuild the ol layer collection so registry order matches MapLibre order. */
  private syncLayerOrder(): void {
    const collection = this.raw.getLayers();
    for (const entry of this.layers.values()) {
      if (entry.olLayer) {
        collection.remove(entry.olLayer);
      }
    }
    for (const id of this.layerOrder) {
      const entry = this.layers.get(id);
      if (entry?.olLayer) {
        collection.insertAt(collection.getLength(), entry.olLayer);
      }
    }
  }

  getLayer(id: string): Record<string, unknown> | undefined {
    return this.layers.get(id)?.spec;
  }

  removeLayer(id: string): void {
    const entry = this.layers.get(id);
    if (!entry) {
      throw new Error(`Layer not found: ${id}`);
    }
    if (entry.olLayer) {
      this.raw.getLayers().remove(entry.olLayer);
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

  setPaintProperty(id: string, property: string, value: unknown): void {
    const entry = this.requireLayer(id);
    const paint = isRecord(entry.spec.paint) ? { ...entry.spec.paint } : {};
    paint[property] = value;
    entry.spec.paint = paint;
    if (entry.type === "raster" && property === "raster-opacity") {
      entry.olLayer?.setOpacity(clamp01(Number(value)));
    } else {
      entry.olLayer?.changed();
    }
  }

  setLayoutProperty(id: string, property: string, value: unknown): void {
    const entry = this.requireLayer(id);
    const layout = isRecord(entry.spec.layout) ? { ...entry.spec.layout } : {};
    layout[property] = value;
    entry.spec.layout = layout;
    if (property === "visibility") {
      entry.visible = value !== "none";
      entry.olLayer?.setVisible(entry.visible);
    } else {
      entry.olLayer?.changed();
    }
  }

  setFilter(id: string, filter: unknown): void {
    const entry = this.requireLayer(id);
    if (filter === null || filter === undefined) {
      delete entry.spec.filter;
    } else {
      entry.spec.filter = cloneJson(filter);
    }
    entry.olLayer?.changed();
  }

  private requireLayer(id: string): OlShimLayer {
    const entry = this.layers.get(id);
    if (!entry) {
      throw new Error(`Layer not found: ${id}`);
    }
    return entry;
  }

  /* ------------------------------ styling -------------------------------- */

  /**
   * ol style function for one registry layer: evaluates the layer's MapLibre
   * filter and paint (including data-driven expressions via the shared
   * evaluator) into an ol Style.
   */
  private styleFor(entry: OlShimLayer, feature: OpenLayersFeatureLike): unknown {
    const spec = entry.spec;
    const zoom = this.getZoom();
    const geometry = feature.getGeometry();
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(feature.getProperties() ?? {})) {
      if (key !== "geometry") {
        properties[key] = value;
      }
    }
    const context: ExpressionContext = {
      properties,
      geometryType: geometry ? normalizeGeometryType(geometry.getType()) : "",
      zoom,
      id: feature.getId(),
    };
    if (
      spec.filter !== undefined &&
      spec.filter !== null &&
      !expressionTruthy(evaluateExpression(spec.filter, context))
    ) {
      return undefined;
    }
    if (typeof spec.minzoom === "number" && zoom < spec.minzoom) {
      return undefined;
    }
    if (typeof spec.maxzoom === "number" && zoom >= spec.maxzoom) {
      return undefined;
    }
    const paint = isRecord(spec.paint) ? spec.paint : {};
    const layout = isRecord(spec.layout) ? spec.layout : {};
    const ns = this.ns;
    switch (entry.type) {
      case "fill": {
        // MapLibre fills have no outline unless fill-outline-color is set, and
        // fill-opacity applies to the whole layer including that outline —
        // match both, instead of always drawing a dark 35% hairline.
        const fillOpacity = numberValueFrom(paint["fill-opacity"], context, 1);
        const outlineColor = paint["fill-outline-color"];
        return new ns.Style({
          fill: new ns.Fill({
            color: withOpacity(
              colorValueFrom(paint["fill-color"], context, "#1c7ed6"),
              fillOpacity,
            ),
          }),
          stroke:
            outlineColor != null
              ? new ns.Stroke({
                  color: withOpacity(
                    colorValueFrom(outlineColor, context, "#1c7ed6"),
                    fillOpacity,
                  ),
                  width: 1,
                })
              : undefined,
        });
      }
      case "line":
        return new ns.Style({
          stroke: new ns.Stroke({
            color: withOpacity(
              colorValueFrom(paint["line-color"], context, "#1c7ed6"),
              numberValueFrom(paint["line-opacity"], context, 1),
            ),
            width: Math.max(0.5, numberValueFrom(paint["line-width"], context, 1)),
          }),
        });
      case "circle": {
        const strokeWidth = numberValueFrom(
          paint["circle-stroke-width"],
          context,
          0,
        );
        return new ns.Style({
          image: new ns.CircleStyle({
            radius: Math.max(
              0.5,
              numberValueFrom(paint["circle-radius"], context, 5),
            ),
            fill: new ns.Fill({
              color: withOpacity(
                colorValueFrom(paint["circle-color"], context, "#1c7ed6"),
                numberValueFrom(paint["circle-opacity"], context, 1),
              ),
            }),
            stroke:
              strokeWidth > 0
                ? new ns.Stroke({
                    color: withOpacity(
                      colorValueFrom(
                        paint["circle-stroke-color"],
                        context,
                        "#ffffff",
                      ),
                      numberValueFrom(
                        paint["circle-stroke-opacity"],
                        context,
                        1,
                      ),
                    ),
                    width: strokeWidth,
                  })
                : undefined,
          }),
        });
      }
      case "symbol": {
        const text = textFieldTextFrom(layout["text-field"], context);
        if (!text) {
          return undefined;
        }
        const size = Math.max(4, numberValueFrom(layout["text-size"], context, 16));
        return new ns.Style({
          text: new ns.Text({
            text,
            font: `${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`,
            fill: new ns.Fill({
              // Same default as the Leaflet shim: white label with a dark halo
              // so text stays legible over both light and dark tiles.
              color: colorValueFrom(paint["text-color"], context, "#ffffff"),
            }),
            stroke: new ns.Stroke({
              color: "rgba(0, 0, 0, 0.85)",
              width: 3,
            }),
            overflow: true,
          }),
        });
      }
      default:
        return undefined;
    }
  }

  /* ------------------------------ queries -------------------------------- */

  querySourceFeatures(
    sourceId: string,
    options: { sourceLayer?: string; filter?: unknown } = {},
  ): Array<{
    type: "Feature";
    geometry: GeoJSON.Geometry | null;
    properties: Record<string, unknown>;
    id?: string | number;
  }> {
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new Error(`Source not found: ${sourceId}`);
    }
    const zoom = this.getZoom();
    const results: Array<{
      type: "Feature";
      geometry: GeoJSON.Geometry | null;
      properties: Record<string, unknown>;
      id?: string | number;
    }> = [];
    for (const feature of source.resolvedFeatures()) {
      if (
        options.filter !== undefined &&
        options.filter !== null &&
        !expressionTruthy(
          evaluateExpression(options.filter, featureContextFor(feature, zoom)),
        )
      ) {
        continue;
      }
      results.push({
        type: "Feature",
        geometry: feature.geometry ?? null,
        properties: (isRecord(feature.properties)
          ? feature.properties
          : {}) as Record<string, unknown>,
        id: feature.id as string | number | undefined,
      });
    }
    return results;
  }

  /**
   * Pixel hit-testing against the registry (shared hitTestFeature), because
   * ol's forEachFeatureAtPixel depends on a rendered frame that headless
   * environments never produce.
   */
  queryRenderedFeatures(
    point: [number, number],
    options: { layers?: string[]; filter?: unknown } = {},
  ): Array<{
    type: "Feature";
    geometry: GeoJSON.Geometry | null;
    properties: Record<string, unknown>;
    layer: { id: string; type: string; source: string };
  }> {
    const [x, y] = point;
    const zoom = this.getZoom();
    const toPixel: PixelProjector = (coordinate) =>
      this.projectPoint(coordinate[1], coordinate[0]);
    const requested =
      Array.isArray(options.layers) && options.layers.length > 0
        ? new Set(options.layers)
        : null;
    const results: Array<{
      type: "Feature";
      geometry: GeoJSON.Geometry | null;
      properties: Record<string, unknown>;
      layer: { id: string; type: string; source: string };
    }> = [];
    for (const id of this.layerOrder) {
      const entry = this.layers.get(id);
      if (!entry || !entry.visible || !GEOJSON_LAYER_TYPES.includes(entry.type)) {
        continue;
      }
      // Respect the layer's zoom range (as MapLibre and the Leaflet shim do):
      // a minzoom-gated layer is not rendered, so it must not be hit-tested.
      if (
        (typeof entry.spec.minzoom === "number" && zoom < entry.spec.minzoom) ||
        (typeof entry.spec.maxzoom === "number" && zoom >= entry.spec.maxzoom)
      ) {
        continue;
      }
      if (requested && !requested.has(id)) {
        continue;
      }
      const source = this.sources.get(entry.source);
      if (!source) {
        continue;
      }
      for (const feature of source.resolvedFeatures()) {
        const context = featureContextFor(feature, zoom);
        if (
          entry.spec.filter !== undefined &&
          entry.spec.filter !== null &&
          !expressionTruthy(evaluateExpression(entry.spec.filter, context))
        ) {
          continue;
        }
        if (!hitTestFeature(entry.spec, feature, x, y, toPixel, context)) {
          continue;
        }
        results.push({
          type: "Feature",
          geometry: feature.geometry ?? null,
          properties: (isRecord(feature.properties)
            ? feature.properties
            : {}) as Record<string, unknown>,
          layer: { id: entry.id, type: entry.type, source: entry.source },
        });
      }
    }
    return results;
  }

  /* ------------------------- unsupported surfaces ------------------------- */

  getCanvas(): {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    toDataURL(): string;
  } {
    const [width, height] = this.effectiveSize();
    return {
      clientWidth: width,
      clientHeight: height,
      width,
      height,
      toDataURL(): never {
        throw new Error(
          "Map screenshots are not supported by the OpenLayers engine. Capture map.getViewport() with a DOM screenshot library (e.g. html2canvas) instead.",
        );
      },
    };
  }

  setTerrain(_terrain: unknown): never {
    throw new Error(
      "Terrain (raster-dem) is not supported by the OpenLayers engine.",
    );
  }

  // No setSky on purpose: the tools detect the missing method and report
  // "Sky is not supported by this map engine." — same as mapbox-gl.

  /* --------------------------- markers & popups --------------------------- */

  /**
   * GeoAgentMarker-compatible wrapper around an ol Overlay holding a teardrop
   * pin element, so addMarkerOverlay behaves like the other engines.
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
    element.className = "geoagent-openlayers-marker-icon";
    element.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 36" width="26" height="36"><path d="M13 0C5.8 0 0 5.8 0 13c0 9.8 11.6 22.2 12.1 22.7.5.5 1.3.5 1.8 0C14.4 35.2 26 22.8 26 13 26 5.8 20.2 0 13 0z" fill="${safeColor}"/><circle cx="13" cy="13" r="5.5" fill="#ffffff"/></svg>`;
    const ns = this.ns;
    const raw = this.raw;
    const overlay = new ns.Overlay({
      element,
      positioning: "bottom-center",
      offset: [0, -2],
      stopEvent: true,
      insertFirst: false,
    });
    let position: [number, number] | null = null;
    let popupOverlay: OpenLayersOverlayLike | null = null;
    let closeHandler: ((event?: unknown) => void) | null = null;
    const closePopup = (): void => {
      if (popupOverlay) {
        raw.removeOverlay(popupOverlay);
      }
      if (closeHandler) {
        raw.un("click", closeHandler);
        closeHandler = null;
      }
    };
    const self = {
      setLngLat(lngLat: [number, number]): unknown {
        position = [lngLat[0], lngLat[1]];
        overlay.setPosition(ns.fromLonLat([lngLat[0], lngLat[1]]));
        return self;
      },
      addTo(map: unknown): unknown {
        const host = isOpenLayersMapShim(map)
          ? map.getRawMap()
          : (map as OpenLayersMapLike);
        host.addOverlay(overlay);
        return self;
      },
      setPopup(popup: unknown): unknown {
        const content = extractOpenLayersPopupElement(popup);
        if (!content) {
          return self;
        }
        popupOverlay = new ns.Overlay({
          element: content,
          positioning: "bottom-center",
          offset: [0, -38],
          stopEvent: true,
          insertFirst: false,
          className: "geoagent-openlayers-popup",
        });
        element.addEventListener("click", () => {
          if (!position || !popupOverlay) {
            return;
          }
          popupOverlay.setPosition(ns.fromLonLat(position));
          raw.addOverlay(popupOverlay);
          if (!closeHandler) {
            closeHandler = () => closePopup();
            raw.on("click", closeHandler);
          }
        });
        return self;
      },
      getElement(): HTMLElement {
        return element;
      },
      remove(): unknown {
        closePopup();
        raw.removeOverlay(overlay);
        return undefined;
      },
    };
    return self;
  }

  /** GeoAgentPopup-compatible wrapper around an overlay content element. */
  createPopup(): {
    setText(text: string): unknown;
    __geoAgentOpenLayersPopupElement: HTMLElement;
  } {
    const element = document.createElement("div");
    element.className = "geoagent-openlayers-popup-content";
    const self = {
      setText(text: string): unknown {
        element.textContent = text;
        return self;
      },
      __geoAgentOpenLayersPopupElement: element,
    };
    return self;
  }

  /* ------------------------------ teardown -------------------------------- */

  /**
   * Unbind the shim's map listeners. Called by the tools layer on dispose;
   * without it, re-attaching to the same map leaks one handler per attach,
   * and stale handlers keep re-syncing detached sources on every pan.
   */
  destroy(): void {
    this.raw.un("moveend", this.clusterHandler);
  }
}

function extractOpenLayersPopupElement(popup: unknown): HTMLElement | null {
  if (
    isRecord(popup) &&
    (popup as { __geoAgentOpenLayersPopupElement?: unknown })
      .__geoAgentOpenLayersPopupElement instanceof HTMLElement
  ) {
    return (popup as { __geoAgentOpenLayersPopupElement: HTMLElement })
      .__geoAgentOpenLayersPopupElement;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Factory + control mounting                                                 */
/* -------------------------------------------------------------------------- */

export function createOpenLayersMapShim(
  map: OpenLayersMapLike,
  namespace: Record<string, unknown>,
): OpenLayersMapShim {
  return new OpenLayersMapShim(map, namespace);
}

export function isOpenLayersMapShim(value: unknown): value is OpenLayersMapShim {
  return value instanceof OpenLayersMapShim;
}

export interface OpenLayersControlAttachment {
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
 * Attach a GeoAgentControl to an OpenLayers map.
 *
 * OpenLayers has no map.addControl slot for foreign controls, so this mounts
 * the control element into the viewport's .ol-overlaycontainer-stopevent (the
 * same place ol's own controls live) and absolutely positions it in the
 * requested corner. The control must have been created with mapEngine
 * { kind: "openlayers", namespace }.
 *
 *   const control = new GeoAgentControl({ mapEngine: { kind: "openlayers", namespace } });
 *   const attachment = addGeoAgentToOpenLayersMap(control, map, { position: "top-left" });
 *   // later: attachment.remove();
 */
export function addGeoAgentToOpenLayersMap(
  control: GeoAgentControl,
  map: OpenLayersMapLike,
  options?: { position?: string },
): OpenLayersControlAttachment {
  if (!isOpenLayersMap(map)) {
    throw new Error(
      "addGeoAgentToOpenLayersMap expects an OpenLayers map instance created with new Map(...).",
    );
  }
  const internal = control as unknown as {
    options?: { position?: string; mapEngine?: { kind?: string } };
    onRemove(): void;
  };
  const engineKind = internal.options?.mapEngine?.kind;
  if (engineKind && engineKind !== "openlayers") {
    throw new Error(
      `GeoAgentControl was created with mapEngine.kind "${engineKind}"; OpenLayers hosts need { kind: "openlayers", namespace }.`,
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
  // The panel is appended to the map container (target element) and absolutely
  // positioned; make sure that container is a positioning context.
  const target = map.getTargetElement?.();
  if (target && window.getComputedStyle(target).position === "static") {
    target.style.position = "relative";
  }
  const element = control.onAdd(map as unknown as MapLibreMap);
  element.classList.add("geoagent-openlayers-control");
  const [vertical, horizontal] = position.split("-") as [string, string];
  const viewport = map.getViewport();
  const host =
    viewport.querySelector<HTMLElement>(".ol-overlaycontainer-stopevent") ??
    viewport;
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
  host.appendChild(element);
  return {
    remove(): void {
      internal.onRemove.call(control);
      element.remove();
    },
  };
}
