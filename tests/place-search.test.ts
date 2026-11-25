import { afterEach, expect, it, vi } from 'vitest';
import { searchPlaceChain } from '../src/lib/core/geocoding/place-search';

afterEach(() => vi.unstubAllGlobals());

it('uses a configured Tianditu proxy without a browser key', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({
    pois: [{ name: '天安门', lonlat: '116.397,39.908' }],
  }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(searchPlaceChain('北京天安门', { tiandituProxyUrl: '/api/tianditu/search' }))
    .resolves.toMatchObject({
      source: 'tianditu',
      candidates: [{ name: '天安门', lon: 116.397, lat: 39.908 }],
    });
  expect(fetchMock).toHaveBeenCalledOnce();
  const request = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
  expect(request.pathname).toBe('/api/tianditu/search');
  expect(request.searchParams.has('tk')).toBe(false);
  expect(JSON.parse(request.searchParams.get('postStr')!)).toMatchObject({ keyWord: '北京天安门' });
});

it('reports the Tianditu authorization error when ArcGIS supplies the result', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ error: 'Tianditu returned HTTP 403 (301012).' }))
    .mockResolvedValueOnce(Response.json({
      candidates: [{ address: '天安门', location: { x: 116.397, y: 39.908 } }],
    })));

  await expect(searchPlaceChain('北京天安门', { tiandituProxyUrl: '/api/tianditu/search' }))
    .resolves.toMatchObject({ source: 'arcgis', message: expect.stringContaining('403 (301012)') });
});
