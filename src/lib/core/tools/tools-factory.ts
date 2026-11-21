/**
 * createGeoAgentTools — pick the right GeoAgentTools subclass from the
 * `mapEngine` declaration. This is the entry point GeoAgentCore (and any
 * host driving the tools directly) should use; constructing a subclass
 * directly is fine when the engine is known statically.
 */
import {
  type GeoAgentTools,
  type GeoAgentToolsOptions,
} from "./geoagent-tools";
import { MapLibreAgentTools } from "./maplibre-tools";
import { LeafletAgentTools } from "./leaflet-tools";
import { OpenLayersAgentTools } from "./openlayers-tools";

export function createGeoAgentTools(
  map: unknown,
  options: GeoAgentToolsOptions,
): GeoAgentTools {
  switch (options.mapEngine?.kind) {
    case "leaflet":
      return new LeafletAgentTools(map, options);
    case "openlayers":
      return new OpenLayersAgentTools(map, options);
    default:
      // maplibre-gl (default) and mapbox-gl both drive the Style-Spec
      // surface natively.
      return new MapLibreAgentTools(map, options);
  }
}
