/**
 * Google Earth Engine（GEE）浏览器端集成服务。
 *
 * 职责：
 * - 加载 `@google/earthengine` 动态模块并完成 OAuth / access token 鉴权与
 *   `ee.initialize`（绑定 Google Cloud project）；
 * - 拉取并解析 GEE 官方目录（opengeos/Earth-Engine-Catalog，JSON/TSV 双源
 *   兜底）与社区目录（awesome-gee-community-datasets，JSON/CSV 双源兜底），
 *   带进程内缓存与过期回退；
 * - 把 dataset 转成可渲染的 ee 对象（Image / ImageCollection 合成 /
 *   FeatureCollection / OPERA DSWx 特例），生成 tile URL 供地图引擎叠加；
 * - 提供 NDVI 等归一化差值指数图层、区域统计（reduceRegion + Reducer）、
 *   以及受控执行 LLM 生成的 GEE JavaScript 片段（runSnippet）。
 */

/**
 * Earth Engine 服务的配置选项。
 */
export interface EarthEngineOptions {
  /** 是否启用 Earth Engine 功能；未显式置 false 时视为启用。 */
  enabled?: boolean;
  /** Google Cloud OAuth Client ID（形如 `xxx.apps.googleusercontent.com`），交互式鉴权必需。 */
  oauthClientId?: string;
  /** Earth Engine 所属的 Google Cloud project ID。 */
  projectId?: string;
  /** 预配置的 access token；存在时跳过 OAuth 弹窗流程直接注入 token。 */
  accessToken?: string;
  /** token 类型，默认 "Bearer"。 */
  tokenType?: string;
  /** token 有效期（秒），非法值回退为 3600。 */
  tokenExpiresIn?: number;
  /** 是否把社区 dataset 目录并入搜索结果，默认 true。 */
  includeCommunityCatalog?: boolean;
  /** 目录缓存 TTL（毫秒），默认 24 小时。 */
  catalogCacheTtlMs?: number;
}

/**
 * GEE 资产（asset）类型的归一化枚举：影像、影像集合、要素集合、
 * BigQuery 表，以及无法识别时的 Unknown。
 */
export type GeeAssetType =
  | "Image"
  | "ImageCollection"
  | "FeatureCollection"
  | "BigQueryTable"
  | "Unknown";

/**
 * GEE 目录中的一个 dataset 条目（官方或社区来源统一映射到该形状）。
 */
export interface GeeDataset {
  /** 资产 ID，如 "COPERNICUS/S2_SR_HARMONIZED"。 */
  id: string;
  /** 展示名称。 */
  name?: string;
  /** 目录标题。 */
  title?: string;
  /** 资产类型（已归一化）。 */
  type?: GeeAssetType | string;
  /** 归一化后的展示分类，如 "Satellite Imagery"。 */
  category?: string;
  /** 提供方描述。 */
  provider?: string;
  /** 数据起始日期。 */
  start_date?: string;
  /** 数据截止日期。 */
  end_date?: string;
  /** 描述（压缩后截断到 500 字符）。 */
  description?: string;
  /** 关键词列表（压缩后最多 15 个）。 */
  keywords?: string[];
  /** 详情页链接。 */
  url?: string;
  /** 许可证信息。 */
  license?: string;
  /** 来源：官方目录或社区目录。 */
  source?: "official" | "community";
  /** BigQuery 表名（仅 BigQueryTable 类型，从 snippet 正则提取）。 */
  bigquery_table?: string;
  /** 原始 bbox 字符串（west,south,east,north）。 */
  bbox?: string;
  /** 示例脚本（仅官方目录）。 */
  script?: string;
  /** 缩略图地址（仅官方目录）。 */
  thumbnail?: string;
  /** 目录页地址（仅官方目录）。 */
  catalog_url?: string;
}

/**
 * 已注册的 Earth Engine 图层记录：保存图层名、资产信息、可视化参数与
 * 生成的 tile URL；`eeObject` 仅在服务内部保留（导出 payload 时剥离），
 * 以便后续 setLayerVisualization 重用。
 */
export interface EarthEngineLayerRecord {
  /** 图层名（截断到 50 字符，可重复注册覆盖）。 */
  name: string;
  /** 来源资产 ID。 */
  asset_id?: string;
  /** 资产类型。 */
  asset_type?: GeeAssetType | string;
  /** ee 对象的构造类型名（如 "ee.Image"），用于诊断。 */
  object_type: string;
  /** 可视化参数（bands/min/max/palette 等）。 */
  vis_params: Record<string, unknown>;
  /** 地图瓦片 URL。 */
  tile_url?: string;
  /** 图层来源说明（如来自哪个工具）。 */
  source?: string;
  /** 附加元数据。 */
  metadata?: Record<string, unknown>;
  /** 服务内部的 ee 对象引用，不对外导出。 */
  eeObject?: unknown;
}

/**
 * dataset 目录的进程内缓存条目。
 */
interface CatalogCacheEntry {
  /** 缓存写入时间戳（毫秒）。 */
  createdAt: number;
  /** 当前有效的 dataset 列表。 */
  datasets: GeeDataset[];
  /** 上一轮成功数据；刷新失败时作为兜底返回。 */
  staleDatasets?: GeeDataset[];
}

/**
 * `@google/earthengine` 模块的手工类型描述：只声明本服务实际用到的
 * API（data.* 鉴权、initialize、构造器、Filter/Reducer 等），其余按
 * unknown 处理。所有方法均为可选，因为不同版本/环境可能缺失。
 */
interface EeModule {
  /** `ee.data` 命名空间：鉴权与资产元数据接口。 */
  data?: {
    /** OAuth 交互式鉴权；浏览器环境通常先静默尝试，失败时回调 onImmediateFailed。 */
    authenticateViaOauth?: (
      clientId: string,
      success?: () => void,
      failure?: (error: unknown) => void,
      scopes?: unknown,
      onImmediateFailed?: () => void,
    ) => void;
    /** 弹窗式 OAuth 鉴权（静默鉴权失败的兜底）。 */
    authenticateViaPopup?: (
      success?: () => void,
      failure?: (error: unknown) => void,
    ) => void;
    /** 按资产 ID 查询资产元数据（用于探测资产类型）。 */
    getAsset?: (
      assetId: string,
      success?: (asset: Record<string, unknown>) => void,
      failure?: (error: unknown) => void,
    ) => void;
    /** 读取当前已缓存的 auth token（未登录返回 null）。 */
    getAuthToken?: () => string | null | undefined;
    /** 读取当前 token 对应的 OAuth Client ID。 */
    getAuthClientId?: () => string | null | undefined;
    /** 清除已缓存的 auth token。 */
    clearAuthToken?: () => void;
    /** 直接注入预配置的 access token（跳过 OAuth 流程）。 */
    setAuthToken?: (
      clientId: string,
      tokenType: string,
      accessToken: string,
      expiresIn: number,
      extraScopes?: string[],
      callback?: () => void,
      updateAuthLibrary?: boolean,
      suppressDefaultScopes?: boolean,
    ) => void;
  };
  /** 初始化 Earth Engine API（绑定 project），回调式异步。 */
  initialize?: (
    baseUrl?: string | null,
    tileUrl?: string | null,
    success?: () => void,
    failure?: (error: unknown) => void,
    xsrfToken?: string | null,
    project?: string | null,
  ) => void;
  /** ee.Image 构造器。 */
  Image: new (asset: unknown) => EeObject;
  /** ee.ImageCollection 构造器。 */
  ImageCollection: new (asset: unknown) => EeObject;
  /** ee.FeatureCollection 构造器。 */
  FeatureCollection: new (asset: unknown) => EeObject;
  /** ee.Geometry 工厂（本服务只用 Rectangle）。 */
  Geometry: {
    Rectangle: (bbox: number[]) => EeObject;
  };
  /** ee.Filter 工厂（本服务只用 eq / lt）。 */
  Filter: {
    eq: (property: string, value: unknown) => EeObject;
    lt: (property: string, value: unknown) => EeObject;
  };
  /** ee.Reducer 工厂：按统计名索引（mean/min/max/...）返回 reducer。 */
  Reducer: Record<string, () => EeObject>;
}

/**
 * 任意 ee 服务端对象的最小接口：方法名动态（EE API 为代理对象），
 * 只声明本服务依赖的几个方法；未声明成员按 unknown 索引访问。
 */
interface EeObject {
  [key: string]: unknown;
  /** 序列化为计算图字符串（用于 tile URL 缓存 key）。 */
  serialize?: () => string;
  /** getMap：返回含 tile_fetcher 的地图信息（回调或返回值两种形态）。 */
  getMap?: (
    visParams: Record<string, unknown>,
    callback?: (map: Record<string, unknown> | undefined, error?: unknown) => void,
  ) => Record<string, unknown> | void;
  /** getMapId：getMap 的旧别名。 */
  getMapId?: (
    visParams: Record<string, unknown>,
    callback?: (map: Record<string, unknown> | undefined, error?: unknown) => void,
  ) => Record<string, unknown> | void;
  /** 异步求值（推荐）：服务端计算完成后回调。 */
  evaluate?: (
    success: (value: unknown) => void,
    failure?: (error: unknown) => void,
  ) => void;
  /** getInfo：同步返回或回调式求值。 */
  getInfo?: (callback?: (value: unknown) => void) => unknown;
}

/** GEE 官方 dataset 目录（opengeos 维护）的 JSON 源地址。 */
const OFFICIAL_CATALOG_JSON_URL =
  "https://raw.githubusercontent.com/opengeos/Earth-Engine-Catalog/master/gee_catalog.json";
/** GEE 官方 dataset 目录的 TSV 兜底源地址（JSON 拉取失败时使用）。 */
const OFFICIAL_CATALOG_TSV_URL =
  "https://raw.githubusercontent.com/opengeos/Earth-Engine-Catalog/master/gee_catalog.tsv";
/** GEE 社区 dataset 目录（samapriya 维护）的 JSON 源地址。 */
const COMMUNITY_CATALOG_JSON_URL =
  "https://raw.githubusercontent.com/samapriya/awesome-gee-community-datasets/master/community_datasets.json";
/** GEE 社区 dataset 目录的 CSV 兜底源地址。 */
const COMMUNITY_CATALOG_CSV_URL =
  "https://raw.githubusercontent.com/samapriya/awesome-gee-community-datasets/master/community_datasets.csv";

/** 目录缓存默认 TTL：24 小时。 */
const DEFAULT_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 进程内目录缓存，按 "all"/"official" 两个 key 分开存放（跨实例共享）。 */
const CATALOG_CACHE = new Map<string, CatalogCacheEntry>();

/**
 * 官方目录原始 category（snake_case，可能逗号分隔多个）到展示分类名的
 * 映射表；未命中的原始值会落到 "Other"。
 */
