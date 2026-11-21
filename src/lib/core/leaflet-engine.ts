/**
 * Leaflet host support for the GeoAgent control.
 *
 * The GeoAgent tools drive the map through the MapLibre GL JS API surface:
 * Style Spec sources/layers, setStyle, queryRenderedFeatures, and friends.
 * Leaflet has none of that — its layers are objects (TileLayer, GeoJSON,
 * Marker) and there is no style document.
 *
 * LeafletMapShim bridges the gap. It keeps a Style-Spec-like registry of
 * sources and layers, materializes them as real Leaflet layers, and exposes
 * the subset of the maplibregl.Map API that the tools call. Capabilities
 * Leaflet genuinely lacks (globe projection, terrain, sky, 3D buildings,
 * canvas screenshots) throw explicit errors instead of failing silently —
 * the same contract the README documents for mapbox-gl hosts.
 *
 * Nothing here imports Leaflet; hosts pass their own namespace:
 *
 *   import L from "leaflet";
 *   new GeoAgentControl({ mapEngine: { kind: "leaflet", namespace: L } })
 *   addGeoAgentToLeafletMap(control, map); // Leaflet has no map.addControl
 */

import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoAgentControl } from "./GeoAgentControl";

/* -------------------------------------------------------------------------- */
/* Structural Leaflet types (the shim never imports leaflet itself)           */
/* -------------------------------------------------------------------------- */

export interface LeafletLatLngLike {
  lat: number;
  lng: number;
}

export interface LeafletPointLike {
  x: number;
  y: number;
}

export interface LeafletBoundsLike {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}

export interface LeafletMapLike {
  getContainer(): HTMLElement;
  getCenter(): LeafletLatLngLike;
  getZoom(): number;
  getBounds(): LeafletBoundsLike;
  getSize(): LeafletPointLike;
  setView(center: unknown, zoom?: number, options?: unknown): unknown;
  flyTo(center: unknown, zoom?: number, options?: unknown): unknown;
  fitBounds(bounds: unknown, options?: unknown): unknown;
  setZoom(zoom: number, options?: unknown): unknown;
  project(latlng: unknown, zoom?: number): LeafletPointLike;
  latLngToContainerPoint(latlng: unknown): LeafletPointLike;
  containerPointToLatLng(point: unknown): LeafletLatLngLike;
  addLayer(layer: unknown): unknown;
  removeLayer(layer: unknown): unknown;
  hasLayer(layer: unknown): boolean;
  eachLayer(method: (layer: unknown) => void): unknown;
  createPane(name: string, container?: HTMLElement): HTMLElement;
  getPane(name: string): HTMLElement | undefined;
  whenReady(callback: () => void): unknown;
  on(type: string, fn: (event?: unknown) => void, context?: unknown): unknown;
  once(type: string, fn: (event?: unknown) => void, context?: unknown): unknown;
  off(type: string, fn?: (event?: unknown) => void, context?: unknown): unknown;
  fire(type: string, data?: unknown): unknown;
}

interface LeafletLayerLike {
  addTo(map: unknown): unknown;
  remove(): unknown;
}

interface TileLayerLike extends LeafletLayerLike {
  setOpacity(opacity: number): unknown;
}

interface GeoJSONLayerLike extends LeafletLayerLike {
  addData(data: unknown): unknown;
  clearLayers(): unknown;
}

interface MarkerLike extends LeafletLayerLike {
  setLatLng(latlng: unknown): unknown;
  bindPopup(popup: unknown): unknown;
  getElement(): HTMLElement | undefined;
}

interface PopupLike {
  setContent(content: unknown): unknown;
}

interface LeafletFactory {
  tileLayer(url: string, options?: Record<string, unknown>): TileLayerLike;
  geoJSON(data?: unknown, options?: Record<string, unknown>): GeoJSONLayerLike;
  marker(latlng: [number, number], options?: Record<string, unknown>): MarkerLike;
  circleMarker(
    latlng: [number, number],
    options?: Record<string, unknown>,
  ): LeafletLayerLike;
  popup(options?: Record<string, unknown>): PopupLike;
  divIcon(options: Record<string, unknown>): unknown;
  imageOverlay(
    url: string,
    bounds: unknown,
    options?: Record<string, unknown>,
  ): TileLayerLike;
}

const REQUIRED_LEAFLET_FACTORIES = [
  "tileLayer",
  "geoJSON",
  "marker",
  "circleMarker",
  "popup",
  "divIcon",
  "imageOverlay",
] as const;

function asLeafletFactory(namespace: Record<string, unknown>): LeafletFactory {
  for (const key of REQUIRED_LEAFLET_FACTORIES) {
    if (typeof namespace[key] !== "function") {
      throw new Error(
        `mapEngine.namespace for the Leaflet engine must be the Leaflet factory object (L); missing L.${key}().`,
      );
    }
  }
  return namespace as unknown as LeafletFactory;
}

/** Duck-type check: does this look like a Leaflet map instance? */
export function isLeafletMap(value: unknown): value is LeafletMapLike {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.setView === "function" &&
    typeof value.addLayer === "function" &&
    typeof value.latLngToContainerPoint === "function" &&
    typeof value.getCenter === "function"
  );
}

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeCssColor(value: string): string {
  return /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgba?\([\d.,\s%]+\)|hsla?\([\d.,\s%deg]+\))$/.test(
    value.trim(),
  )
    ? value.trim()
    : "#3388ff";
}

function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

export function normalizeFeatureCollection(input: unknown): GeoJSON.FeatureCollection {
  if (!isRecord(input)) {
    return emptyFeatureCollection();
  }
  const value = input as { type?: unknown; features?: unknown };
  if (value.type === "FeatureCollection" && Array.isArray(value.features)) {
    return input as unknown as GeoJSON.FeatureCollection;
  }
  if (value.type === "Feature") {
    return {
      type: "FeatureCollection",
      features: [input as unknown as GeoJSON.Feature],
    };
  }
  if (typeof value.type === "string") {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: input as unknown as GeoJSON.Geometry,
          properties: {},
        },
      ],
    };
  }
  return emptyFeatureCollection();
}

export function normalizeGeometryType(type: string): string {
  switch (type) {
    case "MultiPoint":
      return "Point";
    case "MultiLineString":
      return "LineString";
    case "MultiPolygon":
      return "Polygon";
    default:
      return type;
  }
}

/* -------------------------------------------------------------------------- */
/* MapLibre expression subset evaluator                                       */
/* -------------------------------------------------------------------------- */

export interface ExpressionContext {
  properties?: Record<string, unknown> | null;
  geometryType?: string;
  zoom?: number;
  id?: unknown;
}

export function expressionTruthy(value: unknown): boolean {
  if (value === false || value === null || value === undefined) {
    return false;
  }
  if (typeof value === "number") {
    return !Number.isNaN(value);
  }
  return true;
}

function looseEquals(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  return left == null && right == null;
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return Number.NaN;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(value: unknown): RgbColor | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(text);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      const parts = digits.split("").map((digit) => parseInt(digit + digit, 16));
      return {
        r: parts[0],
        g: parts[1],
        b: parts[2],
        a: parts.length > 3 ? parts[3] / 255 : 1,
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: parseInt(digits.slice(0, 2), 16),
        g: parseInt(digits.slice(2, 4), 16),
        b: parseInt(digits.slice(4, 6), 16),
        a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return {
        r: parts[0],
        g: parts[1],
        b: parts[2],
        a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1,
      };
    }
  }
  return null;
}

