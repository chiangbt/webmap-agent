/**
 * Shared map-container detection for the lifecycle paths (GeoAgentControl.
 * onAdd and GeoAgentCore.attach). Every supported engine exposes its DOM
 * container differently:
 *
 * - MapLibre/Mapbox maps: `getContainer()`
 * - OpenLayers maps: `getTargetElement()`
 * - ArcGIS MapViews: the `container` property (an HTMLElement)
 * - `<arcgis-map>` / `<arcgis-scene>` components: the element ITSELF is the
 *   view container (the component constructs its view with `container: this`
 *   and does not proxy a `container` property), so a bare HTMLElement map
 *   value resolves to itself.
 */
export function resolveMapContainer(map: unknown): HTMLElement | undefined {
  const containerSource = map as {
    getContainer?(): HTMLElement | undefined;
    getTargetElement?(): HTMLElement | null | undefined;
    container?: unknown;
  };
  const fromAccessor =
    containerSource.getContainer?.() ??
    containerSource.getTargetElement?.() ??
    undefined;
  if (fromAccessor) {
    return fromAccessor;
  }
  if (containerSource.container instanceof HTMLElement) {
    return containerSource.container;
  }
  return map instanceof HTMLElement ? map : undefined;
}
