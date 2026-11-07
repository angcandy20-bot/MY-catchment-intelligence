// Population / RWI aggregation over chunked population tiles.
// DOM-free: used by the Web Worker, the batch engine and Node tests.
//
// Tile binary format "MCT1" (little-endian), written by pipeline/build_data.py:
//   0  char[4]  magic "MCT1"
//   4  uint32   nRows   (raster rows present in this tile; every cell in a row shares one latitude)
//   8  uint32   nCells  (cells with population > 0; NoData and zero cells are not stored)
//   12 float32  rowLat[nRows]        cell-centre latitude of each row (WGS84)
//      uint32   rowStart[nRows + 1]  index of first cell of each row (cells sorted by row, then lon)
//      float32  lon[nCells]          cell-centre longitude (WGS84)
//      float32  pop[nCells]          population COUNT of the cell (people per cell, not density)
//      float32  rwi[nCells]          RWI of the nearest valid RWI sample (NaN if none)
//      uint16   distM[nCells]        geodesic distance to that sample in metres (65535 = >= 65.5 km / none)

export const NO_MATCH_DIST = 65535;

export function parseTile(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'MCT1') throw new Error('Bad tile magic: ' + magic);
  const nRows = dv.getUint32(4, true);
  const n = dv.getUint32(8, true);
  let o = 12;
  const rowLat = new Float32Array(buf, o, nRows); o += 4 * nRows;
  const rowStart = new Uint32Array(buf, o, nRows + 1); o += 4 * (nRows + 1);
  const lon = new Float32Array(buf, o, n); o += 4 * n;
  const pop = new Float32Array(buf, o, n); o += 4 * n;
  const rwi = new Float32Array(buf, o, n); o += 4 * n;
  const dist = new Uint16Array(buf, o, n); o += 2 * n;
  if (o > buf.byteLength) throw new Error('Truncated tile');
  return { nRows, n, rowLat, rowStart, lon, pop, rwi, dist };
}

// Normalise any GeoJSON input to an array of polygons, each an array of rings [[lon,lat],...].
export function toPolygons(g) {
  if (!g) return [];
  if (g.type === 'FeatureCollection') return g.features.flatMap(f => toPolygons(f));
  if (g.type === 'Feature') return toPolygons(g.geometry);
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates.slice();
  if (g.type === 'GeometryCollection') return g.geometries.flatMap(x => toPolygons(x));
  return [];
}

export function polygonsBBox(polys) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) for (const r of p) for (const c of r) {
    if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1];
  }
  return [minX, minY, maxX, maxY];
}

// Prepare edges per polygon for fast scanline queries.
export function preparePolygons(polys) {
  return polys.map(rings => {
    const edges = [];
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    for (const ring of rings) {
      const m = ring.length;
      for (let i = 0; i < m; i++) {
        const a = ring[i], b = ring[(i + 1) % m];
        if (a[0] === b[0] && a[1] === b[1]) continue; // closing duplicate / zero-length
        edges.push(a[0], a[1], b[0], b[1]);
        if (a[1] < minY) minY = a[1]; if (a[1] > maxY) maxY = a[1];
        if (a[0] < minX) minX = a[0]; if (a[0] > maxX) maxX = a[0];
      }
    }
    return { edges: Float64Array.from(edges), minX, minY, maxX, maxY };
  });
}

// Inside intervals [x0,x1) for one polygon (all rings, even-odd => holes excluded) at latitude y.
function intervalsAt(pp, y, out) {
  const e = pp.edges, xs = [];
  for (let i = 0; i < e.length; i += 4) {
    const y1 = e[i + 1], y2 = e[i + 3];
    if ((y1 > y) !== (y2 > y)) xs.push(e[i] + (y - y1) * (e[i + 2] - e[i]) / (y2 - y1));
  }
  xs.sort((a, b) => a - b);
  for (let k = 0; k + 1 < xs.length; k += 2) out.push(xs[k], xs[k + 1]);
}