function formatColor(color: RgbColor): string {
  const clamp = (value: number): number =>
    Math.max(0, Math.min(255, Math.round(value)));
  const toHex = (value: number): string =>
    clamp(value).toString(16).padStart(2, "0");
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function lerpColor(from: RgbColor, to: RgbColor, ratio: number): RgbColor {
  return {
    r: from.r + (to.r - from.r) * ratio,
    g: from.g + (to.g - from.g) * ratio,
    b: from.b + (to.b - from.b) * ratio,
    a: from.a + (to.a - from.a) * ratio,
  };
}

/**
 * Evaluate the subset of MapLibre Style Spec expressions and legacy filters
 * the tools generate (geometry-type / get / has / step / interpolate /
 * comparisons). Unknown operators resolve to undefined, matching how an
 * unmatched paint property falls back to its default.
 */
export function evaluateExpression(
  expression: unknown,
  context: ExpressionContext,
): unknown {
  if (!Array.isArray(expression) || expression.length === 0) {
    return expression;
  }
  const [operator, ...args] = expression;
  if (typeof operator !== "string") {
    return expression;
  }
  const evaluate = (value: unknown): unknown =>
    evaluateExpression(value, context);
  const toNumber = (value: unknown, fallback = 0): number => {
    const parsed = Number(evaluate(value));
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  switch (operator) {
    case "literal":
      return args[0];
    case "get": {
      if (args.length >= 2 && isRecord(args[1])) {
        return (args[1] as Record<string, unknown>)[String(args[0])];
      }
      return context.properties?.[String(args[0])];
    }
    case "has": {
      if (args.length >= 2 && isRecord(args[1])) {
        return (args[1] as Record<string, unknown>)[String(args[0])] !== undefined;
      }
      return context.properties?.[String(args[0])] !== undefined;
    }
    case "properties":
      return context.properties ?? {};
    case "geometry-type":
      return context.geometryType ?? "";
    case "id":
      return context.id ?? null;
    case "zoom":
      return context.zoom ?? 0;
    case "pi":
      return Math.PI;
    case "e":
      return Math.E;
    case "!":
      return !expressionTruthy(evaluate(args[0]));
    case "all":
      return args.every((arg) => expressionTruthy(evaluate(arg)));
    case "any":
      return args.some((arg) => expressionTruthy(evaluate(arg)));
    case "==":
    case "!=":
    case ">":
    case ">=":
    case "<":
    case "<=": {
      // Legacy filters compare a bare property name against a literal value:
      // ["==", "name", "foo"]. Expression filters wrap the input: ["==",
      // ["get", "name"], "foo"]. A string first operand selects legacy mode.
      const legacy = typeof args[0] === "string";
      const left = legacy
        ? context.properties?.[args[0] as string]
        : evaluate(args[0]);
      const right = legacy ? args[1] : evaluate(args[1]);
      switch (operator) {
        case "==":
          return looseEquals(left, right);
        case "!=":
          return !looseEquals(left, right);
        case ">":
          return compareValues(left, right) > 0;
        case ">=":
          return compareValues(left, right) >= 0;
        case "<":
          return compareValues(left, right) < 0;
        default:
          return compareValues(left, right) <= 0;
      }
    }
    case "in": {
      const needle = evaluate(args[0]);
      const haystack = evaluate(args[1]);
      if (Array.isArray(haystack)) {
        return haystack.some((item) => looseEquals(item, needle));
      }
      if (typeof haystack === "string" && typeof needle === "string") {
        return haystack.includes(needle);
      }
      return false;
    }
    case "!has": {
      // Legacy negated existence filter: ["!has", "prop"].
      return context.properties?.[String(args[0])] === undefined;
    }
    case "!in": {
      // Legacy negated membership filter: ["!in", "prop", v1, v2, ...].
      const legacy = typeof args[0] === "string";
      const needle = legacy ? context.properties?.[args[0] as string] : evaluate(args[0]);
      const haystack = legacy ? args.slice(1) : [evaluate(args[1])];
      return !haystack.some((item) =>
        looseEquals(legacy ? item : evaluate(item), needle),
      );
    }
    case "nin": {
      const needle = evaluate(args[0]);
      const haystack = evaluate(args[1]);
      if (Array.isArray(haystack)) {
        return !haystack.some((item) => looseEquals(item, needle));
      }
      return true;
    }
    case "case": {
      for (let index = 0; index + 1 < args.length; index += 2) {
        if (expressionTruthy(evaluate(args[index]))) {
          return evaluate(args[index + 1]);
        }
      }
      return args.length % 2 === 1 ? evaluate(args[args.length - 1]) : null;
    }
    case "match": {
      const input = evaluate(args[0]);
      for (let index = 1; index + 1 < args.length; index += 2) {
        const labels: unknown[] = Array.isArray(args[index])
          ? (args[index] as unknown[])
          : [args[index]];
        if (labels.some((label) => looseEquals(label, input))) {
          return evaluate(args[index + 1]);
        }
      }
      return args.length % 2 === 0 ? evaluate(args[args.length - 1]) : null;
    }
    case "coalesce": {
      for (const arg of args) {
        const value = evaluate(arg);
        if (value !== null && value !== undefined) {
          return value;
        }
      }
      return null;
    }
    case "step": {
      const input = toNumber(args[0]);
      let output = evaluate(args[1]);
      for (let index = 2; index + 1 < args.length; index += 2) {
        const stop = Number(args[index]);
        if (!Number.isFinite(stop) || input < stop) {
          break;
        }
        output = evaluate(args[index + 1]);
      }
      return output;
    }
    case "interpolate": {
      const input = toNumber(args[1]);
      const stops: Array<[number, unknown]> = [];
      for (let index = 2; index + 1 < args.length; index += 2) {
        const stop = Number(args[index]);
        if (Number.isFinite(stop)) {
          stops.push([stop, args[index + 1]]);
        }
      }
      if (stops.length === 0) {
        return null;
      }
      if (input <= stops[0][0]) {
        return evaluate(stops[0][1]);
      }
      const last = stops[stops.length - 1];
      if (input >= last[0]) {
        return evaluate(last[1]);
      }
      for (let index = 0; index + 1 < stops.length; index += 1) {
        const [stop0, out0] = stops[index];
        const [stop1, out1] = stops[index + 1];
        if (input >= stop0 && input <= stop1) {
          const value0 = evaluate(out0);
          const value1 = evaluate(out1);
          const ratio = stop1 === stop0 ? 0 : (input - stop0) / (stop1 - stop0);
          const number0 = Number(value0);
          const number1 = Number(value1);
          if (Number.isFinite(number0) && Number.isFinite(number1)) {
            return number0 + (number1 - number0) * ratio;
          }
          const color0 = parseColor(value0);
          const color1 = parseColor(value1);
          if (color0 && color1) {
            return formatColor(lerpColor(color0, color1, ratio));
          }
          return ratio < 0.5 ? value0 : value1;
        }
      }
      return evaluate(last[1]);
    }
    case "+":
      return args.reduce<number>((sum, arg) => sum + toNumber(arg), 0);
    case "*":
      return args.reduce<number>(
        (product, arg) => product * toNumber(arg, 1),
        1,
      );
    case "-":
      return args.length === 1 ? -toNumber(args[0]) : toNumber(args[0]) - toNumber(args[1]);
    case "/":
      return toNumber(args[0]) / toNumber(args[1]);
    case "%": {
      const divisor = toNumber(args[1]);
      return divisor === 0 ? 0 : toNumber(args[0]) % divisor;
    }
    case "min":
      return Math.min(...args.map((arg) => toNumber(arg)));
    case "max":
      return Math.max(...args.map((arg) => toNumber(arg)));
    case "abs":
      return Math.abs(toNumber(args[0]));
    case "round":
      return Math.round(toNumber(args[0]));
    case "floor":
      return Math.floor(toNumber(args[0]));
    case "ceil":
      return Math.ceil(toNumber(args[0]));
    case "to-number": {
      const parsed = Number(evaluate(args[0]));
      return Number.isFinite(parsed) ? parsed : null;
    }
    case "to-string": {
      const value = evaluate(args[0]);
      return value == null ? "" : String(value);
    }
    case "to-boolean":
      return expressionTruthy(evaluate(args[0]));
    case "to-color": {
      const value = evaluate(args[0]);
      return typeof value === "string" ? value : null;
    }
    case "concat":
      return args.map((arg) => String(evaluate(arg) ?? "")).join("");
    case "length": {
      const value = evaluate(args[0]);
      return Array.isArray(value) || typeof value === "string"
        ? value.length
        : 0;
    }
    case "at": {
      const value = evaluate(args[1]);
      const index = toNumber(args[0]);
      return Array.isArray(value) ? (value[index] ?? null) : null;
    }
    case "slice": {
      const value = evaluate(args[0]);
      const start = toNumber(args[1]);
      const end = args.length > 2 ? toNumber(args[2]) : undefined;
      if (Array.isArray(value)) {
        return value.slice(start, end);
      }
      if (typeof value === "string") {
        return value.slice(start, end);
      }
      return null;
    }
    default:
      return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Grid clustering (Leaflet has no native cluster source)                     */
/* -------------------------------------------------------------------------- */

function abbreviateCount(count: number): string {
  if (count >= 10000) {
    return `${Math.round(count / 1000)}k`;
  }
  if (count >= 1000) {
    return `${Math.round(count / 100) / 10}k`;
  }
  return String(count);
}

/**
 * Greedy grid clustering over Point features, mirroring the maplibre-gl
 * cluster source closely enough for the cluster tools: merged points carry
 * point_count / point_count_abbreviated properties, single points pass
 * through untouched. Non-point features are always passed through.
 */
export function computeClusteredFeatures(
  features: GeoJSON.Feature[],
  radiusPx: number,
  project: (lat: number, lng: number) => LeafletPointLike,
): GeoJSON.Feature[] {
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) {
    return features;
  }
  const cell = radiusPx;
  const clusters: Array<{
    x: number;
    y: number;
    latSum: number;
    lngSum: number;
    count: number;
    first: GeoJSON.Feature;
  }> = [];
  const grid = new Map<string, number[]>();
  const passThrough: GeoJSON.Feature[] = [];

  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry || geometry.type !== "Point") {
      passThrough.push(feature);
      continue;
    }
    const [lng, lat] = geometry.coordinates as [number, number];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      passThrough.push(feature);
      continue;
    }
    const point = project(lat, lng);
    const cellX = Math.floor(point.x / cell);
    const cellY = Math.floor(point.y / cell);
    let bestIndex = -1;
    let bestDistance = radiusPx * radiusPx;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const indices = grid.get(`${cellX + dx}:${cellY + dy}`);
        if (!indices) {
          continue;
        }
        for (const index of indices) {
          const cluster = clusters[index];
          const distance =
            (cluster.x - point.x) * (cluster.x - point.x) +
            (cluster.y - point.y) * (cluster.y - point.y);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
          }
        }
      }
    }
    if (bestIndex >= 0) {
      const cluster = clusters[bestIndex];
      cluster.x = (cluster.x * cluster.count + point.x) / (cluster.count + 1);
      cluster.y = (cluster.y * cluster.count + point.y) / (cluster.count + 1);
      cluster.count += 1;
      cluster.latSum += lat;
      cluster.lngSum += lng;
    } else {
      const index = clusters.length;
      clusters.push({
        x: point.x,
        y: point.y,
        latSum: lat,
        lngSum: lng,
        count: 1,
        first: feature,
      });
      const key = `${cellX}:${cellY}`;
      const bucket = grid.get(key);
      if (bucket) {
        bucket.push(index);
      } else {
        grid.set(key, [index]);
      }
    }
  }

  const result: GeoJSON.Feature[] = [...passThrough];
  for (const cluster of clusters) {
    if (cluster.count === 1) {
      result.push(cluster.first);
      continue;
    }
    result.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [
          cluster.lngSum / cluster.count,
          cluster.latSum / cluster.count,
        ],
      },
      properties: {
        ...(isRecord(cluster.first.properties)
          ? (cluster.first.properties as Record<string, unknown>)
          : {}),
        cluster: true,
        point_count: cluster.count,
        point_count_abbreviated: abbreviateCount(cluster.count),
      },
    });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Basemap resolution                                                         */