const CATEGORY_RAW_TO_DISPLAY: Record<string, string> = {
  agriculture: "Agriculture",
  atmosphere: "Atmosphere",
  climate: "Climate",
  cryosphere: "Cryosphere",
  ecosystems: "Ecosystems",
  "elevation-topography": "Elevation & Topography",
  fire: "Fire",
  "forest-biomass": "Forest & Biomass",
  "infrastructure-boundaries": "Infrastructure & Boundaries",
  "landuse-landcover": "Land Use & Land Cover",
  oceans: "Oceans",
  orthophotos: "Orthophotos",
  "plant-productivity": "Plant Productivity",
  population: "Population",
  precipitation: "Precipitation",
  "satellite-imagery": "Satellite Imagery",
  soil: "Soil",
  "surface-ground-water": "Surface & Ground Water",
  "vegetation-indices": "Vegetation Indices",
  "water-vapor": "Water Vapor",
};

/**
 * 各展示分类的关键词映射：当目录条目没有提供 category 时，
 * 用这些关键词在 id/title/keywords 中猜测分类。
 */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  Agriculture: ["agriculture", "crop", "cropland", "irrigation"],
  Atmosphere: ["atmosphere", "aerosol", "ozone", "air quality"],
  Climate: ["climate", "temperature", "era5", "ecmwf"],
  Cryosphere: ["ice", "snow", "glacier", "arctic"],
  Ecosystems: ["ecosystem", "habitat", "biodiversity"],
  "Elevation & Topography": ["elevation", "dem", "srtm", "terrain"],
  Fire: ["fire", "burn", "wildfire"],
  "Forest & Biomass": ["forest", "tree", "biomass", "canopy"],
  "Infrastructure & Boundaries": ["boundary", "admin", "tiger", "urban"],
  "Land Use & Land Cover": ["landcover", "land cover", "lulc", "worldcover"],
  Oceans: ["ocean", "marine", "sst", "coastal"],
  Orthophotos: ["orthophoto", "aerial", "naip"],
  "Plant Productivity": ["gpp", "npp", "productivity"],
  Population: ["population", "demographic", "worldpop"],
  Precipitation: ["precipitation", "rainfall", "chirps", "gpm"],
  "Satellite Imagery": ["landsat", "sentinel", "modis", "viirs", "satellite"],
  Soil: ["soil", "soil moisture"],
  "Surface & Ground Water": ["water", "hydrology", "flood", "jrc"],
  "Vegetation Indices": ["ndvi", "evi", "vegetation", "savi"],
  "Water Vapor": ["water vapor", "humidity"],
};

/**
 * 把未知类型的列表值解析为字符串数组：既接受数组也接受逗号分隔字符串；
 * 空值/空结果返回 undefined。
 *
 * @param value - 数组或逗号分隔字符串（如 "B4,B3"）
 * @returns 去空后的字符串数组；无有效项时为 undefined
 */
export function parseList(value: unknown): string[] | undefined {
  // null/undefined/空串统一视为未提供。
  if (value == null || value === "") {
    return undefined;
  }
  if (Array.isArray(value)) {
    // 数组：逐项转字符串、去首尾空白、丢弃空项。
    const items = value.map(String).map((item) => item.trim()).filter(Boolean);
    return items.length ? items : undefined;
  }
  // 字符串：按逗号切分、去空白、丢弃空项。
  const items = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

/**
 * 解析 bbox 参数为 [west, south, east, north] 四元数值数组，并做合法性校验。
 *
 * @param value - "west,south,east,north" 字符串或 4 元数组
 * @returns 数值 bbox 数组；未提供时返回 undefined
 * @throws 格式不符、非有限数字或 west>=east / south>=north 时抛错
 */
export function parseBbox(value: unknown): number[] | undefined {
  // 未提供时直接返回，调用方按“无 bbox”分支处理。
  if (value == null || value === "") {
    return undefined;
  }
  // 兼容数组与逗号分隔字符串两种输入。
  const values = Array.isArray(value) ? value : String(value).split(",");
  if (values.length !== 4) {
    throw new Error("bbox must contain west,south,east,north");
  }
  const bbox = values.map(Number);
  // 拒绝 NaN / Infinity 等非有限坐标。
  if (!bbox.every(Number.isFinite)) {
    throw new Error("bbox coordinates must be finite numbers");
  }
  const [west, south, east, north] = bbox;
  // 校验方向：西必须小于东、南必须小于北。
  if (west >= east || south >= north) {
    throw new Error("bbox coordinates must satisfy west < east and south < north");
  }
  return bbox;
}

/**
 * 解析调色板（palette）参数：支持多个颜色值，也支持用内置调色板名
 * （terrain/dem/elevation/earth/viridis/grayscale 等）展开成颜色数组。
 *
 * @param value - 颜色列表、逗号分隔颜色或调色板名
 * @returns 颜色数组；未提供时为 undefined
 */
export function geePaletteColors(value: unknown): string[] | undefined {
  const parsed = parseList(value);
  if (!parsed) {
    return undefined;
  }
  // 多个颜色：视为显式调色板原样返回。
  if (parsed.length > 1) {
    return parsed;
  }
  // 单值：尝试按内置调色板名展开；未命中则当作单一颜色使用。
  const name = parsed[0].toLowerCase();
  const palettes: Record<string, string[]> = {
    terrain: ["#1a9850", "#91cf60", "#fee08b", "#d08b39", "#f5f5f5"],
    dem: ["#1a9850", "#91cf60", "#fee08b", "#d08b39", "#f5f5f5"],
    elevation: ["#1a9850", "#91cf60", "#fee08b", "#d08b39", "#f5f5f5"],
    earth: ["#1a9850", "#91cf60", "#fee08b", "#d08b39", "#f5f5f5"],
    viridis: ["#440154", "#31688e", "#35b779", "#fde725"],
    grayscale: ["#000000", "#ffffff"],
    grey: ["#000000", "#ffffff"],
    gray: ["#000000", "#ffffff"],
  };
  return palettes[name] ?? parsed;
}

/**
 * 构造 GEE 可视化参数（visParams）。Image/ImageCollection 使用
 * bands/min/max/palette；FeatureCollection 仅支持单一描边色（color）。
 *
 * @param input - bands、min_value、max_value、palette 与是否为
 *                FeatureCollection 的标记
 * @returns 传给 ee 对象 getMap 的可视化参数对象
 */
export function buildGeeVisParams(input: {
  bands?: unknown;
  min_value?: unknown;
  max_value?: unknown;
  palette?: unknown;
  forFeatureCollection?: boolean;
}): Record<string, unknown> {
  const visParams: Record<string, unknown> = {};
  const bands = parseList(input.bands);
  // FeatureCollection 不支持波段选择与拉伸区间。
  if (bands && !input.forFeatureCollection) {
    visParams.bands = bands;
  }
  if (input.min_value != null && !input.forFeatureCollection) {
    visParams.min = Number(input.min_value);
  }
  if (input.max_value != null && !input.forFeatureCollection) {
    visParams.max = Number(input.max_value);
  }
  const palette = geePaletteColors(input.palette);
  if (palette) {
    if (input.forFeatureCollection) {
      // 要素集合：只取第一个颜色作为填充/描边色。
      visParams.color = palette[0];
    } else {
      visParams.palette = palette;
    }
  }
  return visParams;
}

/**
 * 压缩 dataset 条目用于返回给 LLM：只保留有值的核心字段，
 * description 截断到 500 字符、keywords 截断到 15 个，控制上下文体积。
 *
 * @param dataset - 完整的 dataset 条目
 * @returns 精简后的 dataset 副本
 */
export function compactGeeDataset(dataset: GeeDataset): GeeDataset {
  const out: GeeDataset = { id: dataset.id };
  // 白名单字段逐个拷贝，undefined 的字段不写入。
  for (const key of [
    "id",
    "name",
    "title",
    "type",
    "category",
    "provider",
    "start_date",
    "end_date",
    "source",
    "url",
    "license",
    "bigquery_table",
  ] as Array<keyof GeeDataset>) {
    if (dataset[key]) {
      (out as unknown as Record<string, unknown>)[key] = dataset[key];
    }
  }
  const description = String(dataset.description ?? "").trim();
  if (description) {
    out.description = description.slice(0, 500);
  }
  if (dataset.keywords?.length) {
    out.keywords = dataset.keywords.slice(0, 15);
  }
  return out;
}

/**
 * 把任意输入归一化为标准 GEE 资产类型枚举：先统一小写并去掉
 * 下划线/空白/连字符，再按已知别名（含 "ee" 前缀、"table"）匹配。
 *
 * @param value - 任意形式的类型描述（如 "image_collection"、"ee.Image"）
 * @returns 归一化的 GeeAssetType；无法识别时返回 "Unknown"
 */
export function normalizeGeeAssetType(value: unknown): GeeAssetType {
  // 去掉分隔符后统一比较，兼容多种书写风格。
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
  if (normalized === "image" || normalized === "eeimage") {
    return "Image";
  }
  if (normalized === "imagecollection" || normalized === "eeimagecollection") {
    return "ImageCollection";
  }
  if (
    normalized === "featurecollection" ||
    normalized === "table" ||
    normalized === "eefeaturecollection"
  ) {
    return "FeatureCollection";
  }
  if (normalized === "bigquerytable") {
    return "BigQueryTable";
  }
  return "Unknown";
}

/** 把官方目录的原始 category（取逗号分隔的第一个）映射为展示分类名。 */
function convertRawCategory(rawCategory: unknown): string {
  const first = String(rawCategory ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return CATEGORY_RAW_TO_DISPLAY[first] ?? "Other";
}

/**
 * 按关键词为没有 category 的 dataset 猜测分类：拼接 id/title/name/keywords
 * 后逐个分类匹配，命中即返回；全都不命中归入 "Other"。
 */
function categorizeDataset(dataset: GeeDataset): string {
  const text = [
    dataset.id,
    dataset.title,
    dataset.name,
    dataset.keywords?.join(" "),
  ]
    .join(" ")
    .toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      return category;
    }
  }
  return "Other";
}

/**
 * 解析单行 CSV（支持引号包裹与双引号转义），返回字段值数组。
 * 逐字符状态机处理：quoted 表示当前是否在引号段内。
 */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      // 引号段内的连续两个双引号是一个转义的字面量引号。
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    // 引号段外的逗号才是字段分隔符。
    if (char === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  // 收尾：把最后一个字段压入。
  values.push(current);
  return values;
}

/**
 * 把 TSV 或 CSV 全文解析为以表头为键的行对象数组；自动统一换行符、
 * 跳过空行，缺失的列填充空字符串。
 */
function parseDelimitedRows(content: string, delimiter: "," | "\t"): Record<string, string>[] {
  // 统一 CRLF/CR 为 LF 后按行拆分。
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  // 第一个非空行作为表头。
  const headerLine = lines.find((line) => line.trim());
  if (!headerLine) {
    return [];
  }
  const headers =
    delimiter === ","
      ? parseCsvLine(headerLine).map((item) => item.trim())
      : headerLine.split("\t").map((item) => item.trim());
  const startIndex = lines.indexOf(headerLine) + 1;
  return lines
    .slice(startIndex)
    .filter((line) => line.trim())
    .map((line) => {
      const values =
        delimiter === "," ? parseCsvLine(line) : line.split("\t");
      const row: Record<string, string> = {};
      // 按表头逐列取值；列缺失时填充空串。
      headers.forEach((header, index) => {
        row[header] = values[index] ?? "";
      });
      return row;
    });
}

