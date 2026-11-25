/**
 * 通过 Vite 环境变量注入的全站 LLM 默认配置
 * （见 vite 配置中的 `envPrefix` 与 `.env.example`）。这些值用于预填
 * GeoAgent 面板，使配置好的部署开箱即用；面板内已保存的值
 * （sessionStorage）优先于这里的环境变量。
 */
export interface LlmEnvConfig {
  /** LLM API 的 base URL（来自环境变量 LLM_API_URL）。 */
  baseUrl: string;
  /** LLM API 鉴权密钥（来自环境变量 LLM_API_KEY）。 */
  apiKey: string;
  /** 默认模型名（来自环境变量 LLM_API_MODEL）。 */
  model: string;
}

/**
 * 读取部署注入的 LLM 环境变量配置。
 *
 * @returns LLM_API_URL、LLM_API_KEY 和 LLM_API_MODEL 的默认值。
 */
export function readLlmEnvConfig(): LlmEnvConfig {
  // 故意使用按名计算访问（而非 import.meta.env.LLM_API_URL）：
  // 库构建时绝不把部署密钥静态内联进 dist 产物。
  const env = import.meta.env as Record<string, unknown> | undefined;
  /** 读取单个环境变量：非字符串或缺失时返回空串，字符串则去除首尾空白。 */
  const read = (name: string): string => {
    const value = env?.[name];
    return typeof value === 'string' ? value.trim() : '';
  };
  return {
    baseUrl: read('LLM_API_URL'),
    apiKey: read('LLM_API_KEY'),
    model: read('LLM_API_MODEL'),
  };
}

/** Local Vite supplies a proxy. Static deployments can configure their own same-origin endpoint. */
export function readDemoPlaceSearchConfig() {
  const url = import.meta.env.VITE_TIANDITU_SEARCH_URL?.trim();
  return url || import.meta.env.DEV
    ? { tiandituProxyUrl: url || '/api/tianditu/search' }
    : undefined;
}
