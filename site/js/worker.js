// Background aggregation worker: loads population tiles on demand (cached) and sums them per polygon.
import { parseTile, aggregateGeometry } from './core/aggregate.js';

let manifest = null, base = '';
const cache = new Map(); // tile id -> parsed tile (LRU by insertion order)
let cachedBytes = 0;
const MAX_BYTES = 400e6;

async function loadTile(t) {
  if (cache.has(t.id)) { const v = cache.get(t.id); cache.delete(t.id); cache.set(t.id, v); return v; }
  const res = await fetch(base + t.file + '?v=' + manifest.data_version);
  if (!res.ok) throw new Error('Tile ' + t.id + ' HTTP ' + res.status);
  const tile = parseTile(await res.arrayBuffer());
  cache.set(t.id, tile); cachedBytes += t.bytes;
  while (cachedBytes > MAX_BYTES && cache.size > 1) { const [k] = cache.keys(); cache.delete(k); cachedBytes -= (manifest.tiles.find(x => x.id === k) || { bytes: 0 }).bytes; }
  return tile;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      base = m.base; manifest = m.manifest;
      self.postMessage({ id: m.id, ok: true });
    } else if (m.type === 'aggregate') {
      if (!manifest) throw new Error('Population data not loaded');
      const out = [];
      for (let k = 0; k < m.geometries.length; k++) {
        const st = await aggregateGeometry(m.geometries[k], manifest, loadTile, m.maxDistM, (i, n) => {
          self.postMessage({ id: m.id, progress: { geometry: k + 1, geometries: m.geometries.length, tile: i, tiles: n } });
        });
        out.push(st);
      }
      self.postMessage({ id: m.id, ok: true, result: out });
    }
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: String(e && e.message || e) });
  }
};
