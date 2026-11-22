import type { RequestLimits } from './request';

export interface GeoJsonLimits extends RequestLimits {
  /** Default 100,000 features. */
  maxFeatures?: number;
  /** Default 1,000,000 positions. */
  maxCoordinates?: number;
}

/** Validate untrusted GeoJSON before touching map resources. */
export function validateGeoJson(value: unknown, limits: GeoJsonLimits = {}): asserts value is GeoJSON.GeoJSON {
  const maxFeatures = limits.maxFeatures ?? 100_000;
  const maxCoordinates = limits.maxCoordinates ?? 1_000_000;
  if (![maxFeatures, maxCoordinates].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('GeoJSON limits must be positive integers.');
  }
  let features = 0;
  let coordinates = 0;
  const fail = (message: string): never => { throw new Error(`Invalid GeoJSON: ${message}`); };
  const record = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('expected an object');
    return input as Record<string, unknown>;
  };
  const position = (input: unknown) => {
    if (++coordinates > maxCoordinates) fail(`coordinate limit ${maxCoordinates} exceeded`);
    if (!Array.isArray(input) || input.length < 2 || !input.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      fail('positions must contain at least two finite numbers');
    }
  };
  const line = (input: unknown, ring = false) => {
    if (!Array.isArray(input)) return fail('expected coordinates array');
    if (input.length && input.length < (ring ? 4 : 2)) fail('too few positions');
    input.forEach(position);
    if (ring && input.length && JSON.stringify(input[0]) !== JSON.stringify(input[input.length - 1])) fail('polygon rings must be closed');
  };
  const array = (input: unknown, visit: (child: unknown) => void) => {
    if (!Array.isArray(input)) return fail('expected coordinates array');
    input.forEach(visit);
  };
  const geometry = (input: unknown, depth = 0): void => {
    if (depth > 64) fail('geometry nesting exceeds 64');
    const item = record(input);
    switch (item.type) {
      case 'Point': position(item.coordinates); break;
      case 'MultiPoint': array(item.coordinates, position); break;
      case 'LineString': line(item.coordinates); break;
      case 'MultiLineString': array(item.coordinates, (child) => line(child)); break;
      case 'Polygon': array(item.coordinates, (child) => line(child, true)); break;
      case 'MultiPolygon': array(item.coordinates, (polygon) => array(polygon, (child) => line(child, true))); break;
      case 'GeometryCollection': array(item.geometries, (child) => geometry(child, depth + 1)); break;
      default: fail('unsupported geometry type');
    }
  };
  const feature = (input: unknown) => {
    if (++features > maxFeatures) fail(`feature limit ${maxFeatures} exceeded`);
    const item = record(input);
    if (item.type !== 'Feature') fail('expected Feature');
    if (item.properties !== null) record(item.properties);
    if (item.geometry !== null) geometry(item.geometry);
  };
  const root = record(value);
  if (root.type === 'FeatureCollection') array(root.features, feature);
  else if (root.type === 'Feature') feature(root);
  else geometry(root);
}
