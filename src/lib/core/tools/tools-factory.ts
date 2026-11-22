/**
 * createGeoAgentTools — 依据 `mapEngine` 声明挑选正确的 GeoAgentTools 子类。
 * 这是 GeoAgentCore（以及任何直接驱动工具的宿主）应使用的入口；在引擎
 * 静态已知时直接构造子类也可以。
 */
import {
  type GeoAgentTools,
  type GeoAgentToolsOptions,
} from "./geoagent-tools";
import { MapLibreAgentTools } from "./maplibre-tools";
import { LeafletAgentTools } from "./leaflet-tools";
import { OpenLayersAgentTools } from "./openlayers-tools";
import { ArcGISTools } from "./arcgis-tools";

/**
 * 工具实现类工厂：按引擎声明实例化对应子类，未知/缺省引擎落到
 * MapLibre 系（maplibre-gl 与 mapbox-gl 都原生驱动 Style-Spec 表面）。
 *
 * @param map - 宿主的原始地图对象（各子类自行包装为命令 surface）
 * @param options - 工具构造选项（含 mapEngine 引擎声明）
 * @returns 引擎对应的 GeoAgentTools 实例
 */
export function createGeoAgentTools(
  map: unknown,
  options: GeoAgentToolsOptions,
): GeoAgentTools {
  switch (options.mapEngine?.kind) {
    case "leaflet":
      return new LeafletAgentTools(map, options);
    case "openlayers":
      return new OpenLayersAgentTools(map, options);
    case "arcgis":
      return new ArcGISTools(map, options);
    default:
      // maplibre-gl（默认）与 mapbox-gl 都原生驱动 Style-Spec 表面。
      return new MapLibreAgentTools(map, options);
  }
}