/** 从官方目录的 snippet 脚本中提取 loadBigQueryTable("...") 的表名。 */
function extractBigQueryTable(snippet: unknown): string | undefined {
  const match = String(snippet ?? "").match(/loadBigQueryTable\(['"]([^'"]+)['"]\)/);
  return match?.[1];
}

/**
 * 把官方目录的一条原始记录映射为标准 GeeDataset。
 *
 * @returns 映射结果；条目已弃用（deprecated）或没有 id 时返回 null
 */
function officialDatasetFromItem(item: Record<string, unknown>): GeeDataset | null {
  // 弃用条目直接过滤（JSON 里是布尔，TSV 里是字符串 "true"）。
  if (item.deprecated === true || String(item.deprecated ?? "").toLowerCase() === "true") {
    return null;
  }
  const type = normalizeGeeAssetType(item.type);
  const keywords = Array.isArray(item.keywords)
    ? item.keywords.map(String)
    : parseList(item.keywords) ?? [];
  const dataset: GeeDataset = {
    id: String(item.id ?? ""),
    name: String(item.title ?? item.id ?? ""),
    title: String(item.title ?? ""),
    type,
    description: String(item.snippet ?? item.description ?? ""),
    provider: String(item.provider ?? ""),
    start_date: String(item.start_date ?? item.state_date ?? ""),
    end_date: String(item.end_date ?? ""),
    bbox: String(item.bbox ?? ""),
    keywords,
    url: String(item.url ?? ""),
    script: String(item.script ?? ""),
    thumbnail: String(item.thumbnail ?? ""),
    license: String(item.license ?? ""),
    catalog_url: String(item.catalog ?? ""),
    source: "official",
  };
  if (type === "BigQueryTable") {
    dataset.bigquery_table = extractBigQueryTable(item.snippet);
  }
  // 优先用目录自带的 category，否则按关键词猜测。
  dataset.category = item.category ? convertRawCategory(item.category) : categorizeDataset(dataset);
  return dataset.id ? dataset : null;
}

/**
 * 解析官方 GEE 目录内容为 dataset 列表。
 *
 * @param content - 原始目录文本
 * @param format - "json"（支持顶层数组或 { datasets: [...] } 包裹）或 "tsv"
 * @returns 过滤掉弃用/无效条目后的 dataset 列表
 */
export function parseOfficialGeeCatalog(content: string, format: "json" | "tsv"): GeeDataset[] {
  if (format === "json") {
    const payload = JSON.parse(content) as unknown;
    // 兼容两种 JSON 形状：顶层数组，或 { datasets: [...] } 包裹对象。
    const items = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { datasets?: unknown }).datasets)
        ? ((payload as { datasets: unknown[] }).datasets)
        : [];
    return items
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map(officialDatasetFromItem)
      .filter((item): item is GeeDataset => item != null);
  }
  // TSV 兜底：逐行解析后走同一映射与过滤。
  return parseDelimitedRows(content, "\t")
    .map((row) => officialDatasetFromItem(row))
    .filter((item): item is GeeDataset => item != null);
}

/**
 * 把社区目录的一条原始记录映射为标准 GeeDataset；社区目录字段名不统一
 * （id/asset/asset_id/dataset_id、keywords/tags、url/link 等），这里逐一兼容。
 *
 * @returns 映射结果；没有资产 ID 时返回 null
 */
function communityDatasetFromItem(item: Record<string, unknown>): GeeDataset | null {
  // 多种候选键依次兜底，取到第一个非空值作为资产 ID。
  const assetId =
    String(item.id ?? item.asset ?? item.asset_id ?? item.dataset_id ?? "").trim();
  if (!assetId) {
    return null;
  }
  const keywords = Array.isArray(item.keywords)
    ? item.keywords.map(String)
    : parseList(item.keywords ?? item.tags) ?? [];
  const dataset: GeeDataset = {
    id: assetId,
    name: String(item.title ?? item.name ?? assetId),
    title: String(item.title ?? item.name ?? assetId),
    type: normalizeGeeAssetType(item.type ?? item.asset_type),
    description: String(item.description ?? item.snippet ?? ""),
    provider: String(item.provider ?? item.source ?? ""),
    keywords,
    url: String(item.url ?? item.link ?? ""),
    license: String(item.license ?? ""),
    source: "community",
  };
  dataset.category = item.category
    ? String(item.category)
    : categorizeDataset(dataset);
  return dataset;
}

/**
 * 解析社区 GEE 目录内容为 dataset 列表。
 *
 * @param content - 原始目录文本
 * @param format - "json"（顶层数组或 { datasets: [...] }）或 "csv"
 */
export function parseCommunityGeeCatalog(
  content: string,
  format: "json" | "csv",
): GeeDataset[] {
  if (format === "json") {
    const payload = JSON.parse(content) as unknown;
    // 同官方目录：兼容数组与包裹对象两种形状。
    const items = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { datasets?: unknown }).datasets)
        ? ((payload as { datasets: unknown[] }).datasets)
        : [];
    return items
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map(communityDatasetFromItem)
      .filter((item): item is GeeDataset => item != null);
  }
  return parseDelimitedRows(content, ",")
    .map((row) => communityDatasetFromItem(row))
    .filter((item): item is GeeDataset => item != null);
}

/**
 * 把用户提供的过滤值强制转换为 GEE Filter 能接受的类型：
 * "true"/"false" 转布尔、有限数字字符串转数字，其余保留为字符串。
 */
function coerceFilterValue(value: unknown): unknown {
  const text = String(value ?? "").trim();
  if (text.toLowerCase() === "true") {
    return true;
  }
  if (text.toLowerCase() === "false") {
    return false;
  }
  // 空串 Number("") 为 0，会误判成数字，必须先排除。
  const numberValue = Number(text);
  if (text !== "" && Number.isFinite(numberValue)) {
    return numberValue;
  }
  return text;
}

/**
 * 按指数名称返回默认调色板：植被类（NDVI/SAVI/EVI）、水体类
 * （NDWI/MNDWI/NDMI）、燃烧类（NBR/NBR2）各有专属配色，其余用红-白-绿。
 */
function defaultIndexPalette(indexName: string): string[] {
  const key = indexName.trim().toUpperCase();
  if (["NDVI", "SAVI", "EVI"].includes(key)) {
    return ["8c510a", "f6e8c3", "f5f5f5", "c7eae5", "01665e"];
  }
  if (["NDWI", "MNDWI", "NDMI"].includes(key)) {
    return ["8c510a", "f7f7f7", "2166ac"];
  }
  if (["NBR", "NBR2"].includes(key)) {
    return ["d7191c", "fdae61", "ffffbf", "a6d96a", "1a9641"];
  }
  return ["d73027", "f7f7f7", "1a9850"];
}

/**
 * 归一化 ImageCollection 合成方法：白名单为 mosaic/median/mean/min/max/first，
 * allowMode 时额外放行 mode；非法值回退为传入的默认方法。
 */
function normalizeCompositeMethod(
  method: unknown,
  defaultMethod: string,
  allowMode = false,
): string {
  const value = String(method ?? "").toLowerCase().trim();
  const allowed = new Set(["mosaic", "median", "mean", "min", "max", "first"]);
  if (allowMode) {
    allowed.add("mode");
  }
  return allowed.has(value) ? value : defaultMethod;
}

/** 判断资产 ID 是否为 OPERA DSWX（水体产品），需要走专属渲染分支。 */
function isOperaDswx(assetId: string): boolean {
  return assetId === "OPERA/DSWX/L3_V1/HLS" || assetId === "OPERA/DSWX/L3_V1/S1";
}

/** 返回 OPERA DSWX 的默认合成方法：S1（雷达）用 max，HLS 用 mode。 */
function operaDswxDefaultCompositeMethod(assetId: string): string {
  return assetId === "OPERA/DSWX/L3_V1/S1" ? "max" : "mode";
}

/**
 * 把用户指定的波段名映射为 OPERA DSWX 的规范波段名：识别 WTR/B01_WTR
 * （水体分类）与 BWTR/BINARY_WATER（二值水体）等别名；未命中时原样返回，
 * 缺省为水体分类波段。
 */
function operaDswxBandAlias(value: unknown): string {
  const first = parseList(value)?.[0] ?? "WTR_Water_classification";
  const aliases: Record<string, string> = {
    WTR: "WTR_Water_classification",
    B01_WTR: "WTR_Water_classification",
    WTR_Water_classification: "WTR_Water_classification",
    BWTR: "BWTR_Binary_water",
    BINARY_WATER: "BWTR_Binary_water",
    BWTR_Binary_water: "BWTR_Binary_water",
  };
  return aliases[first] ?? first;
}

/**
 * 返回值的构造类型名（如 "ee.Image"、"ee.ImageCollection"），用于诊断
 * 输出；取不到构造名时退化为 typeof 描述。
 */
function objectTypeName(value: unknown): string {
  const ctorName = (value as { constructor?: { name?: string } } | null)?.constructor?.name;
  return ctorName || typeof value;
}

/** 把任意抛出的错误对象转成可读的消息字符串。 */
function eeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 格式化 ee.initialize 的错误：针对 "Cannot use 'in' operator ... Classifier"
 * 这一典型症状（API 算法注册表加载失败）给出排查指引——project 未开通
 * Earth Engine、OAuth client origin 不匹配或账号无权限；其余错误原样返回。
 */
function formatEeInitializeError(error: unknown): string {
  const message = eeErrorMessage(error);
  if (message.includes("Cannot use 'in' operator") && message.includes("Classifier")) {
    return [
      "Earth Engine initialization failed while loading the API algorithms registry.",
      "Verify that the configured Google Cloud project has Earth Engine enabled,",
      "the OAuth consent/client origin matches this page, and the signed-in account has Earth Engine access.",
      `Original error: ${message}`,
    ].join(" ");
  }
  return message;
}

/** 把任意值归一化为可选字符串：trim 后为空则返回 undefined。 */
function normalizeOptionalString(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text : undefined;
}

/** 归一化 token 有效期（秒）：非法或非正数时回退为 3600 秒。 */
function normalizeTokenExpiresIn(value: unknown): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
}

/**
 * Earth Engine 服务核心类：管理 ee 模块加载、鉴权、初始化、目录检索、
 * 图层构建与瓦片 URL 获取。所有 promise 型内部状态（eePromise/authPromise/
 * initializePromise）都做单例化，避免并发重复加载或重复弹窗。
 */