/* -------------------------------------------------------------------------- */

const OSM_TILES = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "&copy; OpenStreetMap contributors",
};
const CARTO_ATTRIBUTION = "&copy; OpenStreetMap contributors &copy; CARTO";

/**
 * MapLibre vector style URLs (the DEFAULT_BASEMAPS values) cannot be rendered
 * by Leaflet. Known basemap names/URLs map to raster XYZ equivalents; anything
 * else must be a {z}/{x}/{y} template or a style document with a raster source.
 */
export const LEAFLET_BASEMAP_TILES: Record<
  string,
  { url: string; attribution: string }
> = {
  liberty: OSM_TILES,
  "https://tiles.openfreemap.org/styles/liberty": OSM_TILES,
  osm: OSM_TILES,
  openstreetmap: OSM_TILES,
  demotiles: OSM_TILES,
  "https://demotiles.maplibre.org/style.json": OSM_TILES,
  positron: {
    url: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    attribution: CARTO_ATTRIBUTION,
  },
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json": {
    url: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    attribution: CARTO_ATTRIBUTION,
  },
  dark: {
    url: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    attribution: CARTO_ATTRIBUTION,
  },
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json": {
    url: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    attribution: CARTO_ATTRIBUTION,
  },
  voyager: {
    url: "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    attribution: CARTO_ATTRIBUTION,
  },
  "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json": {
    url: "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    attribution: CARTO_ATTRIBUTION,
  },
};

