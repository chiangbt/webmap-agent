/**
 * OpenLayersAgentTools — the GeoAgentTools subclass for OpenLayers hosts.
 *
 * The command surface is the OpenLayersMapShim (see openlayers-engine.ts),
 * which materializes Style-Spec sources/layers as real ol layers. OpenLayers
 * is 2D in this integration, so this subclass exposes NO WebGL-only tools
 * (`engineTools()` is empty) and answers the WebGL-only commands with the
 * same explicit capability errors the shim throws — the model never sees a
 * 3D capability OpenLayers cannot have, and hosts calling `runCommand`
 * directly still get an actionable message.
 *
 * Nothing here imports "ol"; the host passes its own namespace bundle via
 * `mapEngine: { kind: "openlayers", namespace }`.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { Tool } from "@strands-agents/sdk";
import {
  GeoAgentTools,
  stringArg,
  type GeoAgentMapEngine,
  type GeoAgentMarker,
  type GeoAgentOpenLayersEngine,
  type GeoAgentPopup,
  type GeoAgentStyleSpecNamespace,
  type JsonObject,
} from "./geoagent-tools";
import {
  createOpenLayersMapShim,
  isOpenLayersMapShim,
  type OpenLayersMapLike,
  type OpenLayersMapShim,
} from "../engines/openlayers-engine";

export class OpenLayersAgentTools extends GeoAgentTools {
  protected resolveEngine(
    provided: GeoAgentMapEngine | undefined,
  ): GeoAgentMapEngine {
    if (!provided || provided.kind !== "openlayers") {
      throw new Error(
        'OpenLayersAgentTools requires mapEngine { kind: "openlayers", namespace }; use createGeoAgentTools to pick the tools class from the engine.',
      );
    }
    return provided;
  }

  protected createSurface(map: unknown): MapLibreMap {
    return createOpenLayersMapShim(
      map as OpenLayersMapLike,
      (this.engine as GeoAgentOpenLayersEngine).namespace,
    ) as unknown as MapLibreMap;
  }

  protected loadNamespace(): GeoAgentStyleSpecNamespace {
    // The host injected the real ol namespace; nothing is ever imported.
    return (this.engine as GeoAgentOpenLayersEngine)
      .namespace as unknown as GeoAgentStyleSpecNamespace;
  }

  protected engineDisplayName(): string {
    return "OpenLayers";
  }

  protected scriptNamespaceName(): string {
    return "ol";
  }

  protected scriptToolDescription(): string {
    return "Run a short JavaScript snippet against the live browser OpenLayers map when no dedicated tool fits. The snippet runs in the page with these names in scope: map (the real ol/Map), ol (the OpenLayers namespace object), and helpers. Write OpenLayers API code: this map is not MapLibre, and MapLibre calls will fail.";
  }

  /** OpenLayers is 2D here: no WebGL-only tools are exposed to the model. */
  protected engineTools(): Tool[] {
    return [];
  }

  /**
   * Explicit capability errors, mirroring the shim messages (the shims stay
   * the last line of defense for user scripts). `set_projection: "mercator"`
   * remains a no-op success, matching the shim's contract.
   */
  protected async executeEngineCommand(
    command: string,
    args: JsonObject,
  ): Promise<unknown> {
    switch (command) {
      case "set_projection": {
        const projection = stringArg(args, "projection", "mercator")
          .trim()
          .toLowerCase();
        if (projection === "mercator") {
          return "Projection changed to mercator.";
        }
        throw new Error(
          `The OpenLayers engine only supports the "mercator" projection (received "${projection || "unknown"}"). WebGL globe rendering requires maplibre-gl or mapbox-gl.`,
        );
      }
      case "add_terrain":
      case "clear_terrain":
        throw new Error(
          "Terrain (raster-dem) is not supported by the OpenLayers engine.",
        );
      case "set_sky":
      case "remove_sky":
        throw new Error("Sky is not supported by this map engine.");
      case "add_3d_buildings":
        throw new Error(
          "3D fill-extrusion layers (add_3d_buildings) are not supported by the OpenLayers engine.",
        );
      case "screenshot_map":
        throw new Error(
          "Map screenshots are not supported by the OpenLayers engine. Capture map.getViewport() with a DOM screenshot library (e.g. html2canvas) instead.",
        );
      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  }

  /** The shim, typed — the surface this subclass built in createSurface. */
  private shim(): OpenLayersMapShim {
    if (!isOpenLayersMapShim(this.map)) {
      throw new Error(
        "OpenLayersAgentTools surface is not an OpenLayersMapShim.",
      );
    }
    return this.map;
  }

  /** Clear overlays and unbind the shim's map listeners. */
  destroy(): void {
    if (isOpenLayersMapShim(this.map)) {
      this.map.destroy();
    }
    super.destroy();
  }

  protected createEngineMarker(color: string): GeoAgentMarker {
    return this.shim().createMarker(color) as unknown as GeoAgentMarker;
  }

  protected createEnginePopup(): GeoAgentPopup {
    return this.shim().createPopup() as unknown as GeoAgentPopup;
  }

  /** User scripts get the real ol/Map, not the shim (they are the escape hatch). */
  protected scriptMap(): MapLibreMap {
    return this.shim().getRawMap() as unknown as MapLibreMap;
  }
}
