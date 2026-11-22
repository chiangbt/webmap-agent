/**
 * ArcGISTools — ArcGIS Maps SDK 宿主对应的 GeoAgentTools 子类。
 *
 * 命令 surface 是 ArcGISMapShim（见 arcgis-engine.ts），它把 Style-Spec
 * sources/layers 物化为真实 ArcGIS 图层。MapView 是 2D 的，因此本子类不
 * 暴露 WebGL 专属工具 —— 例外是 `screenshot_map`：ArcGIS view 经
 * takeScreenshot 真正支持截图（其它 2D shim 无法合成截图）。
 * terrain/sky/globe/3D 命令以与 shim 相同的明确能力错误回答，直接调用
 * `runCommand` 的宿主也能拿到可操作的错误信息。
 *
 * 本文件从不导入 "@arcgis/*"；宿主经 `mapEngine: { kind: "arcgis", namespace }`
 * 传入自己的 namespace 集合（见 arcgis-engine.ts）。
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

/**
 * ArcGIS Maps SDK 引擎的 agent 工具实现类：命令 surface 为 ArcGISMapShim，
 * 支持 MapView（2D）与 SceneView（3D 地球）两种宿主。
 */
export class ArcGISTools extends GeoAgentTools {
  /** 校验引擎声明：必须是 arcgis 且由宿主注入 namespace。 */
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
    // 接受 MapView 实例或就绪的 <arcgis-map> 组件元素。
    const view = resolveArcGISView(map);
    return createArcGISMapShim(
      view,
      (this.engine as GeoAgentArcGISEngine).namespace,
    ) as unknown as MapLibreMap;
  }

  protected loadNamespace(): GeoAgentStyleSpecNamespace {
    // 宿主已注入 esri 类集合；本包从不导入 @arcgis/*。
    return (this.engine as GeoAgentArcGISEngine)
      .namespace as unknown as GeoAgentStyleSpecNamespace;
  }

  /** schema 与结果消息中显示的引擎名：按是否 SceneView 区分。 */
  protected engineDisplayName(): string {
    if (isArcGISMapShim(this.map)) {
      return this.map.isScene ? "ArcGIS SceneView" : "ArcGIS Maps SDK";
    }
    return "ArcGIS Maps SDK";
  }

  /** 用户脚本可见的 namespace 绑定名：`esri`。 */
  protected scriptNamespaceName(): string {
    return "esri";
  }

  /** run_maplibre_script 的 description：按 MapView/SceneView 区分措辞。 */
  protected scriptToolDescription(): string {
    if (isArcGISMapShim(this.map) && this.map.isScene) {
      return "Run a short JavaScript snippet against the live browser ArcGIS SceneView when no dedicated tool fits. The snippet runs in the page with these names in scope: map (the real ArcGIS SceneView), esri (the namespace classes passed via mapEngine), and helpers. Write ArcGIS Maps SDK code: this map is not MapLibre, and MapLibre calls will fail.";
    }
    return "Run a short JavaScript snippet against the live browser ArcGIS MapView when no dedicated tool fits. The snippet runs in the page with these names in scope: map (the real ArcGIS MapView), esri (the namespace classes passed via mapEngine), and helpers. Write ArcGIS Maps SDK code: this map is not MapLibre, and MapLibre calls will fail.";
  }

  /**
   * MapView 是 2D（无 globe/terrain/sky/fill-extrusion），但可以合成截图
   * —— 这是唯一具备该能力的 2D 引擎。
   */
  protected engineTools(): Tool[] {
    return [
      /**
       * screenshot_map — 把 ArcGIS 地图视图截图为 PNG data URL（底图与图层
       * 一并合成）。图片经面板状态发布给宿主 UI 展示，不进入模型上下文；
       * 结果只返回尺寸信息。用户要求"看看当前地图/导出图片"时调用。
       */
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
        if (this.shim().isScene) {
          // 工具层契约与 shim 按 kind 的行为保持一致。
          if (projection === "globe") {
            // SceneView 本身就是 3D 地球：请求 globe 视为成功空操作。
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
        // terrain 错误信息按 MapView/SceneView 分别给出可操作的指引。
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
      case "screenshot_map": {
        const screenshot = await this.shim().takeScreenshot();
        // base64 图片只发给宿主 UI，绝不进入模型上下文。
        this.publishStateData({ screenshot });
        return `Screenshot captured: ${screenshot.width}x${screenshot.height} png. The image was published to the panel state (screenshot.data_url) for the host UI to display; it is intentionally not included in this conversation.`;
      }
      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  }

  /** 取本子类在 createSurface 中构建的 shim（类型化访问）。 */
  private shim(): ArcGISMapShim {
    if (!isArcGISMapShim(this.map)) {
      throw new Error(
        "ArcGISTools surface is not an ArcGISMapShim.",
      );
    }
    return this.map;
  }

  /** 清空 overlay 并解绑 shim 的 watch/click 监听器。 */
  destroy(): void {
    if (isArcGISMapShim(this.map)) {
      this.map.destroy();
    }
    super.destroy();
  }

  /** add_marker 用 shim 的 marker 适配器构造 ArcGIS marker。 */
  protected createEngineMarker(color: string): GeoAgentMarker {
    return this.shim().createMarker(color) as unknown as GeoAgentMarker;
  }

  /** add_marker 用 shim 的 popup 适配器构造 ArcGIS popup。 */
  protected createEnginePopup(): GeoAgentPopup {
    return this.shim().createPopup() as unknown as GeoAgentPopup;
  }

  /** 用户脚本拿到真实 MapView/SceneView 而非 shim（它们本身就是逃生舱）。 */
  protected scriptMap(): MapLibreMap {
    return this.shim().getRawView() as unknown as MapLibreMap;
  }
}