export function resolveBasemapStyle(
  style: unknown,
  engineName = "Leaflet",
): {
  url: string;
  attribution: string;
} {
  if (typeof style === "string") {
    const trimmed = style.trim();
    const alias =
      LEAFLET_BASEMAP_TILES[trimmed.toLowerCase()] ??
      LEAFLET_BASEMAP_TILES[trimmed];
    if (alias) {
      return alias;
    }
    if (/\{z\}/.test(trimmed) && (/\{x\}/.test(trimmed) || /\{s\}/.test(trimmed))) {
      return { url: trimmed, attribution: "" };
    }
    throw new Error(
      `The ${engineName} engine cannot load basemap "${trimmed}". Pass an XYZ raster tile URL template (containing {z}/{x}/{y}), a built-in basemap name (${Object.keys(LEAFLET_BASEMAP_TILES).filter((key) => !key.startsWith("http")).join(", ")}), or a style document with a raster source. Vector styles require maplibre-gl or mapbox-gl.`,
    );
  }
  if (isRecord(style)) {
    const sources = isRecord(style.sources) ? style.sources : {};
    for (const source of Object.values(sources)) {
      if (
        isRecord(source) &&
        source.type === "raster" &&
        Array.isArray(source.tiles) &&
        typeof source.tiles[0] === "string"
      ) {
        return {
          url: source.tiles[0],
          attribution:
            typeof source.attribution === "string" ? source.attribution : "",
        };
      }
    }
    throw new Error(
      `The ${engineName} engine cannot load this style document: no raster source with a tiles URL was found. Vector styles require maplibre-gl or mapbox-gl.`,
    );
  }
  throw new Error(
    `Unsupported style argument for the ${engineName} engine: ${String(style)}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Source / layer registry                                                    */
/* -------------------------------------------------------------------------- */

interface ShimLayerEntry {
  spec: Record<string, unknown>;
  leaflet: LeafletLayerLike | null;
  paneName: string | null;
}

class ShimSource {
  readonly id: string;
  readonly type: string;
  readonly cluster: boolean;
  readonly clusterRadius: number;
  readonly clusterMaxZoom: number;
  spec: Record<string, unknown>;
  data: GeoJSON.FeatureCollection = emptyFeatureCollection();
  private clusterCache: { zoom: number; features: GeoJSON.Feature[] } | null =
    null;
  private readonly shim: LeafletMapShim;

  constructor(shim: LeafletMapShim, id: string, spec: Record<string, unknown>) {
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
              `Leaflet engine: could not load GeoJSON source "${id}":`,
              error,
            );
          });
      } else {
        this.data = normalizeFeatureCollection(data);
      }
    }
  }

  setData(data: unknown): void {
    this.data = normalizeFeatureCollection(data);
    this.spec.data = data;
    this.clusterCache = null;
    this.shim.refreshLayersForSource(this.id);
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
            (lat, lng) => this.shim.projectPoint(lat, lng, zoom),
          );
    this.clusterCache = { zoom, features };
    return features;
  }
}

/* -------------------------------------------------------------------------- */
/* The shim                                                                   */
/* -------------------------------------------------------------------------- */

const GEOJSON_LAYER_TYPES = ["fill", "line", "circle", "symbol"];

export class LeafletMapShim {
  private readonly raw: LeafletMapLike;
  private readonly factory: LeafletFactory;
  private readonly sources = new Map<string, ShimSource>();
  private readonly layers = new Map<string, ShimLayerEntry>();
  private layerOrder: string[] = [];
  private baseTileLayer: TileLayerLike | null = null;
  private basePaneName: string | null = null;
  private paneSeq = 0;
  private ready = false;

  constructor(map: LeafletMapLike, namespace: Record<string, unknown>) {
    this.raw = map;
    this.factory = asLeafletFactory(namespace);
    let foundBase = false;
    this.raw.eachLayer((layer) => {
      if (
        !foundBase &&
        isRecord(layer) &&
        typeof (layer as { getURL?: unknown }).getURL === "function"
      ) {
        this.baseTileLayer = layer as unknown as TileLayerLike;
        foundBase = true;
      }
    });
    this.raw.whenReady(() => {
      this.ready = true;
    });
    if ((this.raw as unknown as { _loaded?: boolean })._loaded === true) {
      this.ready = true;
    }
    this.raw.on("zoomend", () => this.handleZoomChange());
  }

  /** The real Leaflet map instance behind this shim. */
  getRawMap(): LeafletMapLike {
    return this.raw;
  }

  /* ------------------------- map basics ------------------------- */

  getContainer(): HTMLElement {
    return this.raw.getContainer();
  }

  getCenter(): LeafletLatLngLike {
    return this.raw.getCenter();
  }

  getZoom(): number {
    return this.raw.getZoom();
  }

  getBounds(): LeafletBoundsLike {
    return this.raw.getBounds();
  }

  getSize(): LeafletPointLike {
    return this.raw.getSize();
  }

  /** Leaflet core has no rotation or tilt. */
  getBearing(): number {
    return 0;
  }

  /** Leaflet core has no rotation or tilt. */
  getPitch(): number {
    return 0;
  }

  loaded(): boolean {
    return (
      this.ready ||
      (this.raw as unknown as { _loaded?: boolean })._loaded === true
    );
  }

  projectPoint(lat: number, lng: number, zoom?: number): LeafletPointLike {
    return this.raw.project([lat, lng], zoom);
  }

  jumpTo(options: { center?: [number, number]; zoom?: number }): void {
    const center = options.center ?? [
      this.raw.getCenter().lng,
      this.raw.getCenter().lat,
    ];
    this.raw.setView(
      [center[1], center[0]],
      options.zoom ?? this.raw.getZoom(),
      { animate: false },
    );
  }

  flyTo(options: { center?: [number, number]; zoom?: number }): void {
    const center = options.center ?? [
      this.raw.getCenter().lng,
      this.raw.getCenter().lat,
    ];
    this.raw.flyTo([center[1], center[0]], options.zoom ?? this.raw.getZoom());
  }

  easeTo(options: { center?: [number, number]; zoom?: number }): void {
    const center = options.center ?? [
      this.raw.getCenter().lng,
      this.raw.getCenter().lat,
    ];
    this.raw.flyTo([center[1], center[0]], options.zoom ?? this.raw.getZoom(), {
      duration: 0.3,
    });
  }

  setZoom(zoom: number): void {
    this.raw.setZoom(zoom);
  }

  fitBounds(
    corners: [[number, number], [number, number]],
    options?: { padding?: number; maxZoom?: number },
  ): void {
    const [[west, south], [east, north]] = corners;
    const padding = typeof options?.padding === "number" ? options.padding : 0;
    const fitOptions: Record<string, unknown> = {
      padding: [padding, padding],
    };
    if (options?.maxZoom != null) {
      fitOptions.maxZoom = options.maxZoom;
    }
    this.raw.fitBounds(
      [
        [south, west],
        [north, east],
      ],
      fitOptions,
    );
  }

  setProjection(projection: unknown): void {
    const name =
      typeof projection === "string"
        ? projection
        : String((projection as { type?: unknown })?.type ?? "mercator");
    if (name === "mercator") {
      return;
    }
    throw new Error(
      `The Leaflet engine renders Web Mercator only; projection "${name}" is not supported.`,
    );
  }

  getProjection(): { type: "mercator" } {
    return { type: "mercator" };
  }

  /* ------------------------- events ------------------------- */

  on(type: string, listener: (event?: unknown) => void): this {
    this.raw.on(type, listener);
    return this;
  }

  once(type: string, listener: (event?: unknown) => void): this {
    this.raw.once(type, listener);
    return this;
  }

  off(type: string, listener?: (event?: unknown) => void): this {
    this.raw.off(type, listener);
    return this;
  }

  fire(type: string, data?: Record<string, unknown>): this {
    this.raw.fire(type, data);
    return this;
  }

  /* ------------------------- style & basemap ------------------------- */

  setStyle(style: unknown): void {
    const resolved = resolveBasemapStyle(style);
    if (this.baseTileLayer) {
      this.raw.removeLayer(this.baseTileLayer);
      this.baseTileLayer = null;
    }
    const pane = this.ensureBasePane();
    const tileLayer = this.factory.tileLayer(resolved.url, {
      pane,
      attribution: resolved.attribution,
      maxZoom: 24,
      tileSize: 256,
    });
    this.raw.addLayer(tileLayer);
    this.baseTileLayer = tileLayer;
    // maplibre fires style.load asynchronously once the new style is usable;
    // keep the same contract so waitForMapEvent("style.load") resolves.
    window.setTimeout(() => this.raw.fire("style.load", {}), 0);
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
    return {
      version: 8,
      sources,
      layers: this.layerOrder.map((id) =>
        cloneJson(this.layers.get(id)?.spec ?? { id }),
      ),
    };
  }

  /* ------------------------- sources ------------------------- */

  addSource(id: string, spec: Record<string, unknown>): void {
    if (this.sources.has(id)) {
      throw new Error(`Source already exists: ${id}`);
    }
    this.sources.set(id, new ShimSource(this, id, spec));
  }

  getSource(id: string): ShimSource | undefined {
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

  async fetchGeoJson(url: string): Promise<unknown> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Could not fetch GeoJSON (${response.status}) from ${url}`,
      );
    }
    return response.json();
  }

  refreshLayersForSource(sourceId: string): void {
    for (const id of this.layerOrder) {
      const entry = this.layers.get(id);
      if (!entry || String(entry.spec.source ?? "") !== sourceId) {
        continue;
      }
      this.refreshLayer(entry);
    }
  }

  /* ------------------------- layers ------------------------- */

  addLayer(spec: Record<string, unknown>, beforeId?: string): void {
    const id = String(spec.id ?? "");
    if (!id) {
      throw new Error("addLayer requires layer.id.");
    }
    if (this.layers.has(id)) {
      throw new Error(`Layer already exists: ${id}`);
    }
    const paneName = `geoagent-pane-${(this.paneSeq += 1)}`;
    this.raw.createPane(paneName);
    const entry: ShimLayerEntry = {
      spec: cloneJson(spec),
      leaflet: null,
      paneName,
    };
    this.materializeLayer(entry);
    const insertIndex =
      beforeId && this.layerOrder.includes(beforeId)
        ? this.layerOrder.indexOf(beforeId)
        : this.layerOrder.length;
    this.layerOrder.splice(insertIndex, 0, id);
    this.layers.set(id, entry);
    this.assignZIndexes();
    this.syncVisibility(entry);
  }

  getLayer(id: string): Record<string, unknown> | undefined {
    return this.layers.get(id)?.spec;
  }

  removeLayer(id: string): void {
    const entry = this.layers.get(id);
    if (!entry) {
      throw new Error(`Layer not found: ${id}`);
    }
    if (entry.leaflet && this.raw.hasLayer(entry.leaflet)) {
      this.raw.removeLayer(entry.leaflet);
    }
    if (entry.paneName) {
      this.raw.getPane(entry.paneName)?.remove();
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
    this.assignZIndexes();
  }

  setPaintProperty(id: string, property: string, value: unknown): void {
    const entry = this.requireEntry(id);
    const paint = isRecord(entry.spec.paint) ? entry.spec.paint : {};
    paint[property] = value;
    entry.spec.paint = paint;
    if (
      entry.spec.type === "raster" &&
      property === "raster-opacity" &&
      entry.leaflet &&
      typeof (entry.leaflet as TileLayerLike).setOpacity === "function"
    ) {
      (entry.leaflet as TileLayerLike).setOpacity(Number(value));
      return;
    }
    this.refreshLayer(entry);
  }

  setLayoutProperty(id: string, property: string, value: unknown): void {
    const entry = this.requireEntry(id);
    const layout = isRecord(entry.spec.layout) ? entry.spec.layout : {};
    layout[property] = value;
    entry.spec.layout = layout;
    if (property === "visibility") {
      this.syncVisibility(entry);
      return;
    }
    this.refreshLayer(entry);
  }

  setFilter(id: string, filter: unknown): void {
    const entry = this.requireEntry(id);
    if (filter == null) {
      delete entry.spec.filter;
    } else {
      entry.spec.filter = filter;
    }
    this.refreshLayer(entry);
  }

  /* ------------------------- queries ------------------------- */

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
    const zoom = this.raw.getZoom();
    return source.data.features.filter((feature) => {
      if (!options?.filter) {
        return true;
      }
      return expressionTruthy(
        evaluateExpression(options.filter, this.featureContext(feature, zoom)),
      );
    });
  }

  queryRenderedFeatures(
    point: [number, number],
    options?: { layers?: string[] },
  ): Array<Record<string, unknown>> {
    const [x, y] = point;
    const wanted = options?.layers;
    const zoom = this.raw.getZoom();
    const results: Array<Record<string, unknown>> = [];
    for (const id of this.layerOrder) {
      if (results.length >= 50) {
        break;
      }
      if (wanted && wanted.length > 0 && !wanted.includes(id)) {
        continue;
      }
      const entry = this.layers.get(id);
      if (!entry || !this.isVisibleNow(entry)) {
        continue;
      }
      const spec = entry.spec;
      if (!GEOJSON_LAYER_TYPES.includes(String(spec.type))) {
        continue;
      }
      const source = this.sources.get(String(spec.source ?? ""));
      if (!source || source.type !== "geojson") {
        continue;
      }
      for (const feature of source.resolvedFeatures()) {
        if (!this.featurePassesFilter(spec, feature, zoom)) {
          continue;
        }
        if (!this.featureHitsPixel(spec, feature, x, y, zoom)) {
          continue;
        }
        results.push({
          type: "Feature",
          geometry: feature.geometry ?? null,
          properties: feature.properties ?? {},
          id: feature.id ?? null,
          layer: {
            id,
            type: String(spec.type),
            source: String(spec.source ?? ""),
          },
        });
        if (results.length >= 50) {
          break;
        }
      }
    }
    return results;
  }

  /**
   * Leaflet composites DOM tiles and vector overlays — there is no single
   * WebGL canvas to read back. Size queries still work (query_rendered_features
   * uses them for the default point); toDataURL fails loudly.
   */
  getCanvas(): {
    width: number;
    height: number;
    clientWidth: number;
    clientHeight: number;
    toDataURL(): string;
  } {
    const size = this.raw.getSize();
    return {
      width: size.x,
      height: size.y,
      clientWidth: size.x,
      clientHeight: size.y,
      toDataURL: (): string => {
        throw new Error(
          "screenshot_map is not supported by the Leaflet engine: Leaflet composites DOM tiles and vector overlays instead of a single canvas.",
        );
      },
    };
  }

  setTerrain(_terrain: unknown): never {
    throw new Error(
      "Terrain (raster-dem) is not supported by the Leaflet engine.",
    );
  }

  /* Deliberately no setSky: the tools detect its absence and report
   * "Sky is not supported by this map engine." — same as mapbox-gl. */

  /* ------------------------- markers & popups ------------------------- */

  /**
   * GeoAgentMarker-compatible wrapper around L.marker with a teardrop pin
   * divIcon, so addMarkerOverlay behaves like the maplibre/mapbox engines.
   */
  createMarker(color?: string): {
    setLngLat(lngLat: [number, number]): unknown;
    addTo(map: unknown): unknown;
    setPopup(popup: unknown): unknown;
    getElement(): HTMLElement;
    remove(): unknown;
  } {
    const safeColor = sanitizeCssColor(color || "#3388ff");
    const icon = this.factory.divIcon({
      html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 36" width="26" height="36"><path d="M13 0C5.8 0 0 5.8 0 13c0 9.8 11.6 22.2 12.1 22.7.5.5 1.3.5 1.8 0C14.4 35.2 26 22.8 26 13 26 5.8 20.2 0 13 0z" fill="${safeColor}"/><circle cx="13" cy="13" r="5.5" fill="#ffffff"/></svg>`,
      className: "geoagent-leaflet-marker-icon",
      iconSize: [26, 36],
      iconAnchor: [13, 36],
      popupAnchor: [0, -34],
    });
    const marker = this.factory.marker([0, 0], { icon });
    const raw = this.raw;
    let placeholder: HTMLElement | null = null;
    const self = {
      setLngLat(lngLat: [number, number]): unknown {
        marker.setLatLng([lngLat[1], lngLat[0]]);
        return self;
      },
      addTo(_map: unknown): unknown {
        marker.addTo(raw);
        return self;
      },
      setPopup(popup: unknown): unknown {
        const leafletPopup = extractLeafletPopup(popup);
        if (leafletPopup) {
          marker.bindPopup(leafletPopup);
        }
        return self;
      },
      getElement(): HTMLElement {
        const element = marker.getElement();
        if (element) {
          return element;
        }
        if (!placeholder) {
          placeholder = document.createElement("div");
        }
        return placeholder;
      },
      remove(): unknown {
        marker.remove();
        return undefined;
      },
    };
    return self;
  }

  /** GeoAgentPopup-compatible wrapper around L.popup. */
  createPopup(): {
    setText(text: string): unknown;
    readonly leafletPopup: PopupLike;
  } {
    const popup = this.factory.popup({ closeButton: true, autoPan: true });
    return {
      leafletPopup: popup,
      setText(text: string): unknown {
        popup.setContent(text);
        return this;
      },
    };
  }

  /* ------------------------- internals ------------------------- */

  private requireEntry(id: string): ShimLayerEntry {
    const entry = this.layers.get(id);
    if (!entry) {
      throw new Error(`Layer not found: ${id}`);
    }
    return entry;
  }

  private ensureBasePane(): string {
    if (!this.basePaneName) {
      this.basePaneName = "geoagent-base";
      const pane = this.raw.createPane(this.basePaneName);
      pane.style.zIndex = "150";
    }
    return this.basePaneName;
  }

  private assignZIndexes(): void {
    this.layerOrder.forEach((id, index) => {
      const entry = this.layers.get(id);
      if (!entry?.paneName) {
        return;
      }
      const pane = this.raw.getPane(entry.paneName);
      if (pane) {
        pane.style.zIndex = String(250 + index * 2);
      }
    });
  }

  private handleZoomChange(): void {
    for (const source of this.sources.values()) {
      source.invalidateClusterCache();
    }
    for (const source of this.sources.values()) {
      if (source.cluster) {
        this.refreshLayersForSource(source.id);
      }
    }
    for (const id of this.layerOrder) {
      const entry = this.layers.get(id);
      if (entry) {
        this.syncVisibility(entry);
      }
    }
  }

  private materializeLayer(entry: ShimLayerEntry): void {
    const spec = entry.spec;
    const type = String(spec.type ?? "");
    if (type === "background") {
      entry.leaflet = null;
      return;
    }
    const sourceId = typeof spec.source === "string" ? spec.source : "";
    const source = this.sources.get(sourceId);
    if (type === "raster") {
      if (!source) {
        throw new Error(
          `Cannot add layer ${String(spec.id)}; source not found: ${sourceId}`,
        );
      }
      if (source.type === "image") {
        const url = String(source.spec.url ?? "");
        const coordinates = source.spec.coordinates as
          | Array<[number, number]>
          | undefined;
        if (!url || !Array.isArray(coordinates) || coordinates.length !== 4) {
          throw new Error(
            `Image source ${sourceId} needs a url and four [lon, lat] corner coordinates.`,
          );
        }
        entry.leaflet = this.factory.imageOverlay(
          url,
          this.coordinatesToBounds(coordinates),
          {
            pane: entry.paneName ?? undefined,
            opacity: this.staticNumber(spec.paint, "raster-opacity", 1),
            attribution: String(source.spec.attribution ?? ""),
          },
        );
        return;
      }
      if (source.type === "raster") {
        const tiles = source.spec.tiles;
        if (!Array.isArray(tiles) || typeof tiles[0] !== "string") {
          throw new Error(
            `Raster source ${sourceId} has no tiles URL the Leaflet engine can render.`,
          );
        }
        entry.leaflet = this.factory.tileLayer(tiles[0], {
          pane: entry.paneName ?? undefined,
          opacity: this.staticNumber(spec.paint, "raster-opacity", 1),
          attribution: String(source.spec.attribution ?? ""),
          tileSize: Number(source.spec.tileSize ?? 256),
          maxZoom: 24,
        });
        return;
      }
      throw new Error(
        `Raster layers on the Leaflet engine require a raster or image source (got "${source.type}" for ${sourceId}).`,
      );
    }
    if (GEOJSON_LAYER_TYPES.includes(type)) {
      if (!source || source.type !== "geojson") {
        throw new Error(
          `${type} layers on the Leaflet engine require a geojson source${sourceId ? ` (source "${sourceId}" is ${source?.type ?? "missing"})` : ""}.`,
        );
      }
      const paneName = entry.paneName ?? undefined;
      const geoLayer = this.factory.geoJSON(undefined, {
        pane: paneName,
        style: (feature?: GeoJSON.Feature): Record<string, unknown> =>
          this.pathStyleFor(spec, feature),
        filter: (feature?: GeoJSON.Feature): boolean =>
          this.featurePassesFilter(spec, feature, this.raw.getZoom()),
        pointToLayer: (
          feature: GeoJSON.Feature | undefined,
          latlng: LeafletLatLngLike,
        ): LeafletLayerLike =>
          this.pointLayerFor(spec, feature, latlng, paneName),
      } as unknown as Record<string, unknown>);
      geoLayer.addData(source.resolvedFeatures());
      entry.leaflet = geoLayer;
      return;
    }
    if (type === "fill-extrusion") {
      throw new Error(
        "3D fill-extrusion layers (add_3d_buildings) are not supported by the Leaflet engine.",
      );
    }
    throw new Error(
      `Layer type "${type}" is not supported by the Leaflet engine.`,
    );
  }

  private refreshLayer(entry: ShimLayerEntry): void {
    const type = String(entry.spec.type ?? "");
    const source = this.sources.get(String(entry.spec.source ?? ""));
    if (
      GEOJSON_LAYER_TYPES.includes(type) &&
      source?.type === "geojson" &&
      entry.leaflet &&
      typeof (entry.leaflet as GeoJSONLayerLike).clearLayers === "function"
    ) {
      const geoLayer = entry.leaflet as GeoJSONLayerLike;
      geoLayer.clearLayers();
      geoLayer.addData(source.resolvedFeatures());
      this.syncVisibility(entry);
      return;
    }
    if (!entry.leaflet) {
      return;
    }
    if (this.raw.hasLayer(entry.leaflet)) {
      this.raw.removeLayer(entry.leaflet);
    }
    entry.leaflet = null;
    this.materializeLayer(entry);
    this.syncVisibility(entry);
  }

  private syncVisibility(entry: ShimLayerEntry): void {
    if (!entry.leaflet) {
      return;
    }
    if (this.isVisibleNow(entry)) {
      if (!this.raw.hasLayer(entry.leaflet)) {
        this.raw.addLayer(entry.leaflet);
      }
    } else if (this.raw.hasLayer(entry.leaflet)) {
      this.raw.removeLayer(entry.leaflet);
    }
  }

  private isVisibleNow(entry: ShimLayerEntry): boolean {
    const layout = isRecord(entry.spec.layout) ? entry.spec.layout : {};
    if (layout.visibility === "none") {
      return false;
    }
    const zoom = this.raw.getZoom();
    const minZoom =
      entry.spec.minzoom == null ? -Infinity : Number(entry.spec.minzoom);
    const maxZoom =
      entry.spec.maxzoom == null ? Infinity : Number(entry.spec.maxzoom);
    return zoom >= minZoom && zoom <= maxZoom;
  }

  private coordinatesToBounds(
    coordinates: Array<[number, number]>,
  ): [[number, number], [number, number]] {
    const lats = coordinates.map((coordinate) => coordinate[1]);
    const lngs = coordinates.map((coordinate) => coordinate[0]);
    return [
      [Math.min(...lats), Math.min(...lngs)],
      [Math.max(...lats), Math.max(...lngs)],
    ];
  }

  private featureContext(
    feature: GeoJSON.Feature | undefined,
    zoom?: number,
  ): ExpressionContext {
    return featureContextFor(feature, zoom ?? this.raw.getZoom());
  }

  private featurePassesFilter(
    spec: Record<string, unknown>,
    feature: GeoJSON.Feature | undefined,
    zoom?: number,
  ): boolean {
    if (!feature) {
      return false;
    }
    if (!spec.filter) {
      return true;
    }
    return expressionTruthy(
      evaluateExpression(spec.filter, this.featureContext(feature, zoom)),
    );
  }

  private staticNumber(
    paint: unknown,
    property: string,
    fallback: number,
  ): number {
    if (!isRecord(paint)) {
      return fallback;
    }
    const value = Number(paint[property]);
    return Number.isFinite(value) ? value : fallback;
  }

  private numberValue(
    value: unknown,
    context: ExpressionContext,
    fallback: number,
  ): number {
    return numberValueFrom(value, context, fallback);
  }

  private colorValue(
    value: unknown,
    context: ExpressionContext,
    fallback: string,
  ): string {
    return colorValueFrom(value, context, fallback);
  }

  private textFieldText(field: unknown, context: ExpressionContext): string {
    return textFieldTextFrom(field, context);
  }

  private pathStyleFor(
    spec: Record<string, unknown>,
    feature?: GeoJSON.Feature,
  ): Record<string, unknown> {
    const paint = isRecord(spec.paint) ? spec.paint : {};
    const context = this.featureContext(feature);
    const type = String(spec.type);
    if (type === "fill") {
      const style: Record<string, unknown> = {
        fill: true,
        fillColor: this.colorValue(paint["fill-color"], context, "#1c7ed6"),
        fillOpacity: this.numberValue(paint["fill-opacity"], context, 1),
      };
      if (paint["fill-outline-color"] != null) {
        style.stroke = true;
        style.color = this.colorValue(
          paint["fill-outline-color"],
          context,
          "#1c7ed6",
        );
        style.weight = 1;
      } else {
        style.stroke = false;
      }
      return style;
    }
    if (type === "line") {
      return {
        stroke: true,
        fill: false,
        color: this.colorValue(paint["line-color"], context, "#1c7ed6"),
        weight: this.numberValue(paint["line-width"], context, 1),
        opacity: this.numberValue(paint["line-opacity"], context, 1),
      };
    }
    if (type === "circle") {
      const strokeWidth = this.numberValue(
        paint["circle-stroke-width"],
        context,
        0,
      );
      return {
        fill: true,
        fillColor: this.colorValue(paint["circle-color"], context, "#1c7ed6"),
        fillOpacity: this.numberValue(paint["circle-opacity"], context, 1),
        stroke: strokeWidth > 0,
        color: this.colorValue(paint["circle-stroke-color"], context, "#ffffff"),
        weight: strokeWidth,
        opacity: this.numberValue(paint["circle-stroke-opacity"], context, 1),
      };
    }
    return {};
  }

  private pointLayerFor(
    spec: Record<string, unknown>,
    feature: GeoJSON.Feature | undefined,
    latlng: LeafletLatLngLike,
    paneName?: string,
  ): LeafletLayerLike {
    const paint = isRecord(spec.paint) ? spec.paint : {};
    const layout = isRecord(spec.layout) ? spec.layout : {};
    const context = this.featureContext(feature);
    const position: [number, number] = [latlng.lat, latlng.lng];
    const type = String(spec.type);
    if (type === "circle") {
      return this.factory.circleMarker(position, {
        pane: paneName,
        radius: this.numberValue(paint["circle-radius"], context, 5),
        ...this.pathStyleFor(spec, feature),
      });
    }
    if (type === "symbol") {
      const text = this.textFieldText(layout["text-field"], context);
      const color = this.colorValue(paint["text-color"], context, "#ffffff");
      const size = this.numberValue(layout["text-size"], context, 12);
      const icon = this.factory.divIcon({
        html: `<span style="color:${sanitizeCssColor(color)};font-size:${Math.max(1, size)}px;font-weight:600;font-family:sans-serif;text-shadow:0 0 3px rgba(0,0,0,0.6);white-space:nowrap;">${escapeHtml(text)}</span>`,
        className: "geoagent-leaflet-label-icon",
        iconSize: null,
      });
      return this.factory.marker(position, {
        icon,
        pane: paneName,
        interactive: false,
        keyboard: false,
      });
    }
    // fill/line layers normally filter Point features out; if a custom filter
    // lets one through, render an invisible placeholder to stay consistent.
    return this.factory.circleMarker(position, {
      pane: paneName,
      radius: 0,
      stroke: false,
      fill: false,
      interactive: false,
    });
  }

  /* ------------------------- hit testing ------------------------- */

  private featureHitsPixel(
    spec: Record<string, unknown>,
    feature: GeoJSON.Feature,
    x: number,
    y: number,
    zoom: number,
  ): boolean {
    return hitTestFeature(
      spec,
      feature,
      x,
      y,
      (coordinate) => this.toPixel(coordinate),
      this.featureContext(feature, zoom),
    );
  }

  private toPixel(coordinate: [number, number]): LeafletPointLike {
    return this.raw.latLngToContainerPoint([coordinate[1], coordinate[0]]);
  }






}

