/**
 * Deployment-wide LLM defaults injected through Vite environment variables
 * (see `envPrefix` in the vite configs and `.env.example`). They prefill the
 * GeoAgent panel so a configured deployment works out of the box; values saved
 * in the panel (sessionStorage) take precedence.
 */
export interface LlmEnvConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function readLlmEnvConfig(): LlmEnvConfig {
  // Computed access (not import.meta.env.LLM_API_URL) on purpose: the library
  // build must never statically inline deployment secrets into dist.
  const env = import.meta.env as Record<string, unknown> | undefined;
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
