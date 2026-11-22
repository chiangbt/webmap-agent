/**
 * MapLibreAgentTools — WebGL Style-Spec 引擎（maplibre-gl，以及宿主注入
 * namespace 的 mapbox-gl）对应的 GeoAgentTools 子类。
 *
 * 这是唯一原生驱动真实 MapLibre API 表面的子类：命令 surface 就是地图本身。
 * 它拥有 WebGL 专属工具批次（globe 投影、3D terrain、sky、fill-extrusion
 * 建筑、canvas 截图），以及本包自带 maplibre-gl 依赖的惰性导入 —— 运行时
 * 加载 maplibre-gl 的唯一地点，因此 Leaflet/OpenLayers 宿主永远不必为此买单。
 *
 * 共享工具面、overlay 记账与命令分发都在基类（见 geoagent-tools.ts）。基类
 * 导出的一切都在此 re-export，让历史的 `core/maplibre-tools` 导入路径继续可用。
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

/** 截图等待 render 帧的超时上限（毫秒）。 */
const MAP_EVENT_TIMEOUT_MS = 8000;
import type { JsonObject } from "./geoagent-tools";

// 原样转发基类导出，维持历史导入路径的兼容性。
export * from "./geoagent-tools";

/** 默认引擎声明：本包自带的 `maplibre-gl`，经惰性导入加载。 */
const MAPLIBRE_ENGINE: GeoAgentMapEngine = { kind: "maplibre" };

/**
 * MapLibre/Mapbox 引擎的 agent 工具实现类：命令 surface 即原生地图，
 * 额外暴露 globe/terrain/sky/3D 建筑/截图等 WebGL 专属工具。
 */
