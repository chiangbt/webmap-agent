/**
 * MapLibreAgentTools — the GeoAgentTools subclass for the WebGL Style-Spec
 * engines (maplibre-gl and, with a host-provided namespace, mapbox-gl).
 *
 * This is the only subclass that drives a real MapLibre API surface natively:
 * the command surface IS the map. It owns the WebGL-only tool batch (globe
 * projection, 3D terrain, sky, fill-extrusion buildings, canvas screenshots)
 * and the lazy import of this package's own maplibre-gl dependency — the one
 * and only place maplibre-gl is loaded at runtime, so Leaflet/OpenLayers
 * hosts never pay for it.
 *
 * The shared tool surface, overlay bookkeeping and command dispatch live in
 * the base class (see geoagent-tools.ts). Everything the base exports is
 * re-exported here so the historical `./maplibre-tools` import path keeps
 * working.
 */
import { tool, type Tool } from "@strands-agents/sdk";
import type {
  LayerSpecification,
  Map as MapLibreMap,
  ProjectionSpecification,
  SourceSpecification,
} from "maplibre-gl";
import { z } from "zod";
import {
  GeoAgentTools,
  objectArg,
  stringArg,
  type GeoAgentMapEngine,
  type GeoAgentStyleSpecEngine,
  type GeoAgentStyleSpecNamespace,
} from "./geoagent-tools";
import type { JsonObject } from "./geoagent-tools";

export * from "./geoagent-tools";

/** The default engine: this package's own `maplibre-gl`, imported lazily. */
const MAPLIBRE_ENGINE: GeoAgentMapEngine = { kind: "maplibre" };

export class MapLibreAgentTools extends GeoAgentTools {
  protected resolveEngine(
    provided: GeoAgentMapEngine | undefined,
  ): GeoAgentMapEngine {
    const engine = provided ?? MAPLIBRE_ENGINE;
    if (engine.kind === "leaflet" || engine.kind === "openlayers") {
      throw new Error(
        `MapLibreAgentTools drives maplibre-gl / mapbox-gl maps; a "${engine.kind}" map needs ${
          engine.kind === "leaflet"
            ? "LeafletAgentTools"
            : "OpenLayersAgentTools"
        } (or createGeoAgentTools).`,
      );
    }
    return engine;
  }

  protected createSurface(map: unknown): MapLibreMap {
    // Style-Spec engines are used as-is: the map itself is the surface.
    return map as MapLibreMap;
  }

  protected async loadNamespace(): Promise<GeoAgentStyleSpecNamespace> {
    const provided = (this.engine as GeoAgentStyleSpecEngine).namespace;
    if (provided) {
      if (typeof provided.Marker !== "function") {
        throw new Error(
          `The ${this.engine.kind} engine namespace has no Marker constructor; pass the library's real namespace object.`,
        );
      }
      return provided;
    }
    if (this.engine.kind === "mapbox") {
      throw new Error(
        'The mapbox engine requires its namespace: pass mapEngine { kind: "mapbox", namespace: mapboxgl }. This package never imports mapbox-gl itself.',
      );
    }
    // The ONE runtime load of maplibre-gl in this package. A namespace
    // import, not a default one: MapLibre v6 is ESM-only and dropped its
    // default export, and run_maplibre_script hands the whole namespace
    // object to user-authored scripts.
    const module = await import("maplibre-gl");
    return module as unknown as GeoAgentStyleSpecNamespace;
  }

  protected engineDisplayName(): string {
    return this.engine.kind === "mapbox" ? "Mapbox GL JS" : "MapLibre";
  }

  protected scriptNamespaceName(): string {
    return this.engine.kind === "mapbox" ? "mapboxgl" : "maplibregl";
  }

  protected scriptToolDescription(): string {
    if (this.engine.kind === "mapbox") {
      return "Run a short JavaScript snippet against the live browser Mapbox GL JS map when no dedicated tool fits. The snippet runs in the page with these names in scope: map, mapboxgl, and helpers.";
    }
    return "Run a short JavaScript snippet against the live browser MapLibre map when no dedicated tool fits.";
  }

  /**
   * The WebGL-only tool batch. Only this subclass exposes these to the
   * model; the 2D engines' `engineTools()` is empty, so a Leaflet or
   * OpenLayers agent never even sees a 3D capability it cannot have.
   */
  protected engineTools(): Tool[] {
    return [
      tool({
        name: "set_projection",
        description:
          "Switch the browser MapLibre map projection between globe and mercator.",
        inputSchema: z.object({
          projection: z
            .enum(["globe", "mercator"])
            .describe(
              "Projection to use. Use globe for a 3D earth view or mercator for the standard flat map.",
            ),
        }),
        callback: (input) => this.runCommand("set_projection", input),
      }),
      tool({
        name: "add_terrain",
        description: "Add a raster-dem source and enable MapLibre terrain.",
        inputSchema: z.object({
          url: z.string().describe("Raster DEM tile URL template."),
          encoding: z.enum(["terrarium", "mapbox"]).optional(),
          exaggeration: z.number().optional(),
          source_id: z.string().optional(),
        }),
        callback: (input) => this.runCommand("add_terrain", input),
      }),
      tool({
        name: "clear_terrain",
        description:
          "Disable MapLibre terrain and remove agent-added terrain source metadata.",
        inputSchema: z.object({}),
        callback: () => this.runCommand("clear_terrain"),
      }),
      tool({
        name: "set_sky",
        description:
          "Set a MapLibre sky specification when supported by the active MapLibre version.",
        inputSchema: z.object({
          sky: z
            .record(z.string(), z.any())
            .describe("MapLibre sky specification."),
        }),
        callback: (input) => this.runCommand("set_sky", input),
      }),
      tool({
        name: "remove_sky",
        description:
          "Remove the MapLibre sky specification when supported by the active MapLibre version.",
        inputSchema: z.object({}),
        callback: () => this.runCommand("remove_sky"),
      }),
      tool({
        name: "add_3d_buildings",
        description:
          "Add a native fill-extrusion layer for 3D buildings, using an existing vector source or OpenFreeMap fallback.",
        inputSchema: z.object({
          layer_id: z.string().optional(),
          source: z.string().optional(),
          source_layer: z.string().optional(),
          min_zoom: z.number().optional(),
          fill_extrusion_color: z.string().optional(),
          fill_extrusion_opacity: z.number().min(0).max(1).optional(),
          height_property: z.string().optional(),
          base_property: z.string().optional(),
        }),
        callback: (input) => this.runCommand("add_3d_buildings", input),
      }),
      tool({
        name: "screenshot_map",
        description: "Capture the browser map canvas as a PNG data URL.",
        inputSchema: z.object({}),
        callback: () => this.runCommand("screenshot_map"),
      }),
    ];
  }

