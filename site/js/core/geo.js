// Parsing, validation and export helpers. DOM-free.

// "3.1579, 101.7116" / "3.1579 101.7116" / "3.1579;101.7116" -> {lat, lon}
export function parseLatLon(text) {
  const m = String(text || '').trim().match(/^\(?\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*\)?$/);
  if (!m) return { error: 'Enter coordinates as "latitude, longitude", e.g. 3.1579, 101.7116' };
  const lat = Number(m[1]), lon = Number(m[2]);
  if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) return { error: 'Latitude must be between -90 and 90. Did you paste "longitude, latitude"? Use "latitude, longitude".' };
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { error: 'Coordinates out of range.' };
  const warn = (lat < 0.5 || lat > 8 || lon < 99 || lon > 120) ? 'This point is outside Malaysia; population and RWI data only cover Malaysia.' : '';
  return { lat, lon, warn };
}

// ---- CSV / TSV ----
export function parseDelimited(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/)[0] || '';
  const delim = firstLine.includes('\t') ? '\t' : (firstLine.split(';').length > firstLine.split(',').length ? ';' : ',');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

const ALIASES = {
  name: ['name', 'store', 'store_name', 'site', 'site_name', 'outlet'],
  latitude: ['latitude', 'lat', 'y'],
  longitude: ['longitude', 'lon', 'lng', 'long', 'x'],
};

// Returns {stores:[{name, latitude, longitude, valid, error}], errors:[...]}
export function parseStoresTable(text) {
  const rows = parseDelimited(text);
  if (!rows.length) return { stores: [], errors: ['The table is empty.'] };
  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const idx = {};
  for (const k of Object.keys(ALIASES)) idx[k] = header.findIndex(h => ALIASES[k].includes(h));
  const errors = [];
  if (idx.name < 0 || idx.latitude < 0 || idx.longitude < 0) {
    return { stores: [], errors: ['Header must contain name, latitude, longitude (found: ' + rows[0].join(', ') + ').'] };
  }
  const stores = rows.slice(1).map((r, i) => {
    const name = String(r[idx.name] ?? '').trim();
    const latS = String(r[idx.latitude] ?? '').trim(), lonS = String(r[idx.longitude] ?? '').trim();
    const lat = Number(latS), lon = Number(lonS);
    let error = '';
    if (latS === '' || lonS === '' || !Number.isFinite(lat) || !Number.isFinite(lon)) error = 'invalid coordinates';
    else if (Math.abs(lat) > 90 || Math.abs(lon) > 180) error = 'coordinates out of range';
    return { name: name || ('Store ' + (i + 1)), latitude: Number.isFinite(lat) ? lat : latS, longitude: Number.isFinite(lon) ? lon : lonS, valid: !error, error };
  });
  return { stores, errors };
}

export function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCSV(rows, cols) {
  return [cols.join(','), ...rows.map(r => cols.map(c => csvEscape(r[c])).join(','))].join('\r\n') + '\r\n';
}
export function toTSV(rows, cols) {
  const clean = v => (v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' '));
  return [cols.join('\t'), ...rows.map(r => cols.map(c => clean(r[c])).join('\t'))].join('\n');
}

// ---- GeoJSON import ----
function closeRing(r) {
  if (!Array.isArray(r) || r.length < 3) return null;
  const pts = r.map(c => [Number(c[0]), Number(c[1])]);
  if (pts.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[1]) > 90 || Math.abs(p[0]) > 180)) return null;
  const a = pts[0], b = pts[pts.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) pts.push([a[0], a[1]]);
  return pts.length >= 4 ? pts : null;
}

// Returns {features:[{name, geometry}], skipped, errors}
export function importGeoJSON(text) {
  let j;
  try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return { features: [], skipped: 0, errors: ['Not valid JSON: ' + e.message] }; }
  const feats = j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : [{ type: 'Feature', properties: {}, geometry: j }];
  const out = []; let skipped = 0; const errors = [];
  feats.forEach((f, i) => {
    const g = f && f.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) { skipped++; return; }
    const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(p => (p || []).map(closeRing));
    if (!polys.length || polys.some(p => !p.length || p.some(r => !r))) { errors.push('Feature ' + (i + 1) + ': invalid ring coordinates'); return; }
    const geometry = polys.length === 1 && g.type === 'Polygon' ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
    const p = f.properties || {};
    out.push({ name: String(p.name || p.NAME || p.title || ('Imported ' + (i + 1))), geometry, holes: polys.reduce((t, x) => t + x.length - 1, 0) });
  });
  if (!out.length && !errors.length) errors.push('No Polygon or MultiPolygon features found.');
  return { features: out, skipped, errors };
}

// ---- KML export ----
const xmlEsc = s => String(s ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
function kmlRing(r) { return '<LinearRing><coordinates>' + r.map(c => c[0] + ',' + c[1] + ',0').join(' ') + '</coordinates></LinearRing>'; }
function kmlPolygon(p) {
  return '<Polygon><outerBoundaryIs>' + kmlRing(p[0]) + '</outerBoundaryIs>' +
    p.slice(1).map(h => '<innerBoundaryIs>' + kmlRing(h) + '</innerBoundaryIs>').join('') + '</Polygon>';
}
export function toKML(features, docName = 'Catchments') {
  const pm = features.map(f => {
    const g = f.geometry; const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    const props = f.properties || {};
    const ext = Object.entries(props).map(([k, v]) => '<Data name="' + xmlEsc(k) + '"><value>' + xmlEsc(v) + '</value></Data>').join('');
    const geom = polys.length === 1 ? kmlPolygon(polys[0]) : '<MultiGeometry>' + polys.map(kmlPolygon).join('') + '</MultiGeometry>';
    return '<Placemark><name>' + xmlEsc(props.name || '') + '</name><ExtendedData>' + ext + '</ExtendedData>' + geom + '</Placemark>';
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>' + xmlEsc(docName) + '</name>\n' + pm + '\n</Document></kml>\n';
}

export function toGeoJSON(features) {
  return JSON.stringify({ type: 'FeatureCollection', features: features.map(f => ({ type: 'Feature', properties: f.properties || {}, geometry: f.geometry })) });
}

// ---- formatting ----
export function fmtNum(v, d = 0) { return v === null || v === undefined || !Number.isFinite(v) ? 'No data' : v.toLocaleString('en-MY', { minimumFractionDigits: d, maximumFractionDigits: d }); }
export function fmtPct(v) { return v === null || v === undefined || !Number.isFinite(v) ? 'No data' : (v * 100).toFixed(1) + '%'; }
