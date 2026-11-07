import { requestIsochrones, DIRECTIONS, cacheKey, MINUTES, HEIGIT_ISOCHRONES_ENDPOINT } from './core/heigit.js';
import { parseLatLon, importGeoJSON, parseStoresTable, toCSV, toTSV, toKML, toGeoJSON, fmtNum, fmtPct } from './core/geo.js';
import { BatchRunner, newJob, jobRows, jobSummary, BATCH_COLUMNS, DIRECTION_VALUE } from './core/batch.js';
import { toPolygons } from './core/aggregate.js';
import { idb } from './idb.js';

const BUILD = new URL(import.meta.url).searchParams.get('v') || 'dev';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// The HeiGIT key lives only in this variable (page memory). Never persisted, logged or exported.
let apiKey = '';

function setStatus(id, text, cls = '') { const el = $(id); el.textContent = text; el.className = 'st ' + cls; }
function toast(t, ms = 3200) { const e = $('toast'); e.textContent = t; e.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(() => e.style.display = 'none', ms); }
function download(name, text, type) {
  const b = new Blob([text], { type }); const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const maxDistM = () => Math.max(100, Math.min(50000, Math.round(Number($('maxDist').value || 3) * 1000)));
const direction = () => document.querySelector('input[name=dir]:checked').value;
const asGeometry = polys => polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };

// ------------------------------------------------------------------ tabs
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
function showTab(t) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('[data-pane]').forEach(p => p.hidden = p.dataset.pane !== t);
  $('apiPanel').hidden = !(t === 'iso' || t === 'batch');
}

// ------------------------------------------------------------------ map + OSM basemap
const map = L.map('map', { zoomControl: true, preferCanvas: false }).setView([3.139, 101.6869], 11);
map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  referrerPolicy: 'strict-origin-when-cross-origin',
});
let tileErrors = 0, tilesLoaded = 0;
osm.on('loading', () => setStatus('stBase', 'Loading OpenStreetMap tiles…', 'busy'));
osm.on('tileload', () => { tilesLoaded++; });
osm.on('tileerror', () => { tileErrors++; setStatus('stBase', `${tileErrors} OpenStreetMap tile(s) failed to load — check your connection`, 'warn'); });
osm.on('load', () => { if (!tileErrors) setStatus('stBase', 'OpenStreetMap tiles loaded', 'ok'); window.__osmTilesLoaded = tilesLoaded; });
osm.addTo(map);

map.createPane('isoPane'); map.getPane('isoPane').style.zIndex = 410;
map.createPane('workPane'); map.getPane('workPane').style.zIndex = 420;
const isoGroup = L.layerGroup().addTo(map);
const batchGroup = L.layerGroup().addTo(map);
const workGroup = L.featureGroup().addTo(map);
let pointMarker = null;

const ISO_COLORS = ['#3b0f70', '#5a167e', '#7a2382', '#9b2f7f', '#bc3978', '#da4a6c', '#f0605d', '#fa7f5e', '#fea16e', '#fec488'];
const legend = L.control({ position: 'bottomright' });
legend.onAdd = () => { const d = L.DomUtil.create('div', 'legend'); d.innerHTML = '<b>Driving minutes</b><br>' + MINUTES.map(m => `<i style="background:${ISO_COLORS[m - 1]}"></i>${m} min`).join('<br>'); return d; };
legend.addTo(map);

const WORK_STYLE = { color: '#0f62fe', weight: 2, fillColor: '#0f62fe', fillOpacity: 0.12, pane: 'workPane' };
map.pm.addControls({ position: 'topleft', drawMarker: false, drawCircleMarker: false, drawPolyline: false, drawCircle: false, drawText: false,
  drawRectangle: true, drawPolygon: true, editMode: true, dragMode: true, cutPolygon: true, removalMode: true, rotateMode: false });
map.pm.setGlobalOptions({ layerGroup: workGroup, pathOptions: WORK_STYLE, allowSelfIntersection: false });

function hookLayer(l) { l.on('pm:edit pm:dragend pm:markerdragend pm:rotateend', onWorkChanged); }
map.on('pm:create', e => { if (!workGroup.hasLayer(e.layer)) workGroup.addLayer(e.layer); hookLayer(e.layer); workSource = 'drawn'; onWorkChanged(); });
map.on('pm:cut', e => { if (e.originalLayer) workGroup.removeLayer(e.originalLayer); if (e.layer && !workGroup.hasLayer(e.layer)) workGroup.addLayer(e.layer); if (e.layer) hookLayer(e.layer); onWorkChanged(); });
map.on('pm:remove', () => onWorkChanged());
map.on('pm:globaleditmodetoggled pm:globaldragmodetoggled', e => { if (!e.enabled) onWorkChanged(); });

