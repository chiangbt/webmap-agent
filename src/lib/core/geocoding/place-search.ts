/**
 * 地名/地址搜索的三级回退链：天地图地名搜索 → ArcGIS World Geocoder → LLM。
 *
 * 设计要点：
 * - 天地图最擅长中文地名（POI 级粒度），因此配置了 key 时永远先走它；
 * - ArcGIS World Geocoding Service 免 key 可用（findAddressCandidates），
 *   作为天地图无结果/不可达时的回退，对英文与拉丁地名覆盖更好；
 * - 两级地理编码都拿不到结果时，不再继续请求任何在线服务 —— 返回
 *   `source: 'llm'` 的空结果并附指引文案，由调用方（agent 本身就是 LLM）
 *   用自己的地理知识给出坐标，再经 fly_to / zoom_to_bounds 完成定位。
 *   这就是第三级的"LLM 检索"：它不是一次额外的 HTTP 调用，而是把搜索
 *   决策交还给模型。
 *
 * 所有请求都走 fetchBoundedText（超时 + 响应体积上限），单个 provider
 * 失败只记录原因并继续回退，不会中断整条链。
 */
import { fetchBoundedText } from '../../utils/request';

/** 单个地名候选：归一化为经纬度（lon/lat）+ 展示名 + 来源与置信信息。 */
export interface PlaceCandidate {
  /** 候选名称（来自服务方的原始名称）。 */
  name: string;
  /** 经度（十进制度，WGS84）。 */
  lon: number;
  /** 纬度（十进制度，WGS84）。 */
  lat: number;
  /** 服务方给出的置信分（0-100 或等效），缺省时省略。 */
  score?: number;
  /** 服务方给出的地址/行政区等补充说明。 */
  address?: string;
}

/** 地名搜索链的整体结果。 */
export interface PlaceSearchResult {
  /** 命中的提供方：'tianditu' / 'arcgis' / 两级都未命中时的 'llm'。 */
  source: 'tianditu' | 'arcgis' | 'llm';
  /** 归一化候选列表（按服务方置信排序）；'llm' 恒为空数组。 */
  candidates: PlaceCandidate[];
  /** 供 agent 阅读的结果说明（回退原因、LLM 指引等）。 */
  message?: string;
}

/** 地名搜索链的配置：提供方端点、key 与代理模板。 */
export interface PlaceSearchOptions {
  /**
   * 天地图服务 key（TIANDITU_SERVER_KEY）。未配置时跳过第一级，直接走
   * ArcGIS geocoder。
   */
  tiandituKey?: string;
  /**
   * 天地图地名搜索端点。浏览器直连官方端点可能受 CORS 限制，宿主可传
   * 自建代理；模板中的 `{key}` 会被替换为 tiandituKey。
   * @default 'https://api.tianditu.gov.cn/placeSearch'
   */
  tiandituUrl?: string;
  /**
   * ArcGIS geocoder 端点（findAddressCandidates）。
   * @default 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates'
   */
  arcgisGeocoderUrl?: string;
  /** 单个 provider 请求超时（毫秒）。@default 10_000 */
  timeoutMs?: number;
}

/** 默认天地图地名搜索端点（官方 REST 服务）。 */
const DEFAULT_TIANDITU_URL = 'https://api.tianditu.gov.cn/placeSearch';
/** 默认 ArcGIS World Geocoder 端点（免 key 档位）。 */
const DEFAULT_ARCGIS_URL =
  'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates';
/** 每级最多返回的候选数。 */
const MAX_CANDIDATES = 5;

/** 把 URL 模板里的 {key} 占位符替换为真实 key。 */
function resolveTemplate(url: string, key: string): string {
  return url.split('{key}').join(encodeURIComponent(key));
}

/**
 * 天地图地名搜索（placeSearch，queryType=1 普通搜索）。
 * 响应为 JSON：{ pois: [{ name, lonlat: "lon,lat", address? }], count }。
 * key 无效时服务端可能返回非 JSON（如 msg 文本），统一按失败处理。
 */