export class EarthEngineService {
  /** 单例化的 ee 模块动态加载 promise（null 表示尚未开始加载）。 */
  private eePromise: Promise<EeModule> | null = null;
  /** 进行中的 OAuth 鉴权 promise，避免并发触发多个弹窗。 */
  private authPromise: Promise<void> | null = null;
  /** 进行中的 initialize promise，并发调用共享同一结果。 */
  private initializePromise: Promise<{
    success: boolean;
    project_id?: string;
    authenticated: boolean;
  }> | null = null;
  /** ee.initialize 是否已成功完成。 */
  private initialized = false;
  /** 已初始化绑定的 project ID，用于判断配置变更后是否需要重新初始化。 */
  private initializedProjectId: string | undefined;
  /** tile URL 缓存：key 由 ee 对象序列化 + visParams 稳定序列化组成。 */
  private readonly tileUrlCache = new Map<string, string>();
  /** 已注册的图层表，key 为图层名。 */
  private readonly layers = new Map<string, EarthEngineLayerRecord>();

  constructor(private options: EarthEngineOptions = {}) {}

  updateOptions(options: EarthEngineOptions): void {
    // 记录鉴权相关的三项旧值（trim 归一后比较，避免空白差异误判）。
    const previousOauthClientId = normalizeOptionalString(this.options.oauthClientId);
    const previousProjectId = normalizeOptionalString(this.options.projectId);
    const previousAccessToken = normalizeOptionalString(this.options.accessToken);
    const nextOauthClientId = normalizeOptionalString(options.oauthClientId);
    const nextProjectId = normalizeOptionalString(options.projectId);
    const nextAccessToken = normalizeOptionalString(options.accessToken);
    this.options = { ...this.options, ...options };
    // 鉴权凭据/project 发生变化时，强制下次 initialize 重新走完整流程，
    // 并清空旧凭据生成的 tile URL 缓存。
    if (
      previousOauthClientId !== nextOauthClientId ||
      previousProjectId !== nextProjectId ||
      previousAccessToken !== nextAccessToken
    ) {
      this.initialized = false;
      this.initializedProjectId = undefined;
      this.tileUrlCache.clear();
    }
  }

  /** 是否启用 Earth Engine：仅当显式配置 enabled === false 时视为关闭。 */
  get enabled(): boolean {
    return this.options.enabled !== false;
  }

  /** 当前 ee.initialize 是否已完成。 */
  get initializedState(): boolean {
    return this.initialized;
  }

  /**
   * 列出全部已注册图层（导出给 LLM 的 payload 形状）：
   * 剥离内部 eeObject 引用，并对 vis_params / metadata 做浅拷贝，
   * 防止外部修改污染内部状态。
   */
  listLoadedLayers(): EarthEngineLayerRecord[] {
    return Array.from(this.layers.values()).map(({ eeObject: _eeObject, ...record }) => ({
      ...record,
      vis_params: { ...record.vis_params },
      metadata: record.metadata ? { ...record.metadata } : undefined,
    }));
  }

  /**
   * 按名称取图层记录：先精确匹配，再不区分大小写精确匹配，
   * 最后退化为子串匹配；命中多条（歧义）或零条时抛错。
   *
   * @param layerName - 图层名（可带多余空白、任意大小写）
   * @returns 匹配到的图层记录（含内部 eeObject）
   */
  getLayerPayload(layerName: string): EarthEngineLayerRecord {
    // 第一优先：Map 的 key 精确命中。
    const exact = this.layers.get(layerName);
    if (exact) {
      return exact;
    }
    const requested = layerName.trim().toLowerCase();
    // 第二优先：不区分大小写与首尾空白的精确匹配。
    let matches = Array.from(this.layers.values()).filter(
      (layer) => layer.name.trim().toLowerCase() === requested,
    );
    // 第三优先：子串模糊匹配。
    if (matches.length === 0) {
      matches = Array.from(this.layers.values()).filter((layer) =>
        layer.name.trim().toLowerCase().includes(requested),
      );
    }
    if (matches.length === 0) {
      throw new Error(`Earth Engine layer not found: ${layerName}`);
    }
    // 模糊匹配可能命中多条，歧义时报错并列出候选。
    if (matches.length > 1) {
      throw new Error(
        `Earth Engine layer name is ambiguous: ${layerName}. ${matches
          .map((layer) => layer.name)
          .join(", ")}`,
      );
    }
    return matches[0];
  }