function drawingActive() {
  const pm = map.pm; const f = n => typeof pm[n] === 'function' && pm[n]();
  return f('globalDrawModeEnabled') || f('globalEditModeEnabled') || f('globalRemovalModeEnabled') || f('globalCutModeEnabled') || f('globalDragModeEnabled');
}

// ------------------------------------------------------------------ data + worker
let manifest = null, dataReady = false;
const worker = new Worker(`js/worker.js?v=${BUILD}`, { type: 'module' });
let wid = 0; const pending = new Map();
worker.onmessage = e => {
  const m = e.data, p = pending.get(m.id); if (!p) return;
  if (m.progress) { p.onProgress && p.onProgress(m.progress); return; }
  pending.delete(m.id); m.ok ? p.ok(m.result) : p.no(new Error(m.error));
};
worker.onerror = e => setStatus('stAgg', 'Aggregation worker error: ' + (e.message || 'failed to start'), 'err');
const wcall = (msg, onProgress) => new Promise((ok, no) => { const id = ++wid; pending.set(id, { ok, no, onProgress }); worker.postMessage({ ...msg, id }); });
let aggChain = Promise.resolve();
function aggregateMany(geoms, label, maxD = maxDistM()) {
  const run = async () => {
    if (!dataReady) throw new Error('Population/RWI data not loaded');
    const t0 = performance.now();
    setStatus('stAgg', `${label}: calculating…`, 'busy');
    const r = await wcall({ type: 'aggregate', geometries: geoms, maxDistM: maxD }, p =>
      setStatus('stAgg', `${label}: polygon ${p.geometry}/${p.geometries} · data chunk ${p.tile}/${p.tiles}`, 'busy'));
    setStatus('stAgg', `${label}: done (${((performance.now() - t0) / 1000).toFixed(1)} s, RWI threshold ${(maxD / 1000).toFixed(1)} km)`, 'ok');
    return r;
  };
  const p = aggChain.then(run, run); aggChain = p.catch(() => {}); return p;
}

