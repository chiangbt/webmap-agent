import Graphic from '@arcgis/core/Graphic.js';
import Polygon from '@arcgis/core/geometry/Polygon.js';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer.js';
import PolygonSymbol3D from '@arcgis/core/symbols/PolygonSymbol3D.js';
import ExtrudeSymbol3DLayer from '@arcgis/core/symbols/ExtrudeSymbol3DLayer.js';
import { when } from '@arcgis/core/core/reactiveUtils.js';
import type SceneView from '@arcgis/core/views/SceneView.js';
import Feature from 'ol/Feature.js';
import MVT from 'ol/format/MVT.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import OlPolygon from 'ol/geom/Polygon.js';
import { createXYZ } from 'ol/tilegrid.js';
import type { TileCoord } from 'ol/tilecoord.js';

const buildingZoom = 14;
const minBuildingScale = 25000;
const tileGrid = createXYZ({ maxZoom: buildingZoom });
const buildingFormat = new MVT<Feature>({ featureClass: Feature, layers: ['building'] });

async function readBuildings(url: string, tile: TileCoord, signal: AbortSignal): Promise<Graphic[]> {
  const [z, x, y] = tile;
  const response = await fetch(url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)), { signal });
  if (!response.ok) throw new Error(`Building tile ${z}/${x}/${y} returned HTTP ${response.status}.`);

  const features = buildingFormat.readFeatures(await response.arrayBuffer(), {
    extent: tileGrid.getTileCoordExtent(tile),
    featureProjection: 'EPSG:3857',
  });
  const graphics: Graphic[] = [];
  for (const feature of features) {
    const hidden = feature.get('hide_3d');
    if (hidden === true || hidden === 1 || hidden === 'true' || hidden === '1') continue;
    const geometry = feature.getGeometry();
    if (!(geometry instanceof OlPolygon || geometry instanceof MultiPolygon)) continue;

    const base = Math.max(0, Number(feature.get('render_min_height')) || 0);
    const top = Number(feature.get('render_height'));
    const height = Number.isFinite(top) && top > base ? top - base : 8;
    // ArcGIS uses clockwise exterior rings, followed by counterclockwise holes.
    const rings = geometry instanceof OlPolygon ? geometry.getCoordinates(false) : geometry.getCoordinates(false).flat();
    graphics.push(new Graphic({
      geometry: new Polygon({
        spatialReference: { wkid: 3857 },
        hasZ: true,
        rings: rings.map((ring) => ring.map(([x, y]) => [x, y, base])),
      }),
      attributes: { base, height },
      symbol: new PolygonSymbol3D({
        symbolLayers: [new ExtrudeSymbol3DLayer({
          size: height,
          material: { color: '#e0bc8a' },
        })],
      }),
    }));
  }
  return graphics;
}

export function addMvtBuildings(view: SceneView, url: string): () => void {
  const layer = new GraphicsLayer({
    id: 'openfreemap-buildings-3d',
    title: 'OpenFreeMap 3D Buildings',
    elevationInfo: { mode: 'relative-to-ground' },
    minScale: minBuildingScale,
  });
  const tiles = new Map<string, { controller: AbortController; graphics: Graphic[] }>();
  view.map?.add(layer);

  const handle = when(() => view.stationary, () => {
    const needed = new Map<string, TileCoord>();
    const { center, extent } = view;
    if (center && extent?.spatialReference.isWebMercator && view.scale <= minBuildingScale) {
      const [, x, y] = tileGrid.getTileCoordForCoordAndZ([center.x, center.y], buildingZoom);
      const bounds = tileGrid.getTileRangeForExtentAndZ([extent.xmin, extent.ymin, extent.xmax, extent.ymax], buildingZoom);
      const limit = 2 ** buildingZoom - 1;
      // Bound work to the visible tiles within one tile of the view center.
      for (let column = Math.max(0, bounds.minX, x - 1); column <= Math.min(limit, bounds.maxX, x + 1); column++) {
        for (let row = Math.max(0, bounds.minY, y - 1); row <= Math.min(limit, bounds.maxY, y + 1); row++) {
          needed.set(`${column}/${row}`, [buildingZoom, column, row]);
        }
      }
    }

    for (const [key, tile] of tiles) {
      if (needed.has(key)) continue;
      tile.controller.abort();
      layer.removeMany(tile.graphics);
      tiles.delete(key);
    }
    for (const [key, coord] of needed) {
      if (tiles.has(key)) continue;
      const tile = { controller: new AbortController(), graphics: [] as Graphic[] };
      tiles.set(key, tile);
      void readBuildings(url, coord, tile.controller.signal).then((graphics) => {
        if (tile.controller.signal.aborted) return;
        tile.graphics = graphics;
        layer.addMany(graphics);
      }).catch((error: unknown) => {
        if (tile.controller.signal.aborted) return;
        tiles.delete(key);
        console.warn('Unable to load OpenFreeMap buildings.', error);
      });
    }
  }, { initial: true });

  return () => {
    handle.remove();
    for (const tile of tiles.values()) tile.controller.abort();
    layer.destroy();
  };
}