  /** 注销图层：支持精确名或不区分大小写的匹配；找不到时静默忽略。 */
  unregisterLayer(name: string): void {
    const key = Array.from(this.layers.keys()).find(
      (candidate) =>
        candidate === name ||
        candidate.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    if (key) {
      this.layers.delete(key);
    }
  }

  /** 注册（或覆盖同名）图层记录。 */
  registerLayer(record: EarthEngineLayerRecord): EarthEngineLayerRecord {
    this.layers.set(record.name, record);
    return record;
  }

  /**
   * 动态加载 @google/earthengine 模块（单例 promise，并发调用共享）。
   * 兼容 default 导出与命名空间导出两种模块形状，并把 ee 挂到
   * globalThis（部分 GEE 脚本片段假定全局存在 ee）。
   */
  async loadEe(): Promise<EeModule> {
    if (!this.eePromise) {
      this.eePromise = import("@google/earthengine").then((module) => {
        // 包可能以 default 或命名空间形式导出，取实际含 API 的那个。
        const imported = "default" in module ? module.default : module;
        const ee = imported as EeModule;
        const scope = globalThis as typeof globalThis & { ee?: unknown };
        // 只在全局尚未定义 ee 时挂载，尊重宿主已有的注入。
        if (!scope.ee) {
          scope.ee = ee;
        }
        return ee;
      });
    }
    return this.eePromise;
  }

  /**
   * 初始化 Earth Engine（鉴权 + ee.initialize 绑定 project）。
   * 已用相同 project 初始化过则直接返回成功；并发调用共享同一 promise；
   * force=true 时强制重新初始化。
   *
   * @param input - 可覆盖 oauthClientId / projectId；force 跳过缓存判断
   * @returns 初始化结果（成功标志、project_id、是否已鉴权）
   */
  async initialize(input: {
    oauthClientId?: string;
    projectId?: string;
    force?: boolean;
  } = {}): Promise<{ success: boolean; project_id?: string; authenticated: boolean }> {
    const projectId = normalizeOptionalString(input.projectId ?? this.options.projectId);
    const oauthClientId = normalizeOptionalString(input.oauthClientId ?? this.options.oauthClientId);
    // 已初始化且 project 一致（都为空也算一致）时无需重复初始化。
    const projectMatches =
      this.initializedProjectId === projectId ||
      (!this.initializedProjectId && !projectId);
    if (this.initialized && projectMatches && !input.force) {
      return {
        success: true,
        project_id: projectId,
        authenticated: true,
      };
    }
    // 已有进行中的初始化且非强制：直接复用，避免并发重复初始化。
    if (this.initializePromise && !input.force) {
      return this.initializePromise;
    }
    const promise = this.initializeInternal({ oauthClientId, projectId });
    this.initializePromise = promise;
    try {
      return await promise;
    } finally {
      // 仅当当前 promise 仍是自己时才清空，防止 force 场景误清新的 promise。
      if (this.initializePromise === promise) {
        this.initializePromise = null;
      }
    }
  }

  private async initializeInternal(input: {
    oauthClientId?: string;
    projectId?: string;
  }): Promise<{ success: boolean; project_id?: string; authenticated: boolean }> {
    const ee = await this.loadEe();
    // 先保证拿到有效凭据（token 注入或 OAuth 交互），再初始化 API。
    await this.ensureAuthenticated(ee, input.oauthClientId);
    // ee.initialize 是回调式 API：包成 Promise，成功 resolve、失败 reject。
    await new Promise<void>((resolve, reject) => {
      if (!ee.initialize) {
        reject(new Error("Earth Engine initialize is unavailable."));
        return;
      }
      try {
        ee.initialize(
          // baseUrl/tileUrl 传 null 表示使用 GEE 默认端点。
          null,
          null,
          () => resolve(),
          (error: unknown) => reject(new Error(formatEeInitializeError(error))),
          null,
          // project 为空串时传 null，走未绑定 project 的默认行为。
          input.projectId || null,
        );
      } catch (error) {
        // initialize 同步抛错（如参数非法）也要转成 reject。
        reject(new Error(formatEeInitializeError(error)));
      }
    });
    // 初始化成功：记录状态与 project，并清空旧凭据下的 tile URL 缓存。
    this.initialized = true;
    this.initializedProjectId = input.projectId;
    this.tileUrlCache.clear();
    return { success: true, project_id: input.projectId, authenticated: true };
  }

  /**
   * 确保完成鉴权。优先级：
   * 1. 配置了 accessToken：直接注入 token（跳过 OAuth）；
   * 2. ee 已缓存 token 且 client 匹配（或无法判断）：复用现有 token；
   * 3. 否则走 OAuth 交互：先静默（authenticateViaOauth），失败转弹窗
   *    （authenticateViaPopup）；并发调用共享同一 authPromise。
   */
  private async ensureAuthenticated(
    ee: EeModule,
    oauthClientId?: string,
  ): Promise<void> {
    // 分支 1：预配置 access token 直接注入。
    const configuredAccessToken = normalizeOptionalString(this.options.accessToken);
    if (configuredAccessToken) {
      await this.applyAccessToken(ee, oauthClientId, configuredAccessToken);
      return;
    }

    // 分支 2：模块里已有 token——client 一致或未要求 client 时直接复用。
    const token = ee.data?.getAuthToken?.();
    const currentAuthClientId = normalizeOptionalString(ee.data?.getAuthClientId?.());
    if (token) {
      if (!oauthClientId || !currentAuthClientId || currentAuthClientId === oauthClientId) {
        return;
      }
      // token 是别的 client 签发的：清掉后重新走 OAuth。
      ee.data?.clearAuthToken?.();
    }
    // 分支 3：并发调用时共享同一个鉴权 promise，避免重复弹窗。
    if (this.authPromise) {
      return this.authPromise;
    }
    if (!oauthClientId) {
      throw new Error(
        "Earth Engine OAuth client ID is required. Pass earthEngine.oauthClientId or oauth_client_id.",
      );
    }
    this.authPromise = new Promise<void>((resolve, reject) => {
      const onSuccess = () => resolve();
      const onFailure = (error: unknown) => reject(new Error(eeErrorMessage(error)));
      // 静默鉴权失败（无已登录会话）时切换为弹窗鉴权。
      const onImmediateFailed = () => {
        if (!ee.data?.authenticateViaPopup) {
          reject(new Error("Earth Engine popup authentication is unavailable."));
          return;
        }
        ee.data.authenticateViaPopup(onSuccess, onFailure);
      };
      if (!ee.data?.authenticateViaOauth) {
        reject(new Error("Earth Engine OAuth authentication is unavailable."));
        return;
      }
      ee.data.authenticateViaOauth(
        oauthClientId,
        onSuccess,
        onFailure,
        undefined,
        onImmediateFailed,
      );
    }).finally(() => {
      // 结束后清空，保证失败后可重试（重新触发弹窗）。
      this.authPromise = null;
    });
    return this.authPromise;
  }

  /**
   * 注入预配置的 access token（ee.data.setAuthToken）。
   *
   * @param ee - ee 模块
   * @param oauthClientId - 可选的 client ID；缺省传空串
   * @param accessToken - 外部签发的 access token
   */
  private async applyAccessToken(
    ee: EeModule,
    oauthClientId: string | undefined,
    accessToken: string,
  ): Promise<void> {
    if (!ee.data?.setAuthToken) {
      throw new Error("Earth Engine token authentication is unavailable.");
    }
    const clientId = oauthClientId ?? "";
    const tokenType = normalizeOptionalString(this.options.tokenType) ?? "Bearer";
    const expiresIn = normalizeTokenExpiresIn(this.options.tokenExpiresIn);
    // setAuthToken 回调式：包成 Promise；updateAuthLibrary=false 不联动 gapi。
    await new Promise<void>((resolve, reject) => {
      try {
        ee.data?.setAuthToken?.(
          clientId,
          tokenType,
          accessToken,
          expiresIn,
          [],
          resolve,
          false,
        );
      } catch (error) {
        reject(new Error(eeErrorMessage(error)));
      }
    });
  }

  /**
   * 获取 dataset 目录（官方 + 可选社区），带进程内缓存。
   * 缓存未过期直接返回；刷新失败时回退到上一轮（stale）数据。
   *
   * @param includeCommunity - 是否包含社区目录，默认取 options 配置（再默认 true）
   * @returns dataset 列表；完全失败且无 stale 缓存时抛出原始错误
   */
  async catalog(includeCommunity = this.options.includeCommunityCatalog ?? true): Promise<GeeDataset[]> {
    // 两个 key 分开缓存：all（官方+社区）与 official（仅官方）。
    const key = includeCommunity ? "all" : "official";
    const ttl = this.options.catalogCacheTtlMs ?? DEFAULT_CATALOG_CACHE_TTL_MS;
    const cached = CATALOG_CACHE.get(key);
    const now = Date.now();
    // 命中未过期缓存：直接返回，避免重复拉取远端目录。
    if (cached && now - cached.createdAt <= ttl) {
      return cached.datasets;
    }
    try {
      // 官方目录：JSON 优先，失败退 TSV。
      const official = await fetchCatalogWithFallback<GeeDataset[]>(
        OFFICIAL_CATALOG_JSON_URL,
        (text) => parseOfficialGeeCatalog(text, "json"),
        OFFICIAL_CATALOG_TSV_URL,
        (text) => parseOfficialGeeCatalog(text, "tsv"),
      );
      // 社区目录：仅在允许时拉取，JSON 优先，失败退 CSV。
      const community = includeCommunity
        ? await fetchCatalogWithFallback<GeeDataset[]>(
            COMMUNITY_CATALOG_JSON_URL,
            (text) => parseCommunityGeeCatalog(text, "json"),
            COMMUNITY_CATALOG_CSV_URL,
            (text) => parseCommunityGeeCatalog(text, "csv"),
          )
        : [];
      const datasets = [...official, ...community];
      CATALOG_CACHE.set(key, {
        createdAt: now,
        datasets,
        // 记住本轮数据作为下一轮刷新失败时的 stale 兜底。
        staleDatasets: cached?.datasets ?? cached?.staleDatasets,
      });
      return datasets;
    } catch (error) {
      // 刷新失败：若有上一轮数据则降级返回 stale，保证功能可用。
      const stale = cached?.datasets ?? cached?.staleDatasets;
      if (stale) {
        return stale;
      }
      throw error;
    }
  }

  /**
   * 按 query/category/data_type/source 过滤并排序检索 dataset 目录。
   * 排序规则：相关度得分降序 > 官方来源优先 > 名称字典序。
   *
   * @param input - 检索条件；query 关键词按空格分词加权评分
   * @returns 命中总数（count）、实际返回数（shown）与压缩后的 dataset 列表
   */
  async searchDatasets(input: {
    query?: string;
    category?: string;
    data_type?: string;
    source?: string;
    max_results?: number;
    include_community?: boolean;
  }): Promise<{ count: number; shown: number; datasets: GeeDataset[] }> {
    const datasets = await this.catalog(input.include_community ?? true);
    const query = (input.query ?? "").trim().toLowerCase();
    // max_results 至少为 1，未提供默认 20。
    const maxResults = Math.max(1, Number(input.max_results ?? 20));
    const results = datasets
      .filter((dataset) => {
        // 结构化过滤条件：category 精确匹配、source 精确匹配、
        // data_type 归一化后比较。
        if (input.category && dataset.category !== input.category) {
          return false;
        }
        if (input.source && dataset.source !== input.source) {
          return false;
        }
        if (
          input.data_type &&
          normalizeGeeAssetType(dataset.type) !== normalizeGeeAssetType(input.data_type)
        ) {
          return false;
        }
        return true;
      })
      .map((dataset) => ({ dataset, score: datasetSearchScore(dataset, query) }))
      // 有 query 时只保留得分大于 0 的条目；无 query 时全部保留。
      .filter((item) => !query || item.score > 0)
      .sort((a, b) => {
        // 先按相关度得分降序。
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        // 得分相同：官方来源排在社区来源前面。
        if (a.dataset.source !== b.dataset.source) {
          return a.dataset.source === "official" ? -1 : 1;
        }
        // 再按名称字典序保证结果稳定。
        return String(a.dataset.name ?? a.dataset.id).localeCompare(
          String(b.dataset.name ?? b.dataset.id),
        );
      })
      .map((item) => item.dataset);
    return {
      count: results.length,
      shown: Math.min(results.length, maxResults),
      // 返回前压缩每个条目，控制 token 体积。
      datasets: results.slice(0, maxResults).map(compactGeeDataset),
    };
  }

  /**
   * 按资产 ID 查询目录中的 dataset 详情。
   *
   * @param assetId - 资产 ID
   * @param includeCommunity - 是否搜索社区目录
   * @returns dataset 信息；目录中不存在时 found=false 并回填 asset_id
   */
  async getDatasetInfo(
    assetId: string,
    includeCommunity = true,
  ): Promise<GeeDataset & { found: boolean; asset_id?: string }> {
    const datasets = await this.catalog(includeCommunity);
    const found = datasets.find((dataset) => dataset.id === assetId);
    if (!found) {
      // 目录中未收录：仍返回可用的最小形状，found 标记为 false。
      return { asset_id: assetId, id: assetId, found: false };
    }
    return { ...compactGeeDataset(found), found: true };
  }

  /**
   * 汇总目录：返回 dataset 总数与按分类的计数分布（按分类名字典序）。
   */
  async summarizeCatalog(
    includeCommunity = true,
  ): Promise<{ total_count: number; categories: Array<{ category: string; count: number }> }> {
    const datasets = await this.catalog(includeCommunity);
    const counts = new Map<string, number>();
    // 逐条累计分类计数；缺失分类的归入 "Other"。
    for (const dataset of datasets) {
      const category = dataset.category || "Other";
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return {
      total_count: datasets.length,
      categories: Array.from(counts.entries())
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => a.category.localeCompare(b.category)),
    };
  }

  /**
   * 探测资产类型，逐级回退：
   * 1. 调用方显式指定且可归一化 -> 直接采用；
   * 2. 查目录元数据 -> 采用目录记录的类型；
   * 3. 调 ee.data.getAsset（API 元数据）-> 采用 API 返回的类型；
   * 4. 全部失败 -> 默认按 "Image" 处理。
   */
  async detectAssetType(assetId: string, explicitType?: unknown): Promise<GeeAssetType> {
    const normalized = normalizeGeeAssetType(explicitType);
    if (normalized !== "Unknown") {
      return normalized;
    }
    try {
      // 回退第 2 级：目录中收录的类型。
      const dataset = await this.getDatasetInfo(assetId, this.options.includeCommunityCatalog ?? true);
      const catalogType = normalizeGeeAssetType(dataset.type);
      if (catalogType !== "Unknown") {
        return catalogType;
      }
    } catch {
      // 目录查询失败，继续走 API 探测。
    }
    try {
      // 回退第 3 级：ee.data.getAsset 直接询问 GEE API。
      const ee = await this.loadEe();
      if (ee.data?.getAsset) {
        const asset = await new Promise<Record<string, unknown>>((resolve, reject) => {
          ee.data!.getAsset!(
            assetId,
            (value) => resolve(value),
            (error) => reject(new Error(eeErrorMessage(error))),
          );
        });
        const apiType = normalizeGeeAssetType(asset.type);
        if (apiType !== "Unknown") {
          return apiType;
        }
      }
    } catch {
      // API 探测失败，落到底部默认值。
    }
    return "Image";
  }

  /**
   * 把一个 dataset 资产构建成可渲染的 ee 图层对象（供 getTileUrl 使用）。
   * 按 detected 资产类型走不同分支：
   * - ImageCollection：日期过滤、空间过滤、云量过滤、合成（mosaic/median/...
   *   或 OPERA DSWX 专属渲染）；
   * - FeatureCollection：单色可视化；
   * - Image：波段 + 拉伸 + 调色板可视化。
   * 返回值同时携带 bounds/clip 的诊断信息。
   */
  async buildDatasetLayer(input: Record<string, unknown>): Promise<{
    asset_id: string;
    asset_type: GeeAssetType;
    layer_name: string;
    eeObject: EeObject;
    vis_params: Record<string, unknown>;
    composite_method?: string;
    requested_reducer?: string;
    rendered_band?: string;
    diagnostics: Record<string, unknown>;
    bbox?: number[];
    bounds?: Record<string, unknown> | null;
    clip?: Record<string, unknown> | null;
  }> {
    // 构图前必须完成鉴权与初始化（允许本次调用覆盖凭据配置）。
    await this.initialize({
      oauthClientId: String(input.oauth_client_id ?? this.options.oauthClientId ?? ""),
      projectId: String(input.project_id ?? this.options.projectId ?? ""),
    });
    const ee = await this.loadEe();
    const assetId = String(input.asset_id ?? "").trim();
    if (!assetId) {
      throw new Error("load_gee_dataset requires asset_id.");
    }
    const assetType = await this.detectAssetType(assetId, input.asset_type);
    // 图层名缺省取资产 ID 的最后一段（如 "S2_SR_HARMONIZED"），并截断到 50 字符。
    const layerName = String(input.layer_name ?? assetId.split("/").at(-1) ?? assetId).slice(0, 50);
    const bbox = parseBbox(input.bbox);
    // 空间过滤集合（filterBounds 用）与裁剪集合（clipToCollection 用）。
    const boundsCollection = buildFilteredFeatureCollection(ee, {
      assetId: input.bounds_collection_asset_id,
      property: input.bounds_filter_property,
      value: input.bounds_filter_value,
    });
    const clipCollection = buildFilteredFeatureCollection(ee, {
      assetId: input.clip_collection_asset_id,
      property: input.clip_filter_property,
      value: input.clip_filter_value,
    });
    const diagnostics: Record<string, unknown> = {};
    let eeObject: EeObject;
    let visParams: Record<string, unknown>;
    let method: string | undefined;
    let renderedBand: string | undefined;
    if (assetType === "ImageCollection") {
      let collection = new ee.ImageCollection(assetId);
      // 按时间范围过滤（任一端提供即生效）。
      if (input.start_date || input.end_date) {
        collection = callEeMethod(collection, "filterDate", input.start_date, input.end_date);
      }
      // 空间过滤：优先用指定的过滤集合，否则退化为 bbox 矩形。
      if (boundsCollection) {
        collection = callEeMethod(collection, "filterBounds", boundsCollection);
      } else if (bbox) {
        collection = callEeMethod(collection, "filterBounds", ee.Geometry.Rectangle(bbox));
      }
      if (isOperaDswx(assetId)) {
        // OPERA DSWX 特例：合成方法只允许 max/mode，波段走别名映射，
        // 渲染逻辑（掩膜、remap、调色板）由 renderOperaDswx 专责处理。
        method = normalizeCompositeMethod(
          input.reducer,
          operaDswxDefaultCompositeMethod(assetId),
          true,
        );
        if (method !== "max" && method !== "mode") {
          method = operaDswxDefaultCompositeMethod(assetId);
        }
        renderedBand = operaDswxBandAlias(input.bands);
        const rendered = renderOperaDswx(ee, collection, renderedBand, method);
        eeObject = rendered.eeObject;
        visParams = rendered.visParams;
      } else {
        // 通用影像集合：按云量属性过滤（默认 CLOUDY_PIXEL_PERCENTAGE）。
        if (input.cloud_cover != null) {
          collection = callEeMethod(
            collection,
            "filter",
            ee.Filter.lt(
              String(input.cloud_property ?? "CLOUDY_PIXEL_PERCENTAGE"),
              Number(input.cloud_cover),
            ),
          );
        }
        // 合成为单幅影像，再套可视化参数。
        method = normalizeCompositeMethod(input.reducer, "mosaic", true);
        eeObject = compositeImageCollection(ee, collection, method);
        visParams = buildGeeVisParams({
          bands: input.bands,
          min_value: input.min_value,
          max_value: input.max_value,
          palette: input.palette,
        });
      }
      if (input.diagnose) {
        diagnostics.bbox = bbox;
      }
    } else if (assetType === "FeatureCollection") {
      // 要素集合：只支持单色填充，无波段/拉伸概念。
      eeObject = new ee.FeatureCollection(assetId);
      visParams = buildGeeVisParams({
        palette: input.palette,
        forFeatureCollection: true,
      });
    } else {
      // 单幅 Image：波段 + 拉伸 + 调色板。
      eeObject = new ee.Image(assetId);
      visParams = buildGeeVisParams({
        bands: input.bands,
        min_value: input.min_value,
        max_value: input.max_value,
        palette: input.palette,
      });
    }
    // 裁剪仅对影像类对象有意义；FeatureCollection 不做 clipToCollection。
    if (clipCollection && assetType !== "FeatureCollection") {
      eeObject = callEeMethod(new ee.Image(eeObject), "clipToCollection", clipCollection);
    }
    return {
      asset_id: assetId,
      asset_type: assetType,
      layer_name: layerName,
      eeObject,
      vis_params: visParams,
      composite_method: method,
      requested_reducer: assetType === "ImageCollection" ? String(input.reducer ?? "mosaic") : undefined,
      rendered_band: renderedBand,
      diagnostics,
      bbox,
      // bounds/clip 诊断块：记录实际生效的集合、过滤属性与值。
      bounds: boundsCollection
        ? {
            collection_asset_id: input.bounds_collection_asset_id,
            filter_property: input.bounds_filter_property,
            filter_value:
              input.bounds_filter_value == null
                ? null
                : coerceFilterValue(input.bounds_filter_value),
            method: "ImageCollection.filterBounds",
          }
        : null,
      clip: clipCollection
        ? {
            collection_asset_id: input.clip_collection_asset_id,
            filter_property: input.clip_filter_property,
            filter_value: input.clip_filter_value,
            method: "ee.Image.clipToCollection",
          }
        : null,
    };
  }

  /**
   * 构建 NDVI 等归一化差值指数图层：((A - B) / (A + B))，其中 A/B 分别为
   * positive_band 与 negative_band。ImageCollection 会先按日期/空间/云量
   * 过滤并合成，再对合成影像求指数；FeatureCollection 不支持，直接报错。
   */
  async buildNormalizedDifferenceLayer(input: Record<string, unknown>): Promise<{
    asset_id: string;
    asset_type: GeeAssetType;
    layer_name: string;
    eeObject: EeObject;
    vis_params: Record<string, unknown>;
    index_name: string;
    formula: string;
    bands: string[];
    composite_method?: string;
    requested_reducer?: string;
    bbox?: number[];
    bounds?: Record<string, unknown> | null;
    clip?: Record<string, unknown> | null;
  }> {
    // 同 buildDatasetLayer：构图前完成鉴权与初始化。
    await this.initialize({
      oauthClientId: String(input.oauth_client_id ?? this.options.oauthClientId ?? ""),
      projectId: String(input.project_id ?? this.options.projectId ?? ""),
    });
    const ee = await this.loadEe();
    const assetId = String(input.asset_id ?? "").trim();
    const positiveBand = String(input.positive_band ?? "").trim();
    const negativeBand = String(input.negative_band ?? "").trim();
    // 三个必填参数缺一不可（如 NDVI 需要 NIR 与 Red 波段）。
    if (!assetId || !positiveBand || !negativeBand) {
      throw new Error(
        "calculate_gee_normalized_difference requires asset_id, positive_band, and negative_band.",
      );
    }
    const detectedType = await this.detectAssetType(assetId, input.asset_type);
    if (detectedType === "FeatureCollection") {
      throw new Error("Normalized difference indexes require an Image or ImageCollection.");
    }
    const bbox = parseBbox(input.bbox);
    const boundsCollection = buildFilteredFeatureCollection(ee, {
      assetId: input.bounds_collection_asset_id,
      property: input.bounds_filter_property,
      value: input.bounds_filter_value,
    });
    const clipCollection = buildFilteredFeatureCollection(ee, {
      assetId: input.clip_collection_asset_id,
      property: input.clip_filter_property,
      value: input.clip_filter_value,
    });
    let sourceImage: EeObject;
    let method: string | undefined;
    let assetType = detectedType;
    if (detectedType === "ImageCollection") {
      let collection = new ee.ImageCollection(assetId);
      // 与 buildDatasetLayer 相同的过滤链：日期 -> 空间 -> 云量。
      if (input.start_date || input.end_date) {
        collection = callEeMethod(collection, "filterDate", input.start_date, input.end_date);
      }
      if (boundsCollection) {
        collection = callEeMethod(collection, "filterBounds", boundsCollection);
      } else if (bbox) {
        collection = callEeMethod(collection, "filterBounds", ee.Geometry.Rectangle(bbox));
      }
      if (input.cloud_cover != null) {
        collection = callEeMethod(
          collection,
          "filter",
          ee.Filter.lt(
            String(input.cloud_property ?? "CLOUDY_PIXEL_PERCENTAGE"),
            Number(input.cloud_cover),
          ),
        );
      }
      // 指数计算需要单幅影像：默认 median 合成（比 mosaic 更抗云噪声）。
      method = normalizeCompositeMethod(input.reducer, "median");
      sourceImage = compositeImageCollection(ee, collection, method);
    } else {
      // 其余类型一律按单幅 Image 处理。
      assetType = "Image";
      sourceImage = new ee.Image(assetId);
    }
    // 指数名缺省 NDVI；显式传空串时退化为通用名 "ND"。
    const indexName = String(input.index_name ?? "NDVI").trim() || "ND";
    // normalizedDifference(A, B) = (A - B) / (A + B)，随后重命名为指数名。
    let indexImage = callEeMethod(
      sourceImage,
      "normalizedDifference",
      [positiveBand, negativeBand],
    );
    indexImage = callEeMethod(indexImage, "rename", indexName);
    if (clipCollection) {
      indexImage = callEeMethod(new ee.Image(indexImage), "clipToCollection", clipCollection);
    }
    // 默认值域 [-1, 1]，调色板按指数类型选默认配色。
    const visParams = buildGeeVisParams({
      bands: indexName,
      min_value: input.min_value ?? -1,
      max_value: input.max_value ?? 1,
      palette: input.palette ?? defaultIndexPalette(indexName),
    });
    // 图层名缺省形如 "S2_SR_HARMONIZED NDVI"。
    const layerName = String(
      input.layer_name ?? `${assetId.split("/").at(-1) ?? assetId} ${indexName}`,
    ).slice(0, 50);
    return {
      asset_id: assetId,
      asset_type: assetType,
      layer_name: layerName,
      eeObject: indexImage,
      vis_params: visParams,
      index_name: indexName,
      // 回显人类可读的公式，便于 LLM/用户核对。
      formula: `(${positiveBand} - ${negativeBand}) / (${positiveBand} + ${negativeBand})`,
      bands: [positiveBand, negativeBand],
      composite_method: method,
      requested_reducer: detectedType === "ImageCollection" ? String(input.reducer ?? "median") : undefined,
      bbox,
      bounds: boundsCollection
        ? {
            collection_asset_id: input.bounds_collection_asset_id,
            filter_property: input.bounds_filter_property,
            filter_value:
              input.bounds_filter_value == null
                ? null
                : coerceFilterValue(input.bounds_filter_value),
            method: "ImageCollection.filterBounds",
          }
        : null,
      clip: clipCollection
        ? {
            collection_asset_id: input.clip_collection_asset_id,
            filter_property: input.clip_filter_property,
            filter_value: input.clip_filter_value,
            method: "ee.Image.clipToCollection",
          }
        : null,
    };
  }

  /**
   * 获取 ee 对象的地图瓦片 URL（getMap/getMapId），带缓存。
   * FeatureCollection 等样式型对象会先经 renderableEeObjectForTiles 转换。
   * getMap 同时支持回调与同步返回值两种形态，用 settled 标记防止双重结算。
   */
  async getTileUrl(eeObject: EeObject, visParams: Record<string, unknown>): Promise<string> {
    // 样式参数（color/width 等）需要走 eeObject.style() 转换。
    const renderable = renderableEeObjectForTiles(eeObject, visParams);
    const cacheKey = this.tileCacheKey(renderable.eeObject, renderable.visParams);
    // 序列化成功且缓存命中：直接复用同一瓦片源。
    const cached = cacheKey ? this.tileUrlCache.get(cacheKey) : undefined;
    if (cached) {
      return cached;
    }
    const tileUrl = await new Promise<string>((resolve, reject) => {
      // getMap 可能回调两次或回调+返回值都存在，用 settled 保证只结算一次。
      let settled = false;
      const finish = (mapInfo: Record<string, unknown> | undefined, error?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(new Error(`Earth Engine getMapId failed: ${eeErrorMessage(error)}`));
          return;
        }
        const url = extractTileUrl(mapInfo);
        if (url) {
          resolve(url);
        } else {
          reject(new Error("Earth Engine did not return a tile URL."));
        }
      };
      try {
        const callback = (
          mapInfo: Record<string, unknown> | undefined,
          error?: unknown,
        ) => finish(mapInfo, error);
        // 优先 getMap；旧版本 API 只有 getMapId。同步返回值也直接结算。
        const result =
          typeof renderable.eeObject.getMap === "function"
            ? renderable.eeObject.getMap(renderable.visParams, callback)
            : renderable.eeObject.getMapId?.(renderable.visParams, callback);
        if (result) {
          finish(result);
        }
      } catch (error) {
        reject(error);
      }
    });
    // 拿到 URL 后写缓存；序列化失败的对象不缓存（cacheKey 为 null）。
    if (cacheKey) {
      this.tileUrlCache.set(cacheKey, tileUrl);
    }
    return tileUrl;
  }