function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const closestX = ax + t * dx;
  const closestY = ay + t * dy;
  return Math.hypot(px - closestX, py - closestY);
}

function pointInRing(
  x: number,
  y: number,
  ring: LeafletPointLike[],
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Builds the expression-evaluation context for one feature. Shared by the
 * Leaflet and OpenLayers engines.
 */
export function featureContextFor(
  feature: GeoJSON.Feature | undefined,
  zoom: number,
): ExpressionContext {
  return {
    properties: (isRecord(feature?.properties)
      ? feature?.properties
      : {}) as Record<string, unknown>,
    geometryType: normalizeGeometryType(String(feature?.geometry?.type ?? "")),
    zoom,
    id: feature?.id,
  };
}

export function numberValueFrom(
  value: unknown,
  context: ExpressionContext,
  fallback: number,
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    const evaluated = Number(evaluateExpression(value, context));
    if (Number.isFinite(evaluated)) {
      return evaluated;
    }
  }
  return fallback;
}

export function colorValueFrom(
  value: unknown,
  context: ExpressionContext,
  fallback: string,
): string {
  if (typeof value === "string" && value) {
    return value;
  }
  if (Array.isArray(value)) {
    const evaluated = evaluateExpression(value, context);
    if (typeof evaluated === "string" && evaluated) {
      return evaluated;
    }
  }
  return fallback;
}

