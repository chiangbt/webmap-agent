/**
 * OpenLayersAgentTools — OpenLayers 宿主对应的 GeoAgentTools 子类。
 *
 * 命令 surface 是 OpenLayersMapShim（见 openlayers-engine.ts），它把
 * Style-Spec sources/layers 物化为真实 ol 图层。在本集成中 OpenLayers 只有
 * 2D 能力，因此本子类不暴露任何 WebGL 专属工具（`engineTools()` 为空），
 * 并以与 shim 相同的明确能力错误回答 WebGL 命令 —— 模型永远看不到
 * OpenLayers 不具备的 3D 能力，直接调用 `runCommand` 的宿主也能拿到
 * 可操作的错误信息。
 *
 * 本文件从不导入 "ol"；宿主经 `mapEngine: { kind: "openlayers", namespace }`
 * 传入自己的 namespace 集合。
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

/**
 * OpenLayers 引擎的 agent 工具实现类：命令 surface 为 OpenLayersMapShim，
 * 无 WebGL 专属工具，能力错误与 shim 保持一致。
 */
export class OpenLayersAgentTools extends GeoAgentTools {
  /** 校验引擎声明：必须是 openlayers 且由宿主注入 namespace。 */
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

  /** 把真实 ol Map 包装成 OpenLayersMapShim 作为命令 surface。 */
  protected createSurface(map: unknown): MapLibreMap {
    return createOpenLayersMapShim(
      map as OpenLayersMapLike,
      (this.engine as GeoAgentOpenLayersEngine).namespace,
    ) as unknown as MapLibreMap;
  }

  protected loadNamespace(): GeoAgentStyleSpecNamespace {
    // 宿主已注入真实 ol namespace；本包从不导入 ol。
    return (this.engine as GeoAgentOpenLayersEngine)
      .namespace as unknown as GeoAgentStyleSpecNamespace;
  }

  /** schema 与结果消息中显示的引擎名。 */
  protected engineDisplayName(): string {
    return "OpenLayers";
  }

  /** 用户脚本可见的 namespace 绑定名：`ol`。 */
  protected scriptNamespaceName(): string {
    return "ol";
  }

  /** run_maplibre_script 的 description：明确要求写 OpenLayers API 代码。 */
  protected scriptToolDescription(): string {
    return "Run a short JavaScript snippet against the live browser OpenLayers map when no dedicated tool fits. The snippet runs in the page with these names in scope: map (the real ol/Map), ol (the OpenLayers namespace object), and helpers. Write OpenLayers API code: this map is not MapLibre, and MapLibre calls will fail.";
  }

  /** 本集成中 OpenLayers 仅 2D：不向模型暴露任何 WebGL 专属工具。 */
  protected engineTools(): Tool[] {
    return [];
  }

  /**
   * 明确的能力错误，与 shim 的消息一致（对用户脚本而言 shim 仍是最后一道
   * 防线）。`set_projection: "mercator"` 保留为无操作成功，与 shim 契约一致。
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
        // OpenLayers 只有 mercator：请求 mercator 视为成功空操作，其余拒绝。
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

  /** 取本子类在 createSurface 中构建的 shim（类型化访问）。 */
  private shim(): OpenLayersMapShim {
    if (!isOpenLayersMapShim(this.map)) {
      throw new Error(
        "OpenLayersAgentTools surface is not an OpenLayersMapShim.",
      );
    }
    return this.map;
  }

  /** 清空 overlay 并解绑 shim 的地图监听器。 */
  destroy(): void {
    if (isOpenLayersMapShim(this.map)) {
      this.map.destroy();
    }
    super.destroy();
  }

  /** add_marker 用 shim 的 marker 适配器构造 OpenLayers marker。 */
  protected createEngineMarker(color: string): GeoAgentMarker {
    return this.shim().createMarker(color) as unknown as GeoAgentMarker;
  }

  /** add_marker 用 shim 的 popup 适配器构造 OpenLayers popup。 */
  protected createEnginePopup(): GeoAgentPopup {
    return this.shim().createPopup() as unknown as GeoAgentPopup;
  }

  /** 用户脚本拿到真实 ol/Map 而非 shim（它们本身就是逃生舱）。 */
  protected scriptMap(): MapLibreMap {
    return this.shim().getRawMap() as unknown as MapLibreMap;
  }
}
