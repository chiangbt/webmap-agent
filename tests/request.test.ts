import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBoundedText } from '../src/lib/utils/request';
import { validateGeoJson } from '../src/lib/utils/geojson';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('bounded requests', () => {
  it('times out a fetch that never settles', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const request = fetchBoundedText('https://example.com', { timeoutMs: 10 });
    const check = expect(request).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(11); await check;
  });
  it('rejects an oversized body even without content-length', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('123456789')));
    await expect(fetchBoundedText('https://example.com', { maxBytes: 4 })).rejects.toThrow(/exceeds/);
  });
  it('cancels a stalled response body', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }))));
    const controller = new AbortController();
    const request = fetchBoundedText('https://example.com', { signal: controller.signal });
    const check = expect(request).rejects.toThrow(/abort/i);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort(); await check;
    expect(cancel).toHaveBeenCalled();
  });
});
describe('GeoJSON validation', () => {
  it.each([{}, { type: 'Point', coordinates: [Infinity, 0] }, { type: 'FeatureCollection', features: [{}] }])('rejects invalid data %j', (data) => {
    expect(() => validateGeoJson(data)).toThrow(/Invalid GeoJSON/);
  });
  it('enforces coordinate budgets', () => {
    expect(() => validateGeoJson({ type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] }, { maxCoordinates: 1 })).toThrow(/limit/);
  });
});

it('times out while reading the body and cancels the reader', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }))));
  const request = fetchBoundedText('https://example.com', { timeoutMs: 10 });
  const check = expect(request).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(11); await check;
  expect(cancel).toHaveBeenCalled();
});

it('rejects an advertised oversized response before reading it', async () => {
  const cancel = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '100' } })));
  await expect(fetchBoundedText('https://example.com', { maxBytes: 4 })).rejects.toThrow(/exceeds/);
  expect(cancel).toHaveBeenCalled();
});
