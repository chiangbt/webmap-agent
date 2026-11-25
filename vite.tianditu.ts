import type { Plugin } from 'vite';
import { TIANDITU_SEARCH_URL } from './src/lib/core/geocoding/place-search';

export function tiandituSearchProxy(serverKey: string | undefined): Plugin {
  return {
    name: 'demo-tianditu-search',
    configureServer(server) {
      server.middlewares.use('/api/tianditu/search', async (request, response) => {
        const send = (result: object) => {
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify(result));
        };
        if (request.method !== 'GET') {
          response.statusCode = 405;
          return send({ error: 'Only GET is supported.' });
        }
        if (!serverKey || serverKey === 'your-tianditu-server-key') {
          return send({ error: 'TIANDITU_SERVER_KEY is not configured on the server.' });
        }

        const postStr = new URL(request.url ?? '/', 'http://localhost').searchParams.get('postStr');
        if (!postStr || postStr.length > 2048) {
          response.statusCode = 400;
          return send({ error: 'Invalid place search parameters.' });
        }

        try {
          const url = new URL(TIANDITU_SEARCH_URL);
          url.search = new URLSearchParams({ postStr, type: 'query', tk: serverKey }).toString();
          const upstream = await fetch(url, { signal: AbortSignal.timeout(7000), redirect: 'error' });
          const data = await upstream.json() as {
            code?: unknown;
            pois?: Array<{ name?: unknown; lonlat?: unknown; address?: unknown }>;
          };
          if (!upstream.ok || (typeof data.code === 'number' && data.code >= 300000)) {
            const code = typeof data.code === 'number' ? ` (${data.code})` : '';
            return send({ error: `Tianditu returned HTTP ${upstream.status}${code}.` });
          }
          const pois = (Array.isArray(data.pois) ? data.pois : []).slice(0, 5).map(
            ({ name, lonlat, address }) => ({ name, lonlat, address }),
          );
          return send({ pois });
        } catch {
          return send({ error: 'Tianditu search request failed.' });
        }
      });
    },
  };
}