  /**
   * 为已注册图层调整可视化参数并重新生成 tile URL：
   * 新参数与旧参数合并（新值优先），可指定输出图层名（默认覆盖原名）。
   *
   * @param input - layer_name + bands/min_value/max_value/palette + output_layer_name
   * @returns 新图层记录（含新的 tile_url）
   */
  async setLayerVisualization(input: Record<string, unknown>): Promise<{
    success: boolean;
    layer_name: string;
    source_layer_name: string;
    eeObject: unknown;
    vis_params: Record<string, unknown>;
    tile_url: string;
  }> {
    // 按名称（支持模糊匹配）找到源图层。
    const matched = this.getLayerPayload(String(input.layer_name ?? ""));
    const requestedVis = buildGeeVisParams({
      bands: input.bands,
      min_value: input.min_value,
      max_value: input.max_value,
      palette: input.palette,
    });
    // 新参数覆盖同名旧键，未指定的键沿用原参数。
    const visParams = { ...matched.vis_params, ...requestedVis };
    const outputName = String(input.output_layer_name ?? matched.name).slice(0, 50);
    const eeObject = matched.eeObject as EeObject;
    // 用合并后的参数重新申请瓦片 URL。
    const tileUrl = await this.getTileUrl(eeObject, visParams);
    // 以输出名注册为新图层（不删除源图层，名字相同则覆盖）。
    this.registerLayer({
      ...matched,
      name: outputName,
      vis_params: visParams,
      tile_url: tileUrl,
      eeObject,
    });
    return {
      success: true,
      layer_name: outputName,
      source_layer_name: matched.name,
      eeObject,
      vis_params: visParams,
      tile_url: tileUrl,
    };
  }