async function searchTianditu(
  query: string,
  options: PlaceSearchOptions,
  bounds?: { west: number; south: number; east: number; north: number },
): Promise<PlaceCandidate[]> {
  const key = options.tiandituKey ?? '';
  const url = resolveTemplate(options.tiandituUrl ?? DEFAULT_TIANDITU_URL, key);
  // focusRectangle 让结果向当前视口倾斜（官方 postStr 字段）；无视口时省略。
  const postStr: Record<string, unknown> = {
    keyWord: query,
    level: 12,
    queryType: 1,
    start: 0,
    count: MAX_CANDIDATES,
  };
  if (bounds) {
    postStr.focusRectangle = [bounds.west, bounds.south, bounds.east, bounds.north];
  }
  const requestUrl =
    url +
    '?postStr=' +
    encodeURIComponent(JSON.stringify(postStr)) +
    '&type=query&tk=' +
    encodeURIComponent(key);
  const text = await fetchBoundedText(requestUrl, {
    timeoutMs: options.timeoutMs ?? 10_000,
    maxBytes: 512 * 1024,
    label: 'Tianditu place search',
  });
  const data = JSON.parse(text) as {
    pois?: { name?: unknown; lonlat?: unknown; address?: unknown }[];
  };
  const pois = Array.isArray(data.pois) ? data.pois : [];
  const candidates: PlaceCandidate[] = [];
  for (const poi of pois.slice(0, MAX_CANDIDATES)) {
    // lonlat 是 "lon,lat" 字符串（经度在前）。
    const parts = typeof poi.lonlat === 'string' ? poi.lonlat.split(',').map(Number) : [];
    const lon = parts[0];
    const lat = parts[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    candidates.push({
      name: typeof poi.name === 'string' ? poi.name : query,
      lon,
      lat,
      ...(typeof poi.address === 'string' && poi.address ? { address: poi.address } : {}),
    });
  }
  return candidates;
}

/**
 * ArcGIS World Geocoder 回退（findAddressCandidates，singleLine 模式）。
 * 免 key 即可用基础地理编码；响应 candidates[].location 为 { x: lon, y: lat }。
 */
async function searchArcgis(
  query: string,
  options: PlaceSearchOptions,
): Promise<PlaceCandidate[]> {
  const url = options.arcgisGeocoderUrl ?? DEFAULT_ARCGIS_URL;
  const requestUrl =
    url +
    '?f=json&maxLocations=' +
    MAX_CANDIDATES +
    '&forStorage=false&outFields=Match_addr,Addr_type&singleLine=' +
    encodeURIComponent(query);
  const text = await fetchBoundedText(requestUrl, {
    timeoutMs: options.timeoutMs ?? 10_000,
    maxBytes: 512 * 1024,
    label: 'ArcGIS geocoder',
  });
  const data = JSON.parse(text) as {
    candidates?: {
      address?: unknown;
      location?: { x?: unknown; y?: unknown };
      score?: unknown;
    }[];
  };
  const raw = Array.isArray(data.candidates) ? data.candidates : [];
  const candidates: PlaceCandidate[] = [];
  for (const item of raw.slice(0, MAX_CANDIDATES)) {
    const lon = Number(item.location?.x);
    const lat = Number(item.location?.y);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    candidates.push({
      name: typeof item.address === 'string' ? item.address : query,
      lon,
      lat,
      ...(Number.isFinite(Number(item.score)) ? { score: Number(item.score) } : {}),
    });
  }
  return candidates;
}

/**
 * 执行三级回退链：天地图 → ArcGIS geocoder → LLM 指引。
 *
 * @param query - 用户查询的地名/地址原文。
 * @param options - provider 配置（key、端点、超时）。
 * @param bounds - 当前视口包围盒（让天地图结果向视野倾斜；可省略）。
 * @returns 归一化的 {@link PlaceSearchResult}；两级都失败时 source 为 'llm'。
 */
export async function searchPlaceChain(
  query: string,
  options: PlaceSearchOptions = {},
  bounds?: { west: number; south: number; east: number; north: number },
): Promise<PlaceSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error('search_place requires a non-empty query.');
  }
  /** 记录各级回退原因，拼进最终 message 方便 agent（与用户）理解。 */
  const fallbackNotes: string[] = [];

  // 第一级：天地图（中文地名最优）。未配置 key 或请求/解析失败时回退。
  if (options.tiandituKey) {
    try {
      const candidates = await searchTianditu(trimmed, options, bounds);
      if (candidates.length > 0) {
        return { source: 'tianditu', candidates };
      }
      fallbackNotes.push('Tianditu returned no match.');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      fallbackNotes.push('Tianditu failed: ' + reason + '.');
    }
  } else {
    fallbackNotes.push('No Tianditu key configured.');
  }

  // 第二级：ArcGIS World Geocoder。
  try {
    const candidates = await searchArcgis(trimmed, options);
    if (candidates.length > 0) {
      return {
        source: 'arcgis',
        candidates,
        ...(fallbackNotes.length ? { message: fallbackNotes.join(' ') } : {}),
      };
    }
    fallbackNotes.push('ArcGIS geocoder returned no match.');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fallbackNotes.push('ArcGIS geocoder failed: ' + reason + '.');
  }

  // 第三级：LLM。返回空候选 + 指引，把定位决策交还给模型自己的地理知识
  // （随后由模型调用 fly_to / zoom_to_bounds 完成跳转）。
  return {
    source: 'llm',
    candidates: [],
    message:
      fallbackNotes.join(' ') +
      ' No online geocoder matched the query. Use your own geographic knowledge of ' +
      'the place and call fly_to (or zoom_to_bounds) with coordinates you are confident ' +
      'about; state that the location is approximate.',
  };
}