  protected async executeEngineCommand(
    command: string,
    args: JsonObject,
  ): Promise<unknown> {
    if (command === "set_projection") {
      const projection = stringArg(args, "projection", "mercator")
        .trim()
        .toLowerCase();
      if (projection !== "globe" && projection !== "mercator") {
        throw new Error(
          `Unsupported projection: ${projection}. Use globe or mercator.`,
        );
      }
      // MapLibre takes `{ type }`; mapbox-gl takes a name string (or
      // `{ name }`) and throws on the MapLibre shape.
      this.map.setProjection(
        this.engine.kind === "mapbox"
          ? (projection as unknown as ProjectionSpecification)
          : ({ type: projection } as ProjectionSpecification),
      );
      return `Projection changed to ${projection}.`;
    }

    if (command === "add_terrain") {
      const sourceId = stringArg(args, "source_id", "terrain-dem");
      const exaggeration = Number(args.exaggeration ?? 1);
      await this.addNativeOverlay({
        name: "__terrain",
        sourceSpecs: {
          [sourceId]: {
            type: "raster-dem",
            tiles: [stringArg(args, "url")],
            tileSize: 256,
            encoding:
              stringArg(args, "encoding", "terrarium") === "mapbox"
                ? "mapbox"
                : "terrarium",
          } as SourceSpecification,
        },
        terrain: { source: sourceId, exaggeration },
      });
      return `Enabled terrain from ${sourceId}.`;
    }

    if (command === "clear_terrain") {
      this.clearTerrain();
      this.removeOverlay("__terrain");
      return "Cleared terrain.";
    }

    if (command === "set_sky") {
      const sky = objectArg(args, "sky");
      this.setSky(sky);
      this.overlays.set("__sky", {
        kind: "native",
        name: "__sky",
        sourceIds: [],
        layerIds: [],
        sky,
      });
      return "Updated sky.";
    }

    if (command === "remove_sky") {
      this.removeOverlay("__sky");
      this.clearSky();
      return "Removed sky.";
    }

    if (command === "add_3d_buildings") {
      const layerId = await this.add3dBuildings(args);
      return `Added 3D buildings layer ${layerId}.`;
    }

    if (command === "screenshot_map") {
      return {
        data_url: this.map.getCanvas().toDataURL("image/png"),
        width: this.map.getCanvas().width,
        height: this.map.getCanvas().height,
      };
    }

    throw new Error(`Unsupported command: ${command}`);
  }

  private async add3dBuildings(args: JsonObject): Promise<string> {
    const layerId = stringArg(args, "layer_id", "3d-buildings");
    const requestedSource = stringArg(args, "source");
    const style = this.map.getStyle();
    let sourceId =
      requestedSource && this.map.getSource(requestedSource)
        ? requestedSource
        : "";
    if (!sourceId) {
      for (const [id, source] of Object.entries(style.sources ?? {})) {
        if (
          (source as { type?: string }).type === "vector" &&
          (id.includes("openmaptiles") ||
            id.includes("maptiler") ||
            id.includes("carto") ||
            id === "composite")
        ) {
          sourceId = id;
          break;
        }
      }
    }
    const sourceSpecs: Record<string, SourceSpecification> = {};
    if (!sourceId) {
      sourceId = "buildings-source";
      sourceSpecs[sourceId] = {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
      } as SourceSpecification;
    }
    const heightProperty = stringArg(args, "height_property", "render_height");
    const baseProperty = stringArg(args, "base_property", "render_min_height");
    await this.addNativeOverlay({
      name: layerId,
      sourceSpecs: Object.keys(sourceSpecs).length ? sourceSpecs : undefined,
      layerSpecs: [
        {
          layer: {
            id: layerId,
            type: "fill-extrusion",
            source: sourceId,
            "source-layer": stringArg(args, "source_layer", "building"),
            minzoom: Number(args.min_zoom ?? 14),
            paint: {
              "fill-extrusion-color": stringArg(
                args,
                "fill_extrusion_color",
                "#aaaaaa",
              ),
              "fill-extrusion-height": [
                "coalesce",
                ["get", heightProperty],
                ["get", "height"],
                10,
              ],
              "fill-extrusion-base": ["coalesce", ["get", baseProperty], 0],
              "fill-extrusion-opacity": Math.max(
                0,
                Math.min(1, Number(args.fill_extrusion_opacity ?? 0.6)),
              ),
            },
          } as LayerSpecification,
        },
      ],
    });
    return layerId;
  }
}