  /**
   * 受控执行 LLM 生成的 GEE JavaScript 片段。
   * 执行方式：new Function 注入脱敏的 ee 门面（屏蔽 ee.data 鉴权命名空间）
   * 与受限的 Map / addLayer / getEeLayer / listEeLayers 形参，代码包在
   * async IIFE 中执行；Map.addLayer 的三个别名都归一到同一个 addEeLayer
   * 包装，负责记录新增图层。
   *
   * 注意：new Function 并非安全沙箱——片段仍可访问 document、fetch、
   * sessionStorage 等页面全局。真正的边界是宿主的代码执行权限开关；
   * 仅应在可信环境开启该工具。
   *
   * @param code - GEE JavaScript 代码片段
   * @param addLayer - 宿主提供的图层注册回调（实际把 tile URL 加到地图）
   * @returns 执行结果：success、layers_added、result 与回显的原始片段
   */
  async runSnippet(
    code: string,
    addLayer: (
      eeObject: unknown,
      visParams: Record<string, unknown>,
      name: string,
    ) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    // 空代码直接失败返回，不触发初始化。
    if (!code.trim()) {
      return {
        success: false,
        error: "No Earth Engine JavaScript snippet was provided.",
        earth_engine_javascript_snippet: code,
      };
    }
    await this.initialize();
    const ee = await this.loadEe();
    // 记录片段执行期间新增的图层（用于判定是否成功添加了图层）。
    const layersAdded: Array<Record<string, unknown>> = [];
    const addEeLayer = async (
      eeObject: unknown,
      visParams: Record<string, unknown> = {},
      name = "Earth Engine Layer",
    ) => {
      const layerName = String(name || "Earth Engine Layer").slice(0, 50);
      // 先交给宿主注册到地图，再记录进 layersAdded 清单。
      await addLayer(eeObject, visParams, layerName);
      layersAdded.push({
        name: layerName,
        vis_params: visParams,
        object_type: objectTypeName(eeObject),
      });
    };
    // Map.addLayer / Map.add_layer / Map.add_ee_layer 三种写法等价。
    const mapAdapter = Object.freeze({
      addLayer: addEeLayer,
      add_layer: addEeLayer,
      add_ee_layer: addEeLayer,
    });
    // 把用户代码包进 strict 模式的 async IIFE，通过形参暴露受限 API。
    // 注意：new Function 并非安全沙箱（片段仍可访问 document/fetch 等），
    // 这里只做"脱敏门面"——屏蔽 ee.data 鉴权命名空间，防止片段经
    // ee.data.getAuthToken() 读出 access token 后外传。
    const eeFacade = new Proxy(ee, {
      get(target, prop) {
        if (prop === 'data') {
          throw new Error(
            'ee.data (the authentication namespace) is not available inside snippets.',
          );
        }
        return Reflect.get(target, prop);
      },
    });
    const fn = new Function(
      "ee",
      "Map",
      "addLayer",
      "getEeLayer",
      "listEeLayers",
      `"use strict"; return (async () => {\n${code}\n})()`,
    ) as (
      eeArg: EeModule,
      mapArg: typeof mapAdapter,
      addLayerArg: typeof addEeLayer,
      getEeLayerArg: (name: string) => unknown,
      listEeLayersArg: () => EarthEngineLayerRecord[],
    ) => Promise<unknown>;
    let result: unknown;
    try {
      result = await fn(
        eeFacade,
        mapAdapter,
        addEeLayer,
        // getEeLayer：按名取已注册图层的 ee 对象，供片段间复用。
        (name: string) => this.getLayerPayload(name).eeObject,
        () => this.listLoadedLayers(),
      );
    } catch (error) {
      // 片段抛错（含访问被屏蔽的 ee.data）返回结构化失败而非向上抛异常，
      // 与"没加任何图层"的失败路径保持同一返回契约。
      return {
        success: false,
        error: `The generated Earth Engine JavaScript snippet threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
        layers_added: [],
        earth_engine_javascript_snippet: code,
      };
    }
    // 执行成功但没加任何图层：视为失败并提示调用 Map.addLayer。
    if (layersAdded.length === 0) {
      return {
        success: false,
        error:
          "The generated Earth Engine JavaScript snippet ran but did not add a layer. Call Map.addLayer(...) or addLayer(...).",
        layers_added: [],
        result,
        earth_engine_javascript_snippet: code,
      };
    }
    return {
      success: true,
      layers_added: layersAdded,
      result,
      earth_engine_javascript_snippet: code,
    };
  }

  /**
   * 对已注册图层做区域统计（ee.Image.reduceRegion）：
   * 可指定波段、统计类型（mean/min/max/median/stdDev/sum/count）、
   * 统计区域（region_collection_asset_id 过滤后的要素集合，缺省用影像
   * 自身几何）、scale/maxPixels/tileScale，并带超时保护。
   *
   * @param input - 统计参数（layer_name 必填，其余可选）
   * @returns 统计结果对象：values、statistics、区域与计算参数回显
   */
  async calculateLayerStatistics(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.initialize();
    const ee = await this.loadEe();
    const layerName = String(input.layer_name ?? "");
    const source = this.getLayerPayload(layerName);
    // 统一转成 ee.Image（图层可能来自 FeatureCollection 或影像对象）。
    let image = new ee.Image(source.eeObject);
    const band = input.band == null ? "" : String(input.band).trim();
    if (band) {
      // 指定波段则只对该波段统计。
      image = callEeMethod(image, "select", band);
    }
    // 缺省区域：影像自身几何；提供区域集合时先过滤再用其几何。
    let region: unknown = callEeMethod(image, "geometry");
    let regionInfo: Record<string, unknown> | null = null;
    if (input.region_collection_asset_id) {
      let fc = new ee.FeatureCollection(String(input.region_collection_asset_id));
      if (input.region_filter_property && input.region_filter_value != null) {
        // 按属性等值过滤出目标区域要素。
        fc = callEeMethod(
          fc,
          "filter",
          ee.Filter.eq(
            String(input.region_filter_property),
            coerceFilterValue(input.region_filter_value),
          ),
        );
      }
      region = callEeMethod(fc, "geometry");
      regionInfo = {
        collection_asset_id: input.region_collection_asset_id,
        filter_property: input.region_filter_property,
        filter_value: input.region_filter_value,
      };
    }
    // 组合多个统计量为一个复合 reducer。
    const { reducer, statistics } = buildStatisticsReducer(ee, input.statistics);
    const reduction = callEeMethod(image, "reduceRegion", {
      reducer,
      geometry: region,
      scale: Number(input.scale ?? 1000),
      maxPixels: Number(input.max_pixels ?? 100000000),
      // bestEffort 默认开启：区域过大时自动降采样，避免计算爆炸。
      bestEffort: input.best_effort !== false,
      // tileScale 提高可缓解 "too many pixels in aggregate" 类错误。
      tileScale: Number(input.tile_scale ?? 4),
    });
    const timeoutSeconds = Number(input.timeout_seconds ?? 60);
    // 服务端求值带超时保护，默认 60 秒。
    const values = await withEeTimeout(
      evaluateEeObject(reduction),
      timeoutSeconds,
      `Earth Engine statistics evaluation timed out after ${timeoutSeconds}s`,
    );
    // 结果统一包装为对象：非对象结果包成 { value: ... }。
    const valueObject =
      values && typeof values === "object" && !Array.isArray(values)
        ? (values as Record<string, unknown>)
        : { value: values };
    const numericValues = Object.values(valueObject).filter(
      (value): value is number => typeof value === "number",
    );
    return {
      success: true,
      layer_name: layerName,
      band: band || null,
      statistics,
      values: valueObject,
      // 仅当请求单一 mean 时额外提供 mean 快捷字段。
      mean: statistics.length === 1 && statistics[0] === "mean" ? numericValues[0] ?? null : null,
      scale: Number(input.scale ?? 1000),
      max_pixels: Number(input.max_pixels ?? 100000000),
      best_effort: input.best_effort !== false,
      tile_scale: Number(input.tile_scale ?? 4),
      timeout_seconds: timeoutSeconds,
      region: regionInfo,
      approximate: input.best_effort !== false,
    };
  }

  /**
   * 生成 tile URL 缓存 key：ee 对象序列化 + visParams 的键排序稳定序列化。
   * 任一环节失败返回 null（表示该对象不参与缓存）。
   */
  private tileCacheKey(eeObject: EeObject, visParams: Record<string, unknown>): string | null {
    try {
      const serialized =
        typeof eeObject.serialize === "function"
          ? eeObject.serialize()
          : JSON.stringify(eeObject);
      return JSON.stringify([serialized, stableJson(visParams)]);
    } catch {
      return null;
    }
  }
}

/**
 * 带兜底的目录拉取：先请求主源并用主解析器解析；失败（网络或解析错误）
 * 时退回兜底源。主源/兜底源通常是同一目录的 JSON 与 TSV/CSV 两种格式。
 */
async function fetchCatalogWithFallback<T>(
  primaryUrl: string,
  primaryParser: (text: string) => T,
  fallbackUrl: string,
  fallbackParser: (text: string) => T,
): Promise<T> {
  try {
    // 主源：拉取并解析；任何一步失败都进入兜底分支。
    return primaryParser(await fetchText(primaryUrl));
  } catch {
    // 兜底源：JSON 源不可用时换 TSV/CSV 源。
    return fallbackParser(await fetchText(fallbackUrl));
  }
}

/** 拉取远端文本；HTTP 状态非 2xx 时抛错并带上状态码与 URL。 */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch Earth Engine catalog (${response.status}) from ${url}`);
  }
  return response.text();
}

/**
 * 计算 dataset 与查询词的相关度得分（无 query 时返回 1 表示全部保留）。
 * 加权规则：id/title 完全相等 +100；id 命中 +20、title 命中 +15、
 * keywords 命中 +8、description 命中 +3；多个分词累加。
 */
function datasetSearchScore(dataset: GeeDataset, query: string): number {
  if (!query) {
    return 1;
  }
  const id = dataset.id.toLowerCase();
  const title = String(dataset.title ?? dataset.name ?? "").toLowerCase();
  const description = String(dataset.description ?? "").toLowerCase();
  const keywords = (dataset.keywords ?? []).join(" ").toLowerCase();
  let score = 0;
  // 按空格分词逐个加权累加。
  for (const term of query.split(/\s+/).filter(Boolean)) {
    if (id === term || title === term) {
      score += 100;
    }
    if (id.includes(term)) {
      score += 20;
    }
    if (title.includes(term)) {
      score += 15;
    }
    if (keywords.includes(term)) {
      score += 8;
    }
    if (description.includes(term)) {
      score += 3;
    }
  }
  return score;
}

/**
 * 安全调用 ee 对象上的方法：方法不存在（不同 API 版本/对象类型）时抛出
 * 明确错误，而不是报 "not a function"。
 */
function callEeMethod(object: EeObject, method: string, ...args: unknown[]): EeObject {
  const fn = object[method];
  if (typeof fn !== "function") {
    throw new Error(`Earth Engine object does not support ${method}.`);
  }
  return (fn as (...methodArgs: unknown[]) => EeObject).apply(object, args);
}

/**
 * 构建可选的空间过滤/裁剪用 FeatureCollection：未提供资产 ID 时返回 null；
 * 提供了 property+value 时按属性等值过滤。
 */
function buildFilteredFeatureCollection(
  ee: EeModule,
  input: { assetId?: unknown; property?: unknown; value?: unknown },
): EeObject | null {
  if (!input.assetId) {
    return null;
  }
  let collection = new ee.FeatureCollection(String(input.assetId));
  if (input.property && input.value != null) {
    collection = callEeMethod(
      collection,
      "filter",
      ee.Filter.eq(String(input.property), coerceFilterValue(input.value)),
    );
  }
  return collection;
}

/**
 * 把 ImageCollection 合成为单幅影像：mode 需要走 ee.Reducer.mode()
 * （集合没有同名方法）；其余方法（mosaic/median/mean/min/max/first）
 * 与集合方法同名，直接调用。
 */
function compositeImageCollection(ee: EeModule, collection: EeObject, method: string): EeObject {
  if (method === "mode") {
    return callEeMethod(collection, "reduce", ee.Reducer.mode());
  }
  return callEeMethod(collection, method);
}

/**
 * OPERA DSWX 水体产品的专属渲染：
 * - 每景影像先掩膜掉 >=252 的无效类别（252/253/254 为 non-water 标记）；
 * - 按方法（max 或 mode）把集合合成为单幅；
 * - 把原始类别值 remap 成 0..n-1 索引便于调色板渲染，再掩膜掉 0（无数据）；
 * - 二值波段（BWTR_Binary_water）与分类波段（WTR_Water_classification）
 *   各有专属类别表与调色板。
 */
function renderOperaDswx(
  ee: EeModule,
  collection: EeObject,
  bandName: string,
  method: string,
): { eeObject: EeObject; visParams: Record<string, unknown> } {
  const binary = bandName === "BWTR_Binary_water";
  // DSWX 类别值：0 无水、1 水体、2 HLS 部分水面，252+ 为无效/掩膜标记。
  const classValues = binary ? [0, 1, 252, 253, 254] : [0, 1, 2, 252, 253, 254];
  // 各类别对应颜色：白色无水、蓝色水体、灰系无效标记、紫色无数据。
  const palette = binary
    ? ["ffffff", "0000ff", "f2f2f2", "dfdfdf", "da00ff"]
    : ["ffffff", "0000ff", "0088ff", "f2f2f2", "dfdfdf", "da00ff"];
  const selectedBand = binary ? bandName : "WTR_Water_classification";
  // 逐景掩膜：仅保留类别值 < 252 的有效像元。
  const maskedCollection = callEeMethod(collection, "map", (image: EeObject) => {
    const selected = callEeMethod(image, "select", selectedBand);
    return callEeMethod(
      selected,
      "updateMask",
      callEeMethod(callEeMethod(image, "select", selectedBand), "lt", 252),
    );
  });
  // S1（雷达）产品默认 max 合成，HLS 用 mode。
  const reducer = method === "max" ? ee.Reducer.max() : ee.Reducer.mode();
  let composite = callEeMethod(maskedCollection, "reduce", reducer);
  // reduce 后波段名会带 reducer 后缀，重命名回标准波段名。
  composite = callEeMethod(composite, "rename", selectedBand);
  // 把类别值 remap 为连续索引（0..n-1），与 palette 一一对应。
  let remapped = callEeMethod(
    callEeMethod(composite, "select", selectedBand),
    "remap",
    classValues,
    classValues.map((_value, index) => index),
  );
  // 掩膜掉 0（remap 后的无水/无数据类），图上只显示有效水体类别。
  remapped = callEeMethod(remapped, "updateMask", callEeMethod(remapped, "neq", 0));
  return {
    eeObject: remapped,
    visParams: {
      min: 0,
      max: classValues.length - 1,
      palette,
    },
  };
}

/**
 * 从 getMap/getMapId 的返回信息中提取瓦片 URL：兼容 tile_fetcher.url_format
 * （新版）与 urlFormat/tile_url/url（旧版/别名）等多种键名。
 */
function extractTileUrl(mapInfo: Record<string, unknown> | undefined): string | null {
  const tileFetcher = mapInfo?.tile_fetcher as { url_format?: unknown } | undefined;
  const url =
    tileFetcher?.url_format ??
    mapInfo?.urlFormat ??
    mapInfo?.tile_url ??
    mapInfo?.url;
  return typeof url === "string" && url ? url : null;
}

/**
 * 为瓦片渲染准备对象：FeatureCollection 的样式类参数（color/width 等）
 * 不能直接传给 getMap，需要经 eeObject.style(...) 转换后以空 visParams
 * 渲染；普通影像对象原样返回。
 */
function renderableEeObjectForTiles(
  eeObject: EeObject,
  visParams: Record<string, unknown>,
): { eeObject: EeObject; visParams: Record<string, unknown> } {
  // 这组键属于 ee 对象的样式参数，而非 getMap 的渲染参数。
  const styleKeys = new Set([
    "color",
    "pointSize",
    "pointShape",
    "width",
    "fillColor",
    "styleProperty",
    "neighborhood",
    "lineType",
  ]);
  const styleParams = Object.fromEntries(
    Object.entries(visParams).filter(([key]) => styleKeys.has(key)),
  );
  if (
    Object.keys(styleParams).length > 0 &&
    typeof eeObject.style === "function"
  ) {
    // 把样式参数烘焙进对象本身，渲染参数清空。
    return {
      eeObject: callEeMethod(eeObject, "style", styleParams),
      visParams: {},
    };
  }
  return { eeObject, visParams };
}

/**
 * 键排序的稳定 JSON 序列化：对象键按字典序排列后再序列化，
 * 保证相同内容的对象生成相同字符串（用于缓存 key）。
 */
function stableJson(value: unknown): string {
  // 基础类型与数组直接序列化。
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const object = value as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(object)
      .sort()
      .reduce<Record<string, unknown>>((out, key) => {
        out[key] = object[key];
        return out;
      }, {}),
  );
}