export class MapLibreAgentTools extends GeoAgentTools {
  /** 校验引擎声明：缺省为 maplibre；2D 引擎声明直接拒绝并指路正确子类。 */
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
    // Style-Spec 引擎原样使用：地图本身就是命令 surface。
    return map as MapLibreMap;
  }

  /**
   * 解析引擎 namespace：宿主注入（mapbox 必须注入）优先；maplibre 缺省时
   * 动态 `import("maplibre-gl")`。
   */
  protected async loadNamespace(): Promise<GeoAgentStyleSpecNamespace> {
    const provided = (this.engine as GeoAgentStyleSpecEngine).namespace;
    if (provided) {
      // namespace 必须是库的真实对象：至少要有 Marker 构造器。
      if (typeof provided.Marker !== "function") {
        throw new Error(
          `The ${this.engine.kind} engine namespace has no Marker constructor; pass the library's real namespace object.`,
        );
      }
      return provided;
    }
    if (this.engine.kind === "mapbox") {
      // 本包从不导入 mapbox-gl：Mapbox 宿主必须自己传 namespace。
      throw new Error(
        'The mapbox engine requires its namespace: pass mapEngine { kind: "mapbox", namespace: mapboxgl }. This package never imports mapbox-gl itself.',
      );
    }
    // 本包运行时唯一的 maplibre-gl 加载点。用 namespace 导入而非默认导入：
    // MapLibre v6 是纯 ESM、去掉了默认导出，且 run_maplibre_script 要把整个
    // namespace 对象交给用户脚本。
    const module = await import("maplibre-gl");
    return module as unknown as GeoAgentStyleSpecNamespace;
  }

  /** schema 与结果消息中显示的引擎名。 */
  protected engineDisplayName(): string {
    return this.engine.kind === "mapbox" ? "Mapbox GL JS" : "MapLibre";
  }

  /** 用户脚本可见的 namespace 绑定名。 */
  protected scriptNamespaceName(): string {
    return this.engine.kind === "mapbox" ? "mapboxgl" : "maplibregl";
  }

  /** run_maplibre_script 的 description 文案，按引擎区分措辞。 */
  protected scriptToolDescription(): string {
    if (this.engine.kind === "mapbox") {
      return "Run a short JavaScript snippet against the live browser Mapbox GL JS map when no dedicated tool fits. The snippet runs in the page with these names in scope: map, mapboxgl, and helpers.";
    }
    return "Run a short JavaScript snippet against the live browser MapLibre map when no dedicated tool fits.";
  }

  /**
   * WebGL 专属工具批次。仅本子类向模型暴露这些工具；2D 引擎的
   * `engineTools()` 为空，因此 Leaflet/OpenLayers 的 agent 根本看不到
   * 它们不具备的 3D 能力。
   */
  protected engineTools(): Tool[] {
    return [
      /**
       * set_projection — 在 globe 与 mercator 投影之间切换（仅 MapLibre/
       * Mapbox 支持）。代理需要 3D 地球视角或平面地图时调用；projection
       * 二选一。
       */
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
      /**
       * add_terrain — 添加 raster-dem source 并启用 3D 地形渲染。
       * url 为 DEM 瓦片模板；encoding 指定高程编码（terrarium/mapbox）；
       * exaggeration 控制夸张系数；source_id 可自定义 source 名。
       */
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
      /**
       * clear_terrain — 关闭地形渲染并移除 agent 登记的 terrain source 元数据；
       * 无参数。展示完地形效果后收尾时调用。
       */
      tool({
        name: "clear_terrain",
        description:
          "Disable MapLibre terrain and remove agent-added terrain source metadata.",
        inputSchema: z.object({}),
        callback: () => this.runCommand("clear_terrain"),
      }),
      /**
       * set_sky — 设置 MapLibre sky 规格（需当前版本支持 setSky）。
       * sky 为完整 sky specification 对象。营造大气/天空背景效果时调用。
       */
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
      /**
       * remove_sky — 移除 sky 规格（需当前版本支持）；无参数。
       */
      tool({
        name: "remove_sky",
        description:
          "Remove the MapLibre sky specification when supported by the active MapLibre version.",
        inputSchema: z.object({}),
        callback: () => this.runCommand("remove_sky"),
      }),
      /**
       * add_3d_buildings — 添加 fill-extrusion 3D 建筑图层：复用既有 vector
       * source 或回退到 OpenFreeMap。layer_id/source/source_layer/min_zoom/
       * 颜色/透明度/高度与基底属性名均可定制。展示城市三维形态时调用。
       */
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
      /**
       * screenshot_map — 把地图画布截图为 PNG data URL。图片经面板状态发布给
       * 宿主 UI 展示，不进入模型上下文；结果只返回尺寸信息。用户要求
       * "看看当前地图/导出图片"时调用。
       */
      tool({
        name: "screenshot_map",
        description: "Capture the browser map canvas as a PNG data URL.",
        inputSchema: z.object({}),
        callback: () => this.runCommand("screenshot_map"),
      }),
    ];
  }

  /**
   * 引擎专属命令分发：globe 投影、terrain、sky、3D 建筑、截图等 WebGL 能力。
   * 未识别的命令抛错兜底。
   */
  protected async executeEngineCommand(
    command: string,
    args: JsonObject,
  ): Promise<unknown> {
    if (command === "set_projection") {
      const projection = stringArg(args, "projection", "mercator")
        .trim()
        .toLowerCase();
      // 只接受 globe / mercator 两个值，其余明确拒绝。
      if (projection !== "globe" && projection !== "mercator") {
        throw new Error(
          `Unsupported projection: ${projection}. Use globe or mercator.`,
        );
      }
      // MapLibre 接受 `{ type }`；mapbox-gl 接受名称字符串（或 `{ name }`），
      // 传 MapLibre 形状会抛错。
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
      // terrain 以 native overlay 登记为 "__terrain"：clear_terrain 与
      // clear_layers 都能经同一套记账清理。
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
      // sky 以空图层组的 native overlay 登记，便于 remove_sky / clear_layers 统一清理。
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
      const screenshot = (await this.captureScreenshot()) as {
        data_url: string;
        width: number;
        height: number;
      };
      // base64 图片只发给宿主 UI，绝不进入模型上下文。
      this.publishStateData({ screenshot });
      return `Screenshot captured: ${screenshot.width}x${screenshot.height} png. The image was published to the panel state (screenshot.data_url) for the host UI to display; it is intentionally not included in this conversation.`;
    }

    throw new Error(`Unsupported command: ${command}`);
  }

  /**
   * 在渲染帧内截取地图画布。除非地图以 `preserveDrawingBuffer: true` 创建，
   * WebGL 会在合成后清空 drawing buffer —— 在渲染回调之外读取画布得到的是
   * 空白图；`triggerRepaint` + `once("render")` 保证在 buffer 仍然完整时读取。
   */
  private captureScreenshot(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // settled 保证超时与 render 两条路径只有先到者生效。
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        action();
      };
      const timeoutId = window.setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              "screenshot_map timed out waiting for a render frame; the map may not be visible. Create the map with canvasContextAttributes.preserveDrawingBuffer: true as a fallback.",
            ),
          ),
        );
      }, MAP_EVENT_TIMEOUT_MS);
      // 渲染回调内读取画布：此时 drawing buffer 尚未被清空。
      this.map.once("render", () => {
        finish(() => {
          const canvas = this.map.getCanvas();
          resolve({
            data_url: canvas.toDataURL("image/png"),
            width: canvas.width,
            height: canvas.height,
          });
        });
      });
      // 主动触发一次重绘，确保即使地图静止也能等到 render 帧。
      this.map.triggerRepaint?.();
    });
  }

  /**
   * 构建 3D 建筑图层：优先复用既有 vector source（openmaptiles/maptiler/
   * carto/composite 等常见 id），否则回退创建 OpenFreeMap buildings source。
   *
   * @returns 创建的图层 id
   */
  private async add3dBuildings(args: JsonObject): Promise<string> {
    const layerId = stringArg(args, "layer_id", "3d-buildings");
    const requestedSource = stringArg(args, "source");
    const style = this.map.getStyle();
    // 显式指定的 source 存在则直接采用。
    let sourceId =
      requestedSource && this.map.getSource(requestedSource)
        ? requestedSource
        : "";
    if (!sourceId) {
      // 在 style 里找常见建筑 vector source（openmaptiles/maptiler/carto/composite）。
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
      // 找不到任何可用 vector source：回退到 OpenFreeMap planet 瓦片。
      sourceId = "buildings-source";
      sourceSpecs[sourceId] = {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
      } as SourceSpecification;
    }
    // 高度/基底属性名按数据集不同可定制（OpenFreeMap 与 OMT schema 略有差异）。
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
              // 高度取值链：指定属性 → 通用 height 属性 → 默认 10 米兜底。
              "fill-extrusion-height": [
                "coalesce",
                ["get", heightProperty],
                ["get", "height"],
                10,
              ],
              // 基底高度：指定属性缺失时落到 0（贴地）。
              "fill-extrusion-base": ["coalesce", ["get", baseProperty], 0],
              // 透明度夹取到 [0,1]，默认 0.6。
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
