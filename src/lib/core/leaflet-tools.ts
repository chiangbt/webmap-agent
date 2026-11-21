/**
 * LeafletAgentTools — the GeoAgentTools subclass for Leaflet hosts.
 *
 * The command surface is the LeafletMapShim (see leaflet-engine.ts), which
 * materializes Style-Spec sources/layers as real Leaflet layers. Leaflet is
 * 2D-only, so this subclass exposes NO WebGL-only tools (`engineTools()` is
 * empty) and answers the WebGL-only commands with the same explicit
 * capability errors the shim throws — the model never sees a 3D capability
 * Leaflet cannot have, and hosts calling `runCommand` directly still get an
 * actionable message.
 *
 * Nothing here imports Leaflet; the host passes its own `L` namespace via
 * `mapEngine: { kind: "leaflet", namespace: L }`.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { Tool } from "@strands-agents/sdk";
import {
  GeoAgentTools,
  stringArg,
  type GeoAgentLeafletEngine,
  type GeoAgentMapEngine,
  type GeoAgentMarker,
  type GeoAgentPopup,
  type GeoAgentStyleSpecNamespace,
  type JsonObject,
} from "./geoagent-tools";
import {
  createLeafletMapShim,
  isLeafletMapShim,
  type LeafletMapLike,
  type LeafletMapShim,
} from "./leaflet-engine";

export class LeafletAgentTools extends GeoAgentTools {
  protected resolveEngine(
    provided: GeoAgentMapEngine | undefined,
  ): GeoAgentMapEngine {
    if (!provided || provided.kind !== "leaflet") {
      throw new Error(
        'LeafletAgentTools requires mapEngine { kind: "leaflet", namespace: L }; use createGeoAgentTools to pick the tools class from the engine.',
      );
    }
    return provided;
  }

  protected createSurface(map: unknown): MapLibreMap {
    return createLeafletMapShim(
      map as LeafletMapLike,
      (this.engine as GeoAgentLeafletEngine).namespace,
    ) as unknown as MapLibreMap;
  }

  protected loadNamespace(): GeoAgentStyleSpecNamespace {
    // The host injected the real L namespace; nothing is ever imported.
    return (this.engine as GeoAgentLeafletEngine)
      .namespace as unknown as GeoAgentStyleSpecNamespace;
  }

  protected engineDisplayName(): string {
    return "Leaflet";
  }

  protected scriptNamespaceName(): string {
    return "L";
  }

  protected scriptToolDescription(): string {
    return "Run a short JavaScript snippet against the live browser Leaflet map when no dedicated tool fits. The snippet runs in the page with these names in scope: map (the real L.Map), L (the Leaflet namespace), and helpers. Write Leaflet API code: this map is not MapLibre, and MapLibre calls will fail.";
  }

  /** Leaflet is 2D-only: no WebGL-only tools are exposed to the model. */
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
          `The Leaflet engine renders Web Mercator only; projection "${projection}" is not supported.`,
        );
      }
      case "add_terrain":
      case "clear_terrain":
        throw new Error(
          "Terrain (raster-dem) is not supported by the Leaflet engine.",
        );
      case "set_sky":
      case "remove_sky":
        throw new Error("Sky is not supported by this map engine.");
      case "add_3d_buildings":
        throw new Error(
          "3D fill-extrusion layers (add_3d_buildings) are not supported by the Leaflet engine.",
        );
      case "screenshot_map":
        throw new Error(
          "screenshot_map is not supported by the Leaflet engine: Leaflet composites DOM tiles and vector overlays instead of a single canvas.",
        );
      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  }

  /** The shim, typed — the surface this subclass built in createSurface. */
  private shim(): LeafletMapShim {
    if (!isLeafletMapShim(this.map)) {
      throw new Error("LeafletAgentTools surface is not a LeafletMapShim.");
    }
    return this.map;
  }

  protected createEngineMarker(color: string): GeoAgentMarker {
    return this.shim().createMarker(color) as unknown as GeoAgentMarker;
  }

  protected createEnginePopup(): GeoAgentPopup {
    return this.shim().createPopup() as unknown as GeoAgentPopup;
  }

  /** User scripts get the real L.Map, not the shim (they are the escape hatch). */
  protected scriptMap(): MapLibreMap {
    return this.shim().getRawMap() as unknown as MapLibreMap;
  }
}