/**
 * 构造统计 reducer：支持多统计量组合。
 * 先把别名（average/avg -> mean、std/stdev/stddev -> stdDev）归一化，
 * 校验全部受支持后，用 combine(sharedInputs) 把后续统计量并入第一个。
 *
 * @param ee - ee 模块
 * @param value - 统计量列表（数组或逗号分隔字符串），缺省 ["mean"]
 * @returns 组合后的 reducer 与归一化的统计量名列表
 */
function buildStatisticsReducer(
  ee: EeModule,
  value: unknown,
): { reducer: EeObject; statistics: string[] } {
  const aliases: Record<string, string> = {
    average: "mean",
    avg: "mean",
    std: "stdDev",
    stdev: "stdDev",
    stddev: "stdDev",
  };
  const supported = new Set(["mean", "min", "max", "median", "stdDev", "sum", "count"]);
  const requested = parseList(value) ?? ["mean"];
  const statistics = requested.map((item) => aliases[item.toLowerCase()] ?? item);
  for (const statistic of statistics) {
    if (!supported.has(statistic)) {
      throw new Error(
        `Unsupported statistic: ${statistic}. Supported statistics: ${Array.from(supported)
          .sort()
          .join(", ")}`,
      );
    }
  }
  // 第一个统计量作为基础 reducer，其余逐个 combine 进来。
  let reducer = ee.Reducer[statistics[0]]();
  for (const statistic of statistics.slice(1)) {
    reducer = callEeMethod(reducer, "combine", {
      reducer2: ee.Reducer[statistic](),
      // sharedInputs：所有统计量共用同一输入波段。
      sharedInputs: true,
    });
  }
  return { reducer, statistics };
}

/**
 * 给 promise 加超时保护：超时抛出指定消息的错误；timeoutSeconds 非法
 * （非有限数或 <=0）时不启用超时。race 结束后清理定时器避免泄漏。
 */
async function withEeTimeout<T>(
  promise: Promise<T>,
  timeoutSeconds: number,
  message: string,
): Promise<T> {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutSeconds * 1000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * 对 ee 对象做异步求值，优先级：evaluate（真正的异步 API）->
 * getInfo（同步返回值或回调式）-> 都不可用时原样返回对象本身。
 */
async function evaluateEeObject(object: EeObject): Promise<unknown> {
  if (typeof object.evaluate === "function") {
    // evaluate 是推荐的异步求值入口，回调式包成 Promise。
    return new Promise((resolve, reject) => {
      object.evaluate!(
        (value) => resolve(value),
        (error) => reject(new Error(eeErrorMessage(error))),
      );
    });
  }
  if (typeof object.getInfo === "function") {
    // getInfo 可能同步返回结果，也可能只接受回调。
    const result = object.getInfo();
    if (result !== undefined) {
      return result;
    }
    return new Promise((resolve) => object.getInfo!((value) => resolve(value)));
  }
  return object;
}
