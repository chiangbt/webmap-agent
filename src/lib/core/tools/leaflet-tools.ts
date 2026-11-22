/**
 * LeafletAgentTools — Leaflet 宿主对应的 GeoAgentTools 子类。
 *
 * 命令 surface 是 LeafletMapShim（见 leaflet-engine.ts），它把 Style-Spec
 * sources/layers 物化为真实 Leaflet 图层。Leaflet 只有 2D 能力，因此本子类
 * 不暴露任何 WebGL 专属工具（`engineTools()` 为空），并以与 shim 相同的
 * 明确能力错误回答 WebGL 命令 —— 模型永远看不到 Leaflet 不具备的 3D 能力，
 * 直接调用 `runCommand` 的宿主也能拿到可操作的错误信息。
 *
 * 本文件从不导入 Leaflet；宿主经
 * `mapEngine: { kind: "leaflet", namespace: L }` 传入自己的 `L` namespace。
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
} from "../engines/leaflet-engine";

/**
 * Leaflet 引擎的 agent 工具实现类：命令 surface 为 LeafletMapShim，
 * 无 WebGL 专属工具，能力错误与 shim 保持一致。
 */
export class LeafletAgentTools extends GeoAgentTools {
  /** 校验引擎声明：必须是 leaflet 且由宿主注入 namespace。 */
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

  /** 把真实 Leaflet map 包装成 LeafletMapShim 作为命令 surface。 */
  protected createSurface(map: unknown): MapLibreMap {
    return createLeafletMapShim(
      map as LeafletMapLike,
      (this.engine as GeoAgentLeafletEngine).namespace,
    ) as unknown as MapLibreMap;
  }

  protected loadNamespace(): GeoAgentStyleSpecNamespace {
    // 宿主已注入真实 L namespace；本包从不导入 Leaflet。
    return (this.engine as GeoAgentLeafletEngine)
      .namespace as unknown as GeoAgentStyleSpecNamespace;
  }

  /** schema 与结果消息中显示的引擎名。 */
  protected engineDisplayName(): string {
    return "Leaflet";
  }

  /** 用户脚本可见的 namespace 绑定名：Leaflet 的 `L`。 */
  protected scriptNamespaceName(): string {
    return "L";
  }

  /** run_maplibre_script 的 description：明确要求写 Leaflet API 代码。 */
  protected scriptToolDescription(): string {
    return "Run a short JavaScript snippet against the live browser Leaflet map when no dedicated tool fits. The snippet runs in the page with these names in scope: map (the real L.Map), L (the Leaflet namespace), and helpers. Write Leaflet API code: this map is not MapLibre, and MapLibre calls will fail.";
  }

  /** Leaflet 仅 2D：不向模型暴露任何 WebGL 专属工具。 */
  protected engineTools(): Tool[] {
    return [];
  }

  /**
   * set_center 在 Leaflet 上使用 flyTo 平滑过渡到目标中心/缩放级别，
   * 而不是 jumpTo 的瞬时跳转；center 为 [lng, lat]（MapLibre 顺序），
   * shim 的 flyTo 内部会转换成 Leaflet 的 [lat, lng]。
   */
  protected setCenterCamera(center: [number, number], zoom: number): void {
    this.map.flyTo({ center, zoom });
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
        // Leaflet 只有 Web Mercator：请求 mercator 视为成功空操作，其余拒绝。
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

  /** 取本子类在 createSurface 中构建的 shim（类型化访问）。 */
  private shim(): LeafletMapShim {
    if (!isLeafletMapShim(this.map)) {
      throw new Error("LeafletAgentTools surface is not a LeafletMapShim.");
    }
    return this.map;
  }

  /** 清空 overlay 并解绑 shim 的地图监听器。 */
  destroy(): void {
    if (isLeafletMapShim(this.map)) {
      this.map.destroy();
    }
    super.destroy();
  }

  /** add_marker 用 shim 的 marker 适配器构造 Leaflet marker。 */
  protected createEngineMarker(color: string): GeoAgentMarker {
    return this.shim().createMarker(color) as unknown as GeoAgentMarker;
  }

  /** add_marker 用 shim 的 popup 适配器构造 Leaflet popup。 */
  protected createEnginePopup(): GeoAgentPopup {
    return this.shim().createPopup() as unknown as GeoAgentPopup;
  }

  /** 用户脚本拿到真实 L.Map 而非 shim（它们本身就是逃生舱）。 */
  protected scriptMap(): MapLibreMap {
    return this.shim().getRawMap() as unknown as MapLibreMap;
  }
}