async function loadData() {
  try {
    const r = await fetch('data/manifest.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    manifest = await r.json();
    await wcall({ type: 'init', manifest, base: new URL('data/', location.href).href });
    dataReady = true;
    const p = manifest.population;
    setStatus('stAgg', `Ready · ${fmtNum(p.cells)} population cells (${p.epoch || '?'} ${p.release || ''}), ${fmtNum(manifest.rwi.samples)} RWI samples`, 'ok');
    renderDataInfo();
  } catch (e) {
    setStatus('stAgg', 'Population/RWI data could not be loaded (' + e.message + '). Drawing still works; statistics are unavailable.', 'err');
    $('dataInfo').textContent = 'Data not available.';
  }
  try {
    const b = await fetch('build-report.json', { cache: 'no-cache' });
    if (b.ok) renderBuildInfo(await b.json()); else $('buildInfo').textContent = 'No build report (local copy).';
  } catch (e) { $('buildInfo').textContent = 'No build report.'; }
}

function renderDataInfo() {
  const p = manifest.population, w = manifest.rwi, m = manifest.matching || {};
  const res = (p.resolution || []).map(v => (+v).toPrecision(6)).join(' × ');
  $('dataInfo').innerHTML = `
   <p><b>Population</b>: ${esc(p.dataset)}<br>Resource: <code>${esc(p.resource)}</code><br>
   Epoch: <b>${esc(p.epoch || 'unknown')}</b> · release <b>${esc(p.release || 'unknown')}</b> · ${esc(p.selection || '')}<br>
   CRS: ${esc(p.crs)} ${p.crs_authority ? '(' + esc(p.crs_authority.join(':')) + ')' : ''} · resolution ${esc(res)} ${esc(p.resolution_units)}<br>
   Units: ${esc(p.units)} · NoData value: ${esc(p.nodata)} · total ${fmtNum(p.total)} people in ${fmtNum(p.cells)} populated cells<br>
   <a href="${esc(p.url)}" target="_blank" rel="noopener">HDX dataset</a></p>
   <p><b>Relative wealth</b>: ${esc(w.dataset)}<br>Resource: <code>${esc(w.resource)}</code><br>
   HDX dataset date: ${esc(w.dataset_date || 'unknown')} · ${fmtNum(w.samples)} valid samples · ≈${esc(w.approx_tile_size_km || '?')} km tiles<br>
   <a href="${esc(w.url)}" target="_blank" rel="noopener">HDX dataset</a></p>
   <p><b>Matching</b>: ${esc(m.method || '')}. Share of national population with an RWI sample within 3 km: ${fmtPct(m.population_share_within_3km)}.</p>
   <p>Data version ${esc(manifest.data_version)} · built ${esc(manifest.built_at)} · <a href="data/data_report.json" target="_blank">full data verification report</a></p>`;
}
function renderBuildInfo(b) {
  const items = (b.checks || []).map(c => `<li>${c.pass ? '✅' : '❌'} <b>${esc(c.kind)}</b> · ${esc(c.name)}${c.detail ? ' — ' + esc(c.detail) : ''}</li>`).join('');
  $('buildInfo').innerHTML = `<p>Build ${esc(b.build || BUILD)} · ${esc(b.generated_at || '')}</p><ul class="method">${items}</ul>
   <p>“simulated” = tested with a mocked HeiGIT response, not a real API call. “real” = tested against the live service or real data.</p>`;
}

// ------------------------------------------------------------------ stats rendering
function statsHTML(st, maxD) {
  if (!st) return '<div class="muted">No polygon selected.</div>';
  const nd = v => v === null || v === undefined;
  return `
   <div class="stat"><b>${fmtNum(st.population)}</b><span>Population</span></div>
   <div class="stat"><b class="${nd(st.population_weighted_rwi) ? 'nodata' : ''}">${nd(st.population_weighted_rwi) ? 'No data' : st.population_weighted_rwi.toFixed(3)}</b><span>Pop-weighted RWI</span></div>
   <div class="stat"><b class="${nd(st.wealth_coverage) ? 'nodata' : ''}">${fmtPct(st.wealth_coverage)}</b><span>Wealth coverage</span></div>
   <div class="stat"><b>${fmtNum(st.area_km2, 2)}</b><span>Area km²</span></div>
   <div class="stat"><b>${fmtNum(st.population_density, 0)}</b><span>People per km²</span></div>
   <div class="stat"><b>${fmtNum(st.matched_population)}</b><span>Matched population (≤ ${(maxD / 1000).toFixed(1)} km)</span></div>`;
}

// ------------------------------------------------------------------ working polygon
let workStats = null, workSource = 'drawn';
function workGeometry() {
  const polys = toPolygons(workGroup.toGeoJSON()).filter(p => p && p[0] && p[0].length >= 4);
  return polys.length ? asGeometry(polys) : null;
}
const onWorkChanged = debounce(recalcWork, 350);
async function recalcWork() {
  const g = workGeometry();
  if (!g) { workStats = null; $('workStats').innerHTML = statsHTML(null); return; }
  if (!dataReady) { $('workStats').innerHTML = '<div class="muted">Polygon set, but population data is not loaded.</div>'; return; }
  try { const maxD = maxDistM(); [workStats] = await aggregateMany([g], 'Selected polygon', maxD); workStats.maxDistM = maxD; $('workStats').innerHTML = statsHTML(workStats, maxD); }
  catch (e) { setStatus('stAgg', 'Aggregation failed: ' + e.message, 'err'); }
}
function setWorkGeometry(geometry, name, source) {
  workGroup.clearLayers();
  L.geoJSON(geometry, { style: WORK_STYLE }).eachLayer(l => { workGroup.addLayer(l); hookLayer(l); });
  if (name) $('workName').value = name;
  workSource = source || 'drawn';
  try { map.fitBounds(workGroup.getBounds().pad(0.2)); } catch (e) { /* empty */ }
  recalcWork();
}
$('clearWork').onclick = () => { workGroup.clearLayers(); recalcWork(); };
$('gjFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const r = importGeoJSON(await f.text());
  if (!r.features.length) { $('importMsg').textContent = r.errors.join(' '); return; }
  const holes = r.features.reduce((t, x) => t + x.holes, 0);
  if (r.features.length === 1) {
    setWorkGeometry(r.features[0].geometry, r.features[0].name, 'imported');
    $('importMsg').textContent = `Imported 1 feature (${r.features[0].geometry.type}, ${holes} hole(s))` + (r.skipped ? `; skipped ${r.skipped} non-polygon feature(s)` : '') + (r.errors.length ? '; ' + r.errors.join(' ') : '');
  } else {
    $('importMsg').textContent = `Importing ${r.features.length} features as separate saved catchments…`;
    const stats = dataReady ? await aggregateMany(r.features.map(x => x.geometry), 'Imported features') : [];
    for (let i = 0; i < r.features.length; i++) await saveCatchment({ name: r.features[i].name, geometry: r.features[i].geometry, stats: stats[i] || null, source: 'imported' });
    setWorkGeometry(r.features[0].geometry, r.features[0].name, 'imported');
    $('importMsg').textContent = `Saved ${r.features.length} imported features as catchments (${holes} hole(s) in total)` + (r.skipped ? `; skipped ${r.skipped} non-polygon feature(s)` : '') + '. See Saved & compare.';
    renderSaved();
  }
};
$('saveWork').onclick = async () => {
  const g = workGeometry(); if (!g) { toast('Draw or import a polygon first'); return; }
  const name = $('workName').value.trim() || 'Catchment ' + new Date().toLocaleString();
  await saveCatchment({ name, geometry: g, stats: workStats, source: workSource });
  toast('Saved “' + name + '”'); renderSaved();
};

// ------------------------------------------------------------------ point selection
let point = null;
function setPoint(lat, lon, why) {
  point = { lat, lon };
  if (pointMarker) map.removeLayer(pointMarker);
  pointMarker = L.marker([lat, lon], { pmIgnore: true, title: 'Store point' }).addTo(map).bindTooltip(`${lat.toFixed(6)}, ${lon.toFixed(6)}`);
  $('coordIn').value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  $('isoPoint').innerHTML = `Store point: <b>${lat.toFixed(6)}, ${lon.toFixed(6)}</b> (${esc(why)})`;
}
$('coordGo').onclick = () => {
  const r = parseLatLon($('coordIn').value);
  if (r.error) { $('coordMsg').textContent = r.error; return; }
  setPoint(r.lat, r.lon, 'pasted coordinates'); map.setView([r.lat, r.lon], Math.max(map.getZoom(), 14));
  $('coordMsg').textContent = r.warn || 'Point set. Use the Isochrones tab to generate driving isochrones.';
};
$('coordIn').onkeydown = e => { if (e.key === 'Enter') $('coordGo').click(); };
map.on('click', e => { if (drawingActive()) return; setPoint(e.latlng.lat, e.latlng.lng, 'map click'); $('coordMsg').textContent = 'Point set from map click.'; });

// ------------------------------------------------------------------ API key panel
$('apiKey').addEventListener('input', e => {
  apiKey = e.target.value.trim();
  $('apiKeyState').textContent = apiKey ? 'Key entered (in memory only)' : 'Not entered';
  setStatus('stApi', apiKey ? 'Key entered — not yet verified. It is checked on the first request.' : 'No API key entered (manual polygons still work)', apiKey ? '' : '');
});
$('apiClear').onclick = () => { apiKey = ''; $('apiKey').value = ''; $('apiKeyState').textContent = 'Not entered'; setStatus('stApi', 'Key cleared from memory', ''); };

async function getContours(lat, lon, dir, signal) {
  const k = cacheKey(lat, lon, dir);
  let c = null; try { c = await idb.get('iso', k); } catch (e) { /* no cache */ }
  if (c && c.contours && c.contours.length === 10) { setStatus('stApi', `Using cached contours (${DIRECTIONS[dir].label}) — no API call`, 'ok'); return { contours: c.contours, fromCache: true }; }
  setStatus('stApi', `Requesting isochrones from api.heigit.org · ${DIRECTIONS[dir].label}…`, 'busy');
  try {
    const r = await requestIsochrones({ lat, lon, direction: dir, apiKey, signal });
    try { await idb.set('iso', k, { contours: r.contours, at: Date.now() }); } catch (e) { /* cache optional */ }
    setStatus('stApi', `HeiGIT OK · received all 10 contours (${DIRECTIONS[dir].label})`, 'ok');
    return { contours: r.contours, fromCache: false };
  } catch (e) {
    setStatus('stApi', e.message + (e.detail ? ` [HTTP ${e.status}]` : ''), e.kind === 'rate_limited' ? 'warn' : 'err');
    throw e;
  }
}

// ------------------------------------------------------------------ isochrones
let iso = null; // {lat, lon, direction, contours, stats, sel}
function updateDirLabels() {
  const d = direction();
  for (const id of ['isoDirLbl', 'batchDirLbl']) { const el = $(id); el.textContent = DIRECTIONS[d].label; el.className = 'pill' + (d === 'from' ? ' from' : ''); }
}
document.querySelectorAll('input[name=dir]').forEach(r => r.onchange = updateDirLabels);
$('isoGo').onclick = async () => {
  if (!point) { toast('Pick a store point first (paste coordinates or click the map)'); return; }
  const dir = direction();
  $('isoGo').disabled = true;
  try {
    const { contours } = await getContours(point.lat, point.lon, dir);
    iso = { lat: point.lat, lon: point.lon, direction: dir, contours, stats: null, sel: 'all' };
    renderIso();
    if (dataReady) { const maxD = maxDistM(); iso.stats = await aggregateMany(contours.map(c => c.geometry), 'Isochrones 1–10 min', maxD); iso.maxDistM = maxD; renderIso(); }
  } catch (e) { toast(e.message, 6000); }
  finally { $('isoGo').disabled = false; }
};
function drawIso() {
  isoGroup.clearLayers(); if (!iso) return;
  const list = iso.sel === 'all' ? [...iso.contours].reverse() : iso.contours.filter(c => c.minutes === iso.sel);
  for (const c of list) {
    L.geoJSON(c.geometry, { pmIgnore: true, pane: 'isoPane', style: { color: ISO_COLORS[c.minutes - 1], weight: 1.5, fillColor: ISO_COLORS[c.minutes - 1], fillOpacity: iso.sel === 'all' ? 0.12 : 0.3 } })
      .bindTooltip(`${c.minutes} min · ${DIRECTIONS[iso.direction].label}`).addTo(isoGroup);
  }
}
function renderIso() {
  $('isoResult').hidden = !iso; if (!iso) return;
  // Switching minutes only redraws stored contours; it never calls the API.
  $('minBar').innerHTML = `<button data-m="all" class="${iso.sel === 'all' ? 'on' : ''}">All 10</button>` + MINUTES.map(m => `<button data-m="${m}" class="${iso.sel === m ? 'on' : ''}">${m}</button>`).join('');
  $('minBar').querySelectorAll('button').forEach(b => b.onclick = () => { iso.sel = b.dataset.m === 'all' ? 'all' : Number(b.dataset.m); renderIso(); });
  const rows = iso.contours.map((c, i) => ({ c, s: iso.stats ? iso.stats[i] : null }));
  $('isoTable').innerHTML = `<tr><th>Minutes</th><th>Population</th><th>Pop-wt RWI</th><th>Coverage</th><th>Area km²</th><th>Density /km²</th></tr>` +
    rows.map(({ c, s }) => `<tr data-m="${c.minutes}" class="${iso.sel === c.minutes ? 'sel' : ''}"><td>≤ ${c.minutes}</td><td>${s ? fmtNum(s.population) : '…'}</td><td>${s ? (s.population_weighted_rwi === null ? 'No data' : s.population_weighted_rwi.toFixed(3)) : '…'}</td><td>${s ? fmtPct(s.wealth_coverage) : '…'}</td><td>${s ? fmtNum(s.area_km2, 2) : '…'}</td><td>${s ? fmtNum(s.population_density) : '…'}</td></tr>`).join('');
  $('isoTable').querySelectorAll('tr[data-m]').forEach(tr => tr.onclick = () => { iso.sel = Number(tr.dataset.m); renderIso(); });
  drawIso();
  if (iso.contours.length) { try { map.fitBounds(L.geoJSON(iso.contours[9].geometry).getBounds().pad(0.1)); } catch (e) { /* */ } }
}
function isoFeatures() {
  return iso.contours.map((c, i) => ({ geometry: c.geometry, properties: isoProps(iso, c.minutes, iso.stats ? iso.stats[i] : null) }));
}
function isoProps(it, minutes, s) {
  return { name: `Isochrone ${minutes} min`, latitude: it.lat, longitude: it.lon, minutes, direction: DIRECTION_VALUE[it.direction],
    population: s ? Math.round(s.population * 10) / 10 : '', population_weighted_rwi: s ? (s.population_weighted_rwi ?? 'No data') : '',
    wealth_coverage: s ? (s.wealth_coverage ?? 'No data') : '', area_km2: s ? s.area_km2 : '', population_density: s ? (s.population_density ?? 'No data') : '',
    rwi_max_match_km: (it.maxDistM || maxDistM()) / 1000, travel_time_note: 'modelled driving time, no real-time traffic' };
}
$('isoCsv').onclick = () => iso && download('isochrones.csv', toCSV(isoFeatures().map(f => f.properties), Object.keys(isoFeatures()[0].properties)), 'text/csv');
$('isoGeo').onclick = () => iso && download('isochrones.geojson', toGeoJSON(isoFeatures()), 'application/geo+json');
$('isoKml').onclick = () => iso && download('isochrones.kml', toKML(isoFeatures(), 'Isochrones'), 'application/vnd.google-earth.kml+xml');
$('isoSaveSel').onclick = async () => {
  if (!iso || iso.sel === 'all') { toast('Select one minute first'); return; }
  await saveIsoMinute(iso.sel); renderSaved(); toast('Saved');
};
$('isoSaveAll').onclick = async () => { if (!iso) return; for (const m of MINUTES) await saveIsoMinute(m); renderSaved(); toast('Saved 10 catchments'); };
async function saveIsoMinute(m) {
  const i = m - 1;
  await saveCatchment({ name: `${iso.direction === 'to' ? 'To' : 'From'} ${iso.lat.toFixed(4)},${iso.lon.toFixed(4)} · ${m} min`, geometry: iso.contours[i].geometry,
    stats: iso.stats ? { ...iso.stats[i], maxDistM: iso.maxDistM } : null, source: 'isochrone', meta: { minutes: m, direction: iso.direction, lat: iso.lat, lon: iso.lon } });
}

// ------------------------------------------------------------------ saved catchments
async function saveCatchment(c) {
  const rec = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), savedAt: new Date().toISOString(), ...c,
    maxDistM: (c.stats && c.stats.maxDistM) || maxDistM() };
  await idb.set('catchments', rec.id, rec); return rec;
}
let savedCache = [];
async function renderSaved() {
  try { savedCache = (await idb.all('catchments')).sort((a, b) => a.savedAt.localeCompare(b.savedAt)); } catch (e) { savedCache = []; }
  const ticked = new Set([...document.querySelectorAll('#savedList input[type=checkbox]:checked')].map(x => x.dataset.id));
  $('savedList').innerHTML = savedCache.length ? savedCache.map(c => `<div class="saved-item">
    <input type="checkbox" data-id="${c.id}" ${ticked.has(c.id) || !ticked.size ? 'checked' : ''}>
    <input type="text" class="nm" data-rename="${c.id}" value="${esc(c.name)}" title="Edit to rename">
    <button class="small" data-open="${c.id}">Open</button><button class="small" data-del="${c.id}">Delete</button></div>`).join('')
    : '<div class="muted">Nothing saved yet.</div>';
  $('savedList').querySelectorAll('[data-open]').forEach(b => b.onclick = () => { const c = savedCache.find(x => x.id === b.dataset.open); setWorkGeometry(c.geometry, c.name, c.source); showTab('catchment'); });
  $('savedList').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await idb.del('catchments', b.dataset.del); renderSaved(); });
  $('savedList').querySelectorAll('[data-rename]').forEach(inp => inp.onchange = async () => { const c = savedCache.find(x => x.id === inp.dataset.rename); c.name = inp.value.trim() || c.name; await idb.set('catchments', c.id, c); renderCompare(); });
  $('savedList').querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = renderCompare);
  renderCompare();
}
function tickedSaved() { const ids = new Set([...document.querySelectorAll('#savedList input[type=checkbox]:checked')].map(x => x.dataset.id)); return savedCache.filter(c => ids.has(c.id)); }
function savedRow(c) {
  const s = c.stats || {};
  return { name: c.name, source: c.source, minutes: c.meta && c.meta.minutes || '', direction: c.meta ? DIRECTION_VALUE[c.meta.direction] : '',
    population: s.population != null ? Math.round(s.population * 10) / 10 : '', population_weighted_rwi: c.stats ? (s.population_weighted_rwi ?? 'No data') : '',
    wealth_coverage: c.stats ? (s.wealth_coverage ?? 'No data') : '', area_km2: s.area_km2 ?? '', population_density: c.stats ? (s.population_density ?? 'No data') : '',
    rwi_max_match_km: c.maxDistM / 1000, saved_at: c.savedAt };
}
function renderCompare() {
  const list = tickedSaved();
  $('cmpTable').innerHTML = list.length ? `<tr><th>Name</th><th>Population</th><th>Pop-wt RWI</th><th>Coverage</th><th>Area km²</th><th>Density</th><th>RWI ≤ km</th></tr>` +
    list.map(c => { const s = c.stats; return `<tr><td>${esc(c.name)}</td><td>${s ? fmtNum(s.population) : 'not calculated'}</td><td>${s ? (s.population_weighted_rwi === null ? 'No data' : s.population_weighted_rwi.toFixed(3)) : ''}</td><td>${s ? fmtPct(s.wealth_coverage) : ''}</td><td>${s ? fmtNum(s.area_km2, 2) : ''}</td><td>${s ? fmtNum(s.population_density) : ''}</td><td>${(c.maxDistM / 1000).toFixed(1)}</td></tr>`; }).join('')
    : '<tr><td class="muted">Tick saved catchments to compare.</td></tr>';
}
const savedFeatures = () => tickedSaved().map(c => ({ geometry: c.geometry, properties: savedRow(c) }));
$('cmpCsv').onclick = () => { const f = savedFeatures(); if (!f.length) return toast('Tick catchments first'); download('catchments.csv', toCSV(f.map(x => x.properties), Object.keys(f[0].properties)), 'text/csv'); };
$('cmpGeo').onclick = () => { const f = savedFeatures(); if (!f.length) return toast('Tick catchments first'); download('catchments.geojson', toGeoJSON(f), 'application/geo+json'); };
$('cmpKml').onclick = () => { const f = savedFeatures(); if (!f.length) return toast('Tick catchments first'); download('catchments.kml', toKML(f, 'Catchments'), 'application/vnd.google-earth.kml+xml'); };
$('cmpRecalc').onclick = async () => {
  const list = tickedSaved(); if (!list.length || !dataReady) return;
  const maxD = maxDistM(); const st = await aggregateMany(list.map(c => c.geometry), 'Saved catchments', maxD);
  for (let i = 0; i < list.length; i++) { list[i].stats = { ...st[i], maxDistM: maxD }; list[i].maxDistM = maxD; await idb.set('catchments', list[i].id, list[i]); }
  renderSaved();
};

