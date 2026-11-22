/**
 * 供生命周期路径（GeoAgentControl.onAdd 与 GeoAgentCore.attach）共用的
 * 地图容器探测。每种受支持的引擎暴露 DOM 容器的方式不同：
 *
 * - MapLibre/Mapbox 地图：`getContainer()`
 * - OpenLayers 地图：`getTargetElement()`
 * - ArcGIS MapView：`container` 属性（一个 HTMLElement）
 * - `<arcgis-map>` / `<arcgis-scene>` 组件：元素本身就是视图容器（组件内部
 *   以 `container: this` 构造视图，且不代理 `container` 属性），因此裸的
 *   HTMLElement 地图值会解析为其自身。
 */

/**
 * 从任意引擎的地图对象中解析出 DOM 容器元素。
 *
 * @param map 任意引擎的地图实例（类型上按 unknown 处理，运行时做鸭子探测）
 * @returns 地图的容器元素；无法识别时返回 undefined
 */
export function resolveMapContainer(map: unknown): HTMLElement | undefined {
  // 按可选方法/属性的形状做鸭子类型探测，覆盖全部受支持引擎的暴露方式。
  const containerSource = map as {
    getContainer?(): HTMLElement | undefined;
    getTargetElement?(): HTMLElement | null | undefined;
    container?: unknown;
  };
  // 优先走取值器：MapLibre/Mapbox/Leaflet 是 getContainer()，OpenLayers 是
  // getTargetElement()；两个都命中时取第一个非空结果。
  const fromAccessor =
    containerSource.getContainer?.() ??
    containerSource.getTargetElement?.() ??
    undefined;
  if (fromAccessor) {
    return fromAccessor;
  }
  // ArcGIS MapView 以 `container` 属性持有容器元素。
  if (containerSource.container instanceof HTMLElement) {
    return containerSource.container;
  }
  // `<arcgis-map>`/`<arcgis-scene>` web component 自身就是容器：裸 HTMLElement
  // 直接返回；其余情况（真正无法识别的对象）返回 undefined。
  return map instanceof HTMLElement ? map : undefined;
}