function lowerBound(arr, lo, hi, x) { // first index in [lo,hi) with arr[i] >= x
  while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

export function emptyAcc() {
  return { population: 0, matchedPop: 0, rwiPopSum: 0, cells: 0, matchedCells: 0 };
}

// Add cells of one tile whose centres fall inside the prepared polygons.
// A cell inside several polygons of a MultiPolygon is counted once.
export function accumulateTile(acc, tile, prepared, maxDistM) {
  const { nRows, rowLat, rowStart, lon, pop, rwi, dist } = tile;
  const ivals = [];
  for (let r = 0; r < nRows; r++) {
    const y = rowLat[r];
    ivals.length = 0;
    for (const pp of prepared) if (y >= pp.minY && y <= pp.maxY) intervalsAt(pp, y, ivals);
    if (!ivals.length) continue;
    const s = rowStart[r], t = rowStart[r + 1];
    if (prepared.length > 1 && ivals.length > 2) mergeIntervals(ivals);
    for (let k = 0; k < ivals.length; k += 2) {
      const i0 = lowerBound(lon, s, t, ivals[k]);
      const i1 = lowerBound(lon, i0, t, ivals[k + 1]);
      for (let i = i0; i < i1; i++) {
        const p = pop[i];
        acc.population += p; acc.cells++;
        const v = rwi[i];
        if (v === v && dist[i] !== NO_MATCH_DIST && dist[i] <= maxDistM) {
          acc.matchedPop += p; acc.rwiPopSum += p * v; acc.matchedCells++;
        }
      }
    }
  }
  return acc;
}

function mergeIntervals(iv) { // union of [a,b) pairs in place
  const pairs = [];
  for (let k = 0; k < iv.length; k += 2) pairs.push([iv[k], iv[k + 1]]);
  pairs.sort((a, b) => a[0] - b[0]);
  iv.length = 0;
  for (const [a, b] of pairs) {
    const n = iv.length;
    if (n && a <= iv[n - 1]) { if (b > iv[n - 1]) iv[n - 1] = b; }
    else iv.push(a, b);
  }
}

export function finalize(acc, areaM2) {
  const area_km2 = areaM2 / 1e6;
  return {
    population: acc.population,
    matched_population: acc.matchedPop,
    population_weighted_rwi: acc.matchedPop > 0 ? acc.rwiPopSum / acc.matchedPop : null, // null => "No data"
    wealth_coverage: acc.population > 0 ? acc.matchedPop / acc.population : null,
    area_km2,
    population_density: area_km2 > 0 ? acc.population / area_km2 : null,
    cells: acc.cells,
    matched_cells: acc.matchedCells,
  };
}

// ---- Geodesic area (spherical, authalic radius of WGS84) ----
const R_AUTHALIC = 6371007.181;
function ringAreaM2(ring) {
  const n = ring.length; if (n < 3) return 0;
  const rad = Math.PI / 180; let s = 0;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i], p2 = ring[(i + 1) % n];
    s += (p2[0] - p1[0]) * rad * (2 + Math.sin(p1[1] * rad) + Math.sin(p2[1] * rad));
  }
  return Math.abs(s * R_AUTHALIC * R_AUTHALIC / 2);
}
export function polygonsAreaM2(polys) {
  let a = 0;
  for (const p of polys) { a += ringAreaM2(p[0]); for (let i = 1; i < p.length; i++) a -= ringAreaM2(p[i]); }
  return a;
}

// Tiles (from manifest) intersecting a bbox.
export function tilesForBBox(manifest, bb) {
  return manifest.tiles.filter(t => !(t.bbox[2] < bb[0] || t.bbox[0] > bb[2] || t.bbox[3] < bb[1] || t.bbox[1] > bb[3]));
}

// Full aggregation given a tile loader (async id -> parsed tile).
export async function aggregateGeometry(geojson, manifest, loadTile, maxDistM, onProgress) {
  const polys = toPolygons(geojson).filter(p => p && p.length && p[0].length >= 3);
  if (!polys.length) throw new Error('No polygon geometry');
  const prepared = preparePolygons(polys);
  const bb = polygonsBBox(polys);
  const tiles = tilesForBBox(manifest, bb);
  const acc = emptyAcc();
  let i = 0;
  for (const t of tiles) {
    const tile = await loadTile(t);
    accumulateTile(acc, tile, prepared, maxDistM);
    i++; if (onProgress) onProgress(i, tiles.length);
  }
  return { ...finalize(acc, polygonsAreaM2(polys)), tiles_used: tiles.length };
}