export function textFieldTextFrom(
  field: unknown,
  context: ExpressionContext,
): string {
  if (typeof field === "string") {
    return field.replace(/\{([^}]+)\}/g, (_match, key: string) => {
      const value = context.properties?.[key.trim()];
      return value == null ? "" : String(value);
    });
  }
  if (Array.isArray(field)) {
    const evaluated = evaluateExpression(field, context);
    return evaluated == null ? "" : String(evaluated);
  }
  return "";
}

export type PixelProjector = (coordinate: [number, number]) => {
  x: number;
  y: number;
};

/**
 * Pixel-accurate hit test of one GeoJSON feature against a container point,
 * honoring the layer type's tolerances (circle radius, line width). Shared by
 * both engines' query_rendered_features.
 */
export function hitTestFeature(
  spec: Record<string, unknown>,
  feature: GeoJSON.Feature,
  x: number,
  y: number,
  toPixel: PixelProjector,
  context: ExpressionContext,
): boolean {
  const geometry = feature.geometry;
  if (!geometry || geometry.type === "GeometryCollection") {
    return false;
  }
  const paint = isRecord(spec.paint) ? spec.paint : {};
  const type = normalizeGeometryType(geometry.type);
  const pointTolerance =
    String(spec.type) === "circle"
      ? numberValueFrom(paint["circle-radius"], context, 5) + 4
      : String(spec.type) === "symbol"
        ? 14
        : 10;
  const lineTolerance =
    numberValueFrom(paint["line-width"], context, 1) / 2 + 4;

  const pointHits = (coordinate: [number, number]): boolean => {
    const pixel = toPixel(coordinate);
    const dx = pixel.x - x;
    const dy = pixel.y - y;
    return dx * dx + dy * dy <= pointTolerance * pointTolerance;
  };
  const lineHits = (coordinates: Array<[number, number]>): boolean => {
    if (coordinates.length < 2) {
      return false;
    }
    for (let index = 0; index + 1 < coordinates.length; index += 1) {
      const a = toPixel(coordinates[index]);
      const b = toPixel(coordinates[index + 1]);
      if (segmentDistance(x, y, a.x, a.y, b.x, b.y) <= lineTolerance) {
        return true;
      }
    }
    return false;
  };
  const polygonHits = (rings: Array<Array<[number, number]>>): boolean => {
    if (rings.length === 0) {
      return false;
    }
    if (String(spec.type) === "line") {
      return rings.some((ring) => lineHits([...ring, ring[0]]));
    }
    const outer = rings[0].map((coordinate) => toPixel(coordinate));
    if (!pointInRing(x, y, outer)) {
      return false;
    }
    return !rings.slice(1).some((hole) =>
      pointInRing(
        x,
        y,
        hole.map((coordinate) => toPixel(coordinate)),
      ),
    );
  };

  switch (type) {
    case "Point":
      return pointHits(geometry.coordinates as [number, number]);
    case "MultiPoint":
      return (geometry.coordinates as Array<[number, number]>).some(pointHits);
    case "LineString":
      return lineHits(geometry.coordinates as Array<[number, number]>);
    case "MultiLineString":
      return (geometry.coordinates as Array<Array<[number, number]>>).some(
        lineHits,
      );
    case "Polygon":
      return polygonHits(
        geometry.coordinates as Array<Array<[number, number]>>,
      );
    case "MultiPolygon":
      return (
        geometry.coordinates as Array<Array<Array<[number, number]>>>
      ).some(polygonHits);
    default:
      return false;
  }
}