// ------------------------------------------------------------------ batch
let job = null, runner = null;
const sleep = (ms, signal) => new Promise((ok) => {
  const end = Date.now() + ms;
  const t = setInterval(() => { const left = end - Date.now(); if (left <= 0 || (signal && signal.aborted)) { clearInterval(t); ok(); } else if (ms > 4000) $('batchStatus').textContent = `Waiting ${Math.ceil(left / 1000)} s…`; }, 250);
});
function parseBatchInput() {
  const r = parseStoresTable($('batchIn').value);
  const bad = r.stores.filter(s => !s.valid).length;
  $('batchParse').textContent = r.errors.length ? r.errors.join(' ') : `${r.stores.length} store(s) parsed` + (bad ? `, ${bad} with invalid coordinates (will be marked failed)` : '') + ` → ${r.stores.length * 10} output rows.`;
  return r;
}
$('batchIn').oninput = debounce(parseBatchInput, 300);
$('batchFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) { $('batchIn').value = await f.text(); parseBatchInput(); } };
const renderBatchThrottled = debounce(() => renderBatch(), 200);
function renderBatch(info = {}) {
  if (!job) { $('batchTable').innerHTML = ''; return; }
  const s = jobSummary(job);
  $('batchBar').style.width = (100 * (s.ok + s.failed) / Math.max(1, s.total)) + '%';
  const st = { running: 'Running', ready: 'Ready', stopped: 'Stopped', done: 'Done', halted: 'Halted' }[job.state] || job.state;
  $('batchStatus').innerHTML = `<b>${st}</b> · ${s.ok + s.failed}/${s.total} stores processed (${s.ok} ok, ${s.failed} failed, ${s.pending} pending) · ${esc(DIRECTION_VALUE[job.direction])} · RWI ≤ ${(job.maxDistM / 1000).toFixed(1)} km` + (job.message ? `<br><span class="nodata">${esc(job.message)}</span>` : '');
  const rows = jobRows(job); const LIM = 3000;
  $('batchTable').innerHTML = `<tr>${BATCH_COLUMNS.map(c => `<th>${c}</th>`).join('')}</tr>` + rows.slice(0, LIM).map(r =>
    `<tr class="${r.status.startsWith('failed') ? 'bad' : r.status.startsWith('incomplete') ? 'pend' : ''}">${BATCH_COLUMNS.map(c => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('') +
    (rows.length > LIM ? `<tr><td colspan="11" class="muted">Showing first ${LIM} of ${rows.length} rows. Copy or export to get all rows.</td></tr>` : '');
}
async function saveJob(j) { try { await idb.set('jobs', 'current', j); } catch (e) { /* storage full or unavailable */ } }
function startRunner() {
  runner = new BatchRunner(job, {
    getContours: (s, dir, o) => getContours(Number(s.latitude), Number(s.longitude), dir, o && o.signal),
    aggregate: async (g, maxD) => (await aggregateMany([g], 'Batch', maxD))[0],
    save: saveJob, sleep,
    onUpdate: (j, info) => {
      if (info && info.waitingMs > 4000) setStatus('stApi', `${info.reason} — waiting ${Math.ceil(info.waitingMs / 1000)} s`, 'warn');
      if (info && info.error) setStatus('stApi', info.error.message, 'err');
      renderBatchThrottled();
    },
  });
  $('batchStart').disabled = true; $('batchResume').disabled = true;
  return runner.run().finally(() => { $('batchStart').disabled = false; $('batchResume').disabled = false; renderBatch(); runner = null; });
}
$('batchStart').onclick = async () => {
  if (runner) return;
  const r = parseBatchInput(); if (!r.stores.length) { toast('Paste or load a table with name, latitude, longitude'); return; }
  if (!dataReady) { toast('Population data is not loaded yet'); return; }
  if (!apiKey) { setStatus('stApi', 'No API key entered. Paste your HeiGIT API key in the API setup panel.', 'err'); toast('Enter your HeiGIT API key first'); return; }
  job = newJob({ stores: r.stores, direction: direction(), maxDistM: maxDistM() });
  await saveJob(job); renderBatch(); startRunner();
};
$('batchStop').onclick = () => { if (runner) runner.stop(); };
$('batchResume').onclick = async () => {
  if (runner) return;
  let j = null; try { j = await idb.get('jobs', 'current'); } catch (e) { /* */ }
  if (!j) { toast('No saved job'); return; }
  if (j.nextIndex >= j.stores.length) { job = j; renderBatch(); toast('Saved job is already complete'); return; }
  if (!apiKey) { setStatus('stApi', 'No API key entered. Paste your HeiGIT API key to resume.', 'err'); toast('Enter your HeiGIT API key first'); job = j; renderBatch(); return; }
  job = j; job.message = ''; startRunner();
};
$('batchDiscard').onclick = async () => { if (runner) return toast('Stop the job first'); await idb.del('jobs', 'current'); job = null; renderBatch(); $('batchStatus').textContent = 'No batch job.'; $('batchBar').style.width = 0; };
$('batchCopy').onclick = async () => {
  if (!job) return; const tsv = toTSV(jobRows(job), BATCH_COLUMNS);
  try { await navigator.clipboard.writeText(tsv); toast('Copied ' + jobRows(job).length + ' rows — paste into Excel'); }
  catch (e) { const ta = document.createElement('textarea'); ta.value = tsv; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Copied'); }
};
$('batchCsv').onclick = () => job && download('batch_isochrone_catchments.csv', toCSV(jobRows(job), BATCH_COLUMNS), 'text/csv');
function batchFeatures() {
  const out = [];
  job.stores.forEach((s, i) => { const r = job.results[i]; if (!r || !r.contours) return;
    r.contours.forEach(c => { const row = r.rows.find(x => x.minutes === c.minutes) || {}; out.push({ geometry: c.geometry, properties: { ...row, name: s.name } }); }); });
  return out;
}
$('batchGeo').onclick = () => job && download('batch_isochrones.geojson', toGeoJSON(batchFeatures()), 'application/geo+json');
$('batchKml').onclick = () => job && download('batch_isochrones.kml', toKML(batchFeatures(), 'Batch isochrones'), 'application/vnd.google-earth.kml+xml');
$('batchShow').onclick = () => {
  batchGroup.clearLayers(); if (!job) return;
  const f = batchFeatures(); if (!f.length) return toast('No boundaries yet');
  const lay = L.geoJSON({ type: 'FeatureCollection', features: f.map(x => ({ type: 'Feature', properties: x.properties, geometry: x.geometry })) }, {
    pmIgnore: true, pane: 'isoPane', style: ft => ({ color: ISO_COLORS[ft.properties.minutes - 1], weight: 1, fillOpacity: 0.05 }),
    onEachFeature: (ft, l) => l.bindTooltip(`${esc(ft.properties.name)} · ${ft.properties.minutes} min`) }).addTo(batchGroup);
  map.fitBounds(lay.getBounds().pad(0.1));
};

// ------------------------------------------------------------------ RWI layer
let rwiLayer = null;
$('showRwi').onchange = async e => {
  if (!e.target.checked) { if (rwiLayer) map.removeLayer(rwiLayer); return; }
  if (!rwiLayer) {
    const r = await fetch('data/rwi.json?v=' + (manifest && manifest.data_version)); const d = await r.json();
    const renderer = L.canvas({ padding: 0.5 }); rwiLayer = L.layerGroup();
    const col = v => v < -0.5 ? '#b2182b' : v < -0.15 ? '#ef8a62' : v < 0.15 ? '#f7f7f7' : v < 0.5 ? '#67a9cf' : '#2166ac';
    for (let i = 0; i < d.lat.length; i++) L.circleMarker([d.lat[i], d.lon[i]], { renderer, radius: 3, weight: 0.5, color: '#555', fillColor: col(d.rwi[i]), fillOpacity: 0.85, pmIgnore: true, interactive: false }).addTo(rwiLayer);
  }
  rwiLayer.addTo(map);
};
$('maxDist').onchange = async () => {
  if (workGeometry()) recalcWork();
  if (iso && dataReady) { const maxD = maxDistM(); iso.stats = await aggregateMany(iso.contours.map(c => c.geometry), 'Isochrones 1–10 min', maxD); iso.maxDistM = maxD; renderIso(); }
};

// ------------------------------------------------------------------ boot
(async function boot() {
  updateDirLabels();
  renderSaved();
  try { const j = await idb.get('jobs', 'current'); if (j) { job = j; if (job.state === 'running') job.state = 'stopped'; renderBatch(); if (j.nextIndex < j.stores.length) $('batchStatus').innerHTML += '<br>Saved progress found — press <b>Resume saved job</b> (API key required).'; } } catch (e) { /* */ }
  await loadData();
})();

// test hook (no secrets exposed)
window.__mci = { BUILD, endpoint: HEIGIT_ISOCHRONES_ENDPOINT, aggregateMany, setWorkGeometry, getState: () => ({ dataReady, iso, job, workStats }), hasKey: () => !!apiKey };
