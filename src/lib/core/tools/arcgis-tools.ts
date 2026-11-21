/**
 * ArcGISTools — the GeoAgentTools subclass for ArcGIS Maps SDK hosts.
 *
 * The command surface is the ArcGISMapShim (see arcgis-engine.ts), which
 * materializes Style-Spec sources/layers as real ArcGIS layers. The MapView
 * is 2D, so this subclass exposes no WebGL-only tools — except
 * `screenshot_map`, which the ArcGIS view genuinely supports via
 * takeScreenshot (the other 2D shims cannot composite a screenshot).
 * Terrain/sky/globe/3D commands answer with the same explicit capability
 * errors the shim throws, so hosts calling `runCommand` directly still get an
 * actionable message.
 *
 * Nothing here imports "@arcgis/*"; the host passes its own namespace bundle
 * via `mapEngine: { kind: "arcgis", namespace }` (see arcgis-engine.ts).
 */
import { tool, type Tool } from "@strands-agents/sdk";
import type { Map as MapLibreMap } from "maplibre-gl";
import { z } from "zod";
import {
  GeoAgentTools,
  stringArg,
  type GeoAgentArcGISEngine,
  type GeoAgentMapEngine,
  type GeoAgentMarker,
  type GeoAgentPopup,
  type GeoAgentStyleSpecNamespace,
  type JsonObject,
} from "./geoagent-tools";
import {
  createArcGISMapShim,
  isArcGISMapShim,
  resolveArcGISView,
  type ArcGISMapShim,
} from "../engines/arcgis-engine";

export class ArcGISTools extends GeoAgentTools {
  protected resolveEngine(
    provided: GeoAgentMapEngine | undefined,
  ): GeoAgentMapEngine {
    if (!provided || provided.kind !== "arcgis") {
      throw new Error(
        'ArcGISTools requires mapEngine { kind: "arcgis", namespace }; use createGeoAgentTools to pick the tools class from the engine.',
      );
    }
    return provided;
  }

  protected createSurface(map: unknown): MapLibreMap {
    // Accept a MapView or a ready <arcgis-map> component element.
    const view = resolveArcGISView(map);
    return createArcGISMapShim(
      view,
      (this.engine as GeoAgentArcGISEngine).namespace,
    ) as unknown as MapLibreMap;
  }

  protected loadNamespace(): GeoAgentStyleSpecNamespace {
    // The host injected the esri classes; nothing is ever imported.
    return (this.engine as GeoAgentArcGISEngine)
      .namespace as unknown as GeoAgentStyleSpecNamespace;
  }

  protected engineDisplayName(): string {
    if (isArcGISMapShim(this.map)) {
      return this.map.isScene ? "ArcGIS SceneView" : "ArcGIS Maps SDK";
    }
    return "ArcGIS Maps SDK";
  }

  protected scriptNamespaceName(): string {
    return "esri";
  }

  protected scriptToolDescription(): string {
    if (isArcGISMapShim(this.map) && this.map.isScene) {
      return "Run a short JavaScript snippet against the live browser ArcGIS SceneView when no dedicated tool fits. The snippet runs in the page with these names in scope: map (the real ArcGIS SceneView), esri (the namespace classes passed via mapEngine), and helpers. Write ArcGIS Maps SDK code: this map is not MapLibre, and MapLibre calls will fail.";
    }
    return "Run a short JavaScript snippet against the live browser ArcGIS MapView when no dedicated tool fits. The snippet runs in the page with these names in scope: map (the real ArcGIS MapView), esri (the namespace classes passed via mapEngine), and helpers. Write ArcGIS Maps SDK code: this map is not MapLibre, and MapLibre calls will fail.";
  }

  /**
   * The MapView is 2D (no globe/terrain/sky/fill-extrusion), but it CAN take
   * a composited screenshot — the one 2D engine with that capability.
   */
  protected engineTools(): Tool[] {
    return [
      tool({
        name: "screenshot_map",
        description:
          "Capture the browser ArcGIS map view as a PNG data URL (basemap and layers composited).",
        inputSchema: z.object({}),
        callback: () => this.runCommand("screenshot_map"),
      }),
    ];
  }

  /**
   * Explicit capability errors, mirroring the shim messages (the shim stays
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
        if (this.shim().isScene) {
          // The tools-level contract mirrors the shim's per-kind behavior.
          if (projection === "globe") {
            return "The SceneView already renders a globe.";
          }
          throw new Error(
            `The ArcGIS SceneView renders a 3D globe; projection "${projection || "unknown"}" is not applicable. A flat map requires an ArcGIS MapView or a maplibre-gl map.`,
          );
        }
        if (projection === "mercator") {
          return "Projection changed to mercator.";
        }
        throw new Error(
          `The ArcGIS engine's MapView renders Web Mercator only; projection "${projection || "unknown"}" is not supported. Globe rendering requires maplibre-gl, mapbox-gl, or an ArcGIS SceneView.`,
        );
      }
      case "add_terrain":
      case "clear_terrain":
        throw new Error(
          this.shim().isScene
            ? "SceneView terrain comes from the scene's ground ElevationLayers; preload one in the host or add it with run_maplibre_script — this tool's raster-dem tile format is not applicable to a scene."
            : "Terrain (raster-dem) is not supported by the ArcGIS engine's 2D MapView; use a SceneView host or a maplibre-gl map.",
        );
      case "set_sky":
      case "remove_sky":
        throw new Error("Sky is not supported by this map engine.");
      case "add_3d_buildings":
        throw new Error(
          "3D fill-extrusion layers (add_3d_buildings) are not supported by the ArcGIS engine; vector-tile building layers require maplibre-gl or mapbox-gl.",
        );
      case "screenshot_map":
        return this.shim().takeScreenshot();
      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  }

  /** The shim, typed — the surface this subclass built in createSurface. */
  private shim(): ArcGISMapShim {
    if (!isArcGISMapShim(this.map)) {
      throw new Error(
        "ArcGISTools surface is not an ArcGISMapShim.",
      );
    }
    return this.map;
  }

  /** Clear overlays and unbind the shim's watch/click listeners. */
  destroy(): void {
    if (isArcGISMapShim(this.map)) {
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

  /** User scripts get the real MapView, not the shim (they are the escape hatch). */
  protected scriptMap(): MapLibreMap {
    return this.shim().getRawView() as unknown as MapLibreMap;
  }
}
