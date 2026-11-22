/** Copy plain data graphs without serializing large GeoJSON or losing cycles.
 * SDK/DOM instances and functions are opaque handles and remain references.
 */
export function cloneSnapshot<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value) as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value, result);
  for (const key of Object.keys(value)) {
    Object.defineProperty(result, key, { value: cloneSnapshot((value as Record<string, unknown>)[key], seen), enumerable: true, writable: true, configurable: true });
  }
  return result as T;
}