function extractLeafletPopup(popup: unknown): PopupLike | null {
  if (isRecord(popup)) {
    const wrapped = (popup as { leafletPopup?: unknown }).leafletPopup;
    if (isRecord(wrapped) && typeof wrapped.setContent === "function") {
      return wrapped as unknown as PopupLike;
    }
    if (typeof popup.setContent === "function") {
      return popup as unknown as PopupLike;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Public helpers                                                             */
/* -------------------------------------------------------------------------- */

export function createLeafletMapShim(
  map: LeafletMapLike,
  namespace: Record<string, unknown>,
): LeafletMapShim {
  return new LeafletMapShim(map, namespace);
}

export function isLeafletMapShim(value: unknown): value is LeafletMapShim {
  return value instanceof LeafletMapShim;
}

export interface LeafletControlAttachment {
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
 * Attach a GeoAgentControl to a Leaflet map.
 *
 * Leaflet has no map.addControl slot for foreign controls, so this mounts the
 * control element into the matching .leaflet-control-container corner (or
 * absolutely positions it inside the map container as a fallback). The control
 * must have been created with mapEngine { kind: "leaflet", namespace: L }.
 *
 *   const control = new GeoAgentControl({ mapEngine: { kind: "leaflet", namespace: L } });
 *   const attachment = addGeoAgentToLeafletMap(control, map, { position: "top-left" });
 *   // later: attachment.remove();
 */
export function addGeoAgentToLeafletMap(
  control: GeoAgentControl,
  map: LeafletMapLike,
  options?: { position?: string },
): LeafletControlAttachment {
  if (!isLeafletMap(map)) {
    throw new Error(
      "addGeoAgentToLeafletMap expects a Leaflet map instance created with L.map(...).",
    );
  }
  const internal = control as unknown as {
    options?: { position?: string; mapEngine?: { kind?: string } };
    onRemove(): void;
  };
  const engineKind = internal.options?.mapEngine?.kind;
  if (engineKind && engineKind !== "leaflet") {
    throw new Error(
      `GeoAgentControl was created with mapEngine.kind "${engineKind}"; Leaflet hosts need { kind: "leaflet", namespace: L }.`,
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
  const element = control.onAdd(map as unknown as MapLibreMap);
  element.classList.add("leaflet-control");
  const [vertical, horizontal] = position.split("-") as [string, string];
  const container = map.getContainer();
  const corner = container.querySelector<HTMLElement>(
    `.leaflet-control-container .leaflet-${vertical}.leaflet-${horizontal}`,
  );
  if (corner) {
    corner.appendChild(element);
  } else {
    element.style.position = "absolute";
    element.style.zIndex = "800";
    if (vertical === "top") {
      element.style.top = "10px";
    } else {
      element.style.bottom = "10px";
    }
    if (horizontal === "left") {
      element.style.left = "10px";
    } else {
      element.style.right = "10px";
    }
    if (window.getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    container.appendChild(element);
  }
  return {
    remove(): void {
      internal.onRemove.call(control);
      element.remove();
    },
  };
}
