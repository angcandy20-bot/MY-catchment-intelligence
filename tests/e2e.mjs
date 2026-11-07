// End-to-end browser tests (Playwright/Chromium).
// Usage: node tests/e2e.mjs <baseUrl> <local|live> <out.json> [py_check.json]
// Kinds in the report:
//   real           -> real network: OpenStreetMap tiles, real data files, real HeiGIT endpoint (invalid-key probe)
//   real-api       -> real HeiGIT isochrone calls (only if HEIGIT_API_KEY secret is provided)
//   real-data      -> browser calculation compared with the independent raster check
//   simulated-api  -> HeiGIT responses mocked inside the browser (request shape, UI, batch logic) — NOT real API results
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { chromium } from 'playwright';

const [BASE, MODE = 'local', OUT = 'e2e.json', PYCHECK] = process.argv.slice(2);
const ENDPOINT = 'https://api.heigit.org/openrouteservice/v2/isochrones/driving-car';
const KEY = process.env.HEIGIT_API_KEY || '';
const FAKE_KEY = 'TESTKEY-SHOULD-NOT-PERSIST-7f3a';
const results = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
async function test(kind, name, fn) {
  try { const detail = await fn(); results.push({ kind, name, pass: true, detail: detail || '' }); console.log('PASS', `[${kind}]`, name, detail || ''); }
  catch (e) { results.push({ kind, name, pass: false, detail: String(e.message || e).slice(0, 400) }); console.log('FAIL', `[${kind}]`, name, e.message); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
let page = await ctx.newPage();
const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e)));

// ---- OSM tiles: track requests/responses and Referer
const tileReqs = [];
page.on('requestfinished', async req => {
  if (!req.url().startsWith('https://tile.openstreetmap.org/')) return;
  const res = await req.response(); const h = await req.allHeaders();
  tileReqs.push({ status: res && res.status(), type: res && res.headers()['content-type'], referer: h.referer || h.Referer || '', cache: res && res.headers()['cache-control'] });
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__mci && window.__mci.getState().dataReady, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(4000);

await test('real', 'OpenStreetMap basemap tiles load (HTTP 200 PNG) with a valid Referer', async () => {
  assert(tileReqs.length > 0, 'no tile requests seen');
  const ok = tileReqs.filter(t => t.status === 200 && /image\/png/.test(t.type || ''));
  assert(ok.length >= 4, `only ${ok.length}/${tileReqs.length} tiles OK; statuses ${[...new Set(tileReqs.map(t => t.status))]}`);
  const origin = new URL(BASE).origin;
  assert(ok.every(t => t.referer.startsWith(origin)), 'Referer missing or wrong: ' + ok[0].referer);
  const st = await page.textContent('#stBase');
  return `${ok.length} tiles 200 · Referer ${ok[0].referer} · Cache-Control "${ok[0].cache}" · status line: "${st}"`;
});
await test('real', 'OpenStreetMap attribution visible', async () => {
  const t = await page.textContent('.leaflet-control-attribution');
  assert(/OpenStreetMap/.test(t) && await page.isVisible('.leaflet-control-attribution'), 'attribution missing: ' + t);
  return t.trim();
});
await test('real', 'separate status lines for basemap, API and aggregation', async () => {
  const s = await page.evaluate(() => ['stBase', 'stApi', 'stAgg'].map(i => document.getElementById(i).textContent));
  assert(s.every(Boolean), 'empty status'); return s.join(' | ');
});
await test('real', 'population/RWI data manifest loads and aggregation is ready', async () => {
  const st = await page.evaluate(() => window.__mci.getState().dataReady);
  assert(st, 'data not ready: ' + await page.textContent('#stAgg')); return await page.textContent('#stAgg');
});

// ---- real-data: browser calculation vs independent raster check
if (PYCHECK && fs.existsSync(PYCHECK)) {
  const py = JSON.parse(fs.readFileSync(PYCHECK));
  for (const s of py.filter(x => /hole|MultiPolygon|KLCC/.test(x.name))) {
    await test('real-data', `Browser (worker) result equals independent raster check: ${s.name}`, async () => {
      const [r] = await page.evaluate(g => window.__mci.aggregateMany([g], 'e2e', 3000), s.geometry);
      const rel = s.population > 0 ? Math.abs(r.population - s.population) / s.population : r.population;
      assert(rel <= 0.002, `population ${r.population} vs ${s.population}`);
      if (s.population_weighted_rwi === null) assert(r.population_weighted_rwi === null, 'expected No data');
      else assert(Math.abs(r.population_weighted_rwi - s.population_weighted_rwi) <= 0.002, `rwi ${r.population_weighted_rwi} vs ${s.population_weighted_rwi}`);
      return `pop ${r.population.toFixed(0)} vs ${s.population.toFixed(0)}, RWI ${r.population_weighted_rwi?.toFixed(4)} vs ${s.population_weighted_rwi?.toFixed(4)}`;
    });
  }
}

// ---- GeoJSON import with a hole (UI path)
await test(MODE === 'live' ? 'real' : 'real', 'GeoJSON import (Polygon with hole) → statistics shown', async () => {
  const f = path.join(tmp, 'hole.geojson');
  fs.writeFileSync(f, JSON.stringify({ type: 'Feature', properties: { name: 'Hole test' }, geometry: { type: 'Polygon', coordinates: [[[101.690, 3.140], [101.725, 3.140], [101.725, 3.170], [101.690, 3.170], [101.690, 3.140]], [[101.710, 3.152], [101.710, 3.158], [101.717, 3.158], [101.717, 3.152], [101.710, 3.152]]] } }));
  await page.setInputFiles('#gjFile', f);
  await page.waitForFunction(() => window.__mci.getState().workStats, null, { timeout: 60000 });
  const msg = await page.textContent('#importMsg'); assert(/1 hole/.test(msg), msg);
  const txt = await page.textContent('#workStats'); return msg + ' · ' + txt.replace(/\s+/g, ' ').slice(0, 160);
});
await test('real', 'coordinate search "lat, lon" sets the store point', async () => {
  await page.fill('#coordIn', '3.1579, 101.7116'); await page.click('#coordGo');
  const t = await page.textContent('#isoPoint'); assert(t.includes('3.157900, 101.711600'), t); return t;
});
await test('real', 'save, rename, reopen and compare catchments', async () => {
  await page.fill('#workName', 'E2E catchment'); await page.click('#saveWork');
  await page.click('[data-tab=saved]'); await page.waitForSelector('[data-rename]');
  const inp = page.locator('[data-rename]').last(); await inp.fill('E2E renamed'); await inp.dispatchEvent('change');
  await page.waitForTimeout(300);
  const cmp = await page.textContent('#cmpTable'); assert(cmp.includes('E2E renamed'), 'compare table missing');
  await page.locator('[data-open]').last().click(); assert(await page.inputValue('#workName') === 'E2E renamed', 'reopen name');
  const [d1] = await Promise.all([page.waitForEvent('download'), (async () => { await page.click('[data-tab=saved]'); await page.click('#cmpKml'); })()]);
  const k = fs.readFileSync(await d1.path(), 'utf8'); assert(k.includes('<innerBoundaryIs>'), 'KML hole missing');
  await page.click('[data-tab=catchment]'); return 'KML export contains innerBoundaryIs';
});

await test('real', 'map buttons: "Clear polygon" removes the polygon; "Clear map" removes polygon, pin and overlays', async () => {
  await page.click('[data-tab=catchment]');
  await page.evaluate(() => window.__mci.setWorkGeometry({ type: 'Polygon', coordinates: [[[101.70, 3.15], [101.72, 3.15], [101.72, 3.17], [101.70, 3.17], [101.70, 3.15]]] }, 'to clear', 'drawn'));
  await page.waitForFunction(() => window.__mci.getState().workParts > 0);
  assert(await page.isVisible('#mcPoly') && await page.isVisible('#mcAll'), 'buttons not visible on map');
  await page.click('#mcPoly');
  let st = await page.evaluate(() => window.__mci.getState());
  assert(st.workParts === 0 && st.workStats === null, 'polygon not cleared');
  assert((await page.textContent('#workStats')).includes('No polygon'), 'stats panel not reset');
  await page.evaluate(() => window.__mci.setWorkGeometry({ type: 'Polygon', coordinates: [[[101.70, 3.15], [101.72, 3.15], [101.72, 3.17], [101.70, 3.17], [101.70, 3.15]]] }, 'again', 'drawn'));
  await page.fill('#coordIn', '3.1579, 101.7116'); await page.click('#coordGo');
  const savedBefore = await page.locator('[data-rename]').count();
  await page.click('#mcAll');
  st = await page.evaluate(() => window.__mci.getState());
  assert(st.workParts === 0 && st.point === null && st.iso === null && st.isoLayers === 0 && st.batchLayers === 0, 'map not cleared: ' + JSON.stringify({ w: st.workParts, p: st.point, i: st.isoLayers }));
  assert(await page.locator('.leaflet-marker-icon').count() === 0, 'pin still on map');
  assert(await page.locator('[data-rename]').count() === savedBefore, 'saved catchments were affected');
  return 'polygon cleared; map cleared (pin, overlays); saved catchments kept';
});

// ---- Real HeiGIT endpoint probe without a valid key (connectivity, CORS, error classification)
await test('real', 'HeiGIT endpoint reachable from the browser; invalid key gives a clear message', async () => {
  const r = await page.evaluate(async (u) => {
    try { const res = await fetch(u, { method: 'POST', headers: { Authorization: 'invalid-key-for-probe', 'Content-Type': 'application/json' }, body: JSON.stringify({ locations: [[101.7116, 3.1579]], location_type: 'destination', range_type: 'time', range: [600], interval: 60 }) });
      return { status: res.status, body: (await res.text()).slice(0, 200) }; } catch (e) { return { error: String(e) }; }
  }, ENDPOINT);
  assert(!r.error, 'fetch failed (network/CORS): ' + r.error);
  assert([401, 403].includes(r.status), 'unexpected status ' + r.status + ' ' + r.body);
  return `HTTP ${r.status}: ${r.body.replace(/\s+/g, ' ')} → shown to users as the "${r.status === 401 ? 'invalid key' : 'refused key / no Isochrones access'}" message`;
});

await test('real', 'HeiGIT foot-walking endpoint reachable from the browser; invalid key gives a clear message', async () => {
  const r = await page.evaluate(async (u) => {
    try { const res = await fetch(u, { method: 'POST', headers: { Authorization: 'invalid-key-for-probe', 'Content-Type': 'application/json' }, body: JSON.stringify({ locations: [[101.7116, 3.1579]], location_type: 'start', range_type: 'distance', range: [200] }) });
      return { status: res.status, body: (await res.text()).slice(0, 200) }; } catch (e) { return { error: String(e) }; }
  }, ENDPOINT.replace('driving-car', 'foot-walking'));
  assert(!r.error, 'fetch failed (network/CORS): ' + r.error);
  assert([401, 403].includes(r.status), 'unexpected status ' + r.status + ' ' + r.body);
  return `HTTP ${r.status}: ${r.body.replace(/\s+/g, ' ')}`;
});
if (KEY) {
  await test('real-api', 'Real HeiGIT walking area 200 m: one request, polygon smaller than the 200 m circle', async () => {
    const reqs = []; const h = r => { if (r.url().endsWith('/foot-walking')) reqs.push(r.postDataJSON()); };
    page.on('request', h);
    await page.click('[data-tab=catchment]'); await page.fill('#coordIn', '3.1490, 101.7130'); await page.click('#coordGo');
    await page.click('[data-tab=iso]'); await page.fill('#apiKey', KEY); await page.check('input[name=mode][value=walk]');
    await page.click('#isoGo');
    await page.waitForFunction(() => { const s = window.__mci.getState().iso; return s && s.mode === 'walk' && s.stats; }, null, { timeout: 90000 });
    page.off('request', h);
    const s = await page.evaluate(() => window.__mci.getState().iso);
    assert(reqs.length === 1 && reqs[0].range_type === 'distance' && reqs[0].range[0] === 200, JSON.stringify(reqs));
    assert(s.stats[0].area_km2 > 0 && s.stats[0].area_km2 < Math.PI * 0.2 * 0.2, 'area ' + s.stats[0].area_km2);
    await page.check('input[name=mode][value=drive]');
    return `area ${s.stats[0].area_km2.toFixed(4)} km² (circle would be 0.1257), population ${s.stats[0].population.toFixed(0)}`;
  });
}

// ---- Optional REAL API tests (only with HEIGIT_API_KEY secret). The key is typed into the page, never printed.
if (KEY) {
  for (const dir of ['to', 'from']) {
    await test('real-api', `Real HeiGIT isochrones, direction ${dir}: one request, 10 contours`, async () => {
      const reqs = []; const h = r => { if (r.url() === ENDPOINT) reqs.push(r.postDataJSON()); };
      page.on('request', h);
      await page.click('[data-tab=iso]'); await page.fill('#apiKey', KEY);
      await page.check(`input[name=dir][value=${dir}]`);
      await page.click('[data-tab=catchment]'); await page.fill('#coordIn', dir === 'to' ? '3.1579, 101.7116' : '3.1580, 101.7117'); await page.click('#coordGo'); await page.click('[data-tab=iso]');
      await page.click('#isoGo');
      await page.waitForFunction(() => { const s = window.__mci.getState().iso; return s && s.stats; }, null, { timeout: 90000 });
      page.off('request', h);
      const s = await page.evaluate(() => window.__mci.getState().iso);
      assert(reqs.length === 1, 'requests: ' + reqs.length);
      assert(reqs[0].location_type === (dir === 'to' ? 'destination' : 'start'), 'location_type ' + reqs[0].location_type);
      assert(reqs[0].locations[0][0] > 100 && reqs[0].locations[0][1] < 10, 'coordinate order wrong');
      assert(s.contours.length === 10, 'contours ' + s.contours.length);
      const pops = s.stats.map(x => x.population);
      for (let i = 1; i < 10; i++) assert(pops[i] >= pops[i - 1] - 1, 'populations not cumulative');
      for (const m of [3, 7, 'all']) await page.click(`#minBar button[data-m="${m}"]`);
      return `10 contours; population 1 min ${pops[0].toFixed(0)} → 10 min ${pops[9].toFixed(0)}; minute switching made no extra requests`;
    });
  }
}

// ---- SIMULATED API tests (mocked responses inside the browser)
if (MODE === 'local') {
  const clearDB = () => page.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('mci-dashboard'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  const calls = []; const served = [];
  let mode = 'ok';
  const square = (lon, lat, h) => [[[lon - h, lat - h], [lon + h, lat - h], [lon + h, lat + h], [lon - h, lat + h], [lon - h, lat - h]]];
  await page.route(ENDPOINT, async route => {
    const req = route.request(); const body = req.postDataJSON(); calls.push({ body, auth: req.headers()['authorization'] });
    if (mode === '401') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Access to this API has been disallowed"}' });
    if (mode === '403') return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Access to this API has been disallowed"}' });
    if (mode === 'quota') return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"Quota exceeded"}' });
    if (mode === 'net') return route.abort('failed');
    if (mode === 'rate1') { mode = 'ok'; return route.fulfill({ status: 429, headers: { 'retry-after': '3' }, contentType: 'application/json', body: '{"error":"Rate Limit Exceeded"}' }); }
    if (mode === 'slow') await new Promise(r => setTimeout(r, 1500));
    const [lon, lat] = body.locations[0];
    const feats = [600, 540, 480, 420, 360, 300, 240, 180, 120, 60].map(v => ({ type: 'Feature', properties: { group_index: 0, value: v, center: [lon, lat] }, geometry: { type: 'Polygon', coordinates: square(lon, lat, v / 60 * 0.004) } }));
    try { await route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify({ type: 'FeatureCollection', features: feats }) }); served.push(body); } catch (e) { /* request aborted by Stop */ }
  });
  const errFor = async (m, re) => {
    mode = m; await clearDB();
    await page.click('[data-tab=catchment]'); await page.fill('#coordIn', `3.${Math.floor(Math.random() * 9000) + 1000}, 101.70`); await page.click('#coordGo'); await page.click('[data-tab=iso]');
    await page.click('#isoGo'); await page.waitForTimeout(800);
    const t = await page.textContent('#stApi'); assert(re.test(t), `${m}: "${t}"`); return t;
  };
  await test('simulated-api', 'missing key message (no request sent)', async () => {
    await page.click('[data-tab=iso]'); await page.fill('#apiKey', ''); await page.dispatchEvent('#apiKey', 'input');
    const n = calls.length; await page.click('#isoGo'); await page.waitForTimeout(500);
    const t = await page.textContent('#stApi'); assert(/No API key/i.test(t) && calls.length === n, t); return t;
  });
  await page.fill('#apiKey', FAKE_KEY);
  await test('simulated-api', 'invalid key (401) message', () => errFor('401', /rejected|invalid/i));
  await test('simulated-api', 'refused key / insufficient permissions (403) message', () => errFor('403', /invalid.*Isochrones access/i));
  await test('simulated-api', 'exhausted quota message', () => errFor('quota', /quota/i));
  await test('simulated-api', 'connection failure message', () => errFor('net', /connect/i));
  mode = 'ok';
  await test('simulated-api', 'arrival request: endpoint, [lon,lat], destination, range 600, interval 60, one call; minute switching makes no calls', async () => {
    await clearDB();
    await page.click('[data-tab=catchment]'); await page.fill('#coordIn', '3.1579, 101.7116'); await page.click('#coordGo'); await page.click('[data-tab=iso]');
    await page.check('input[name=dir][value=to]');
    const n = calls.length; await page.click('#isoGo');
    await page.waitForFunction(() => { const s = window.__mci.getState().iso; return s && s.stats && s.direction === 'to'; }, null, { timeout: 60000 });
    const b = calls[calls.length - 1].body;
    assert(calls.length === n + 1, 'calls ' + (calls.length - n));
    assert(JSON.stringify(b) === JSON.stringify({ locations: [[101.7116, 3.1579]], location_type: 'destination', range_type: 'time', range: [600], interval: 60 }), JSON.stringify(b));
    assert(calls[calls.length - 1].auth === FAKE_KEY, 'Authorization header');
    for (const m of [1, 5, 10, 'all', 2]) await page.click(`#minBar button[data-m="${m}"]`);
    assert(calls.length === n + 1, 'minute switching triggered API calls');
    const rows = await page.locator('#isoTable tr[data-m]').count(); assert(rows === 10, 'rows ' + rows);
    assert((await page.textContent('#isoDirLbl')).includes('TO the store'), 'direction label');
    return JSON.stringify(b);
  });
  await test('simulated-api', 'departure request uses location_type "start" and is labelled FROM', async () => {
    await page.check('input[name=dir][value=from]'); await page.click('#isoGo');
    await page.waitForFunction(() => { const s = window.__mci.getState().iso; return s && s.direction === 'from'; }, null, { timeout: 60000 });
    const b = calls[calls.length - 1].body; assert(b.location_type === 'start', b.location_type);
    assert((await page.textContent('#isoDirLbl')).includes('FROM the store'), 'label'); await page.check('input[name=dir][value=to]');
    return JSON.stringify(b);
  });
  await test('simulated-api', 'batch: N×10 rows in order, invalid row flagged, rate-limit pause, exports', async () => {
    await clearDB();
    await page.reload(); await page.waitForFunction(() => window.__mci && window.__mci.getState().dataReady, null, { timeout: 120000 });
    await page.click('[data-tab=batch]'); await page.fill('#apiKey', FAKE_KEY); await page.dispatchEvent('#apiKey', 'input');
    await page.fill('#batchIn', 'name,latitude,longitude\nKLCC,3.1579,101.7116\nBroken,abc,101.7\nMid Valley,3.1181,101.6770\n'); await page.dispatchEvent('#batchIn', 'input');
    mode = 'rate1'; const n = calls.length;
    await page.click('#batchStart');
    await page.waitForFunction(() => { const j = window.__mci.getState().job; return j && j.state === 'done'; }, null, { timeout: 120000 });
    const j = await page.evaluate(() => window.__mci.getState().job);
    assert(calls.length - n === 3, 'API calls ' + (calls.length - n) + ' (2 stores + 1 rate-limited retry expected)');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#batchCsv')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8').trim().split(/\r?\n/);
    assert(csv.length === 31, 'csv lines ' + csv.length);
    assert(csv[0] === 'name,latitude,longitude,minutes,direction,population,population_weighted_rwi,wealth_coverage,area_km2,population_density,status', csv[0]);
    const names = csv.slice(1).map(l => l.split(',')[0]); assert(names.slice(0, 10).every(x => x === 'KLCC') && names[10] === 'Broken' && names[29] === 'Mid Valley', 'order');
    assert(csv.slice(1, 11).map(l => l.split(',')[3]).join() === '1,2,3,4,5,6,7,8,9,10', 'minutes order');
    assert(csv[11].includes('failed: invalid coordinates'), 'invalid flagged');
    const [g] = await Promise.all([page.waitForEvent('download'), page.click('#batchGeo')]);
    const gj = JSON.parse(fs.readFileSync(await g.path(), 'utf8')); assert(gj.features.length === 20, 'geojson features ' + gj.features.length);
    const [k] = await Promise.all([page.waitForEvent('download'), page.click('#batchKml')]);
    const kml = fs.readFileSync(await k.path(), 'utf8'); assert((kml.match(/<Placemark>/g) || []).length === 20, 'kml placemarks');
    await page.click('#batchCopy'); const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert(clip.split('\n').length === 31 && clip.includes('\t'), 'clipboard TSV');
    for (const f of [csv.join('\n'), JSON.stringify(gj), kml, clip]) assert(!f.includes(FAKE_KEY), 'API key leaked into export');
    return `30 rows; 1 rate-limit pause; CSV/GeoJSON(20)/KML(20)/clipboard OK; status of KLCC 10 min: ${j.results[0].rows[9].status}`;
  });
  await test('simulated-api', 'batch: stop, reload page, resume continues without repeating completed stores (cache)', async () => {
    await clearDB();
    await page.reload(); await page.waitForFunction(() => window.__mci && window.__mci.getState().dataReady, null, { timeout: 120000 });
    await page.click('[data-tab=batch]'); await page.fill('#apiKey', FAKE_KEY); await page.dispatchEvent('#apiKey', 'input');
    await page.fill('#batchIn', 'name,latitude,longitude\nS1,3.10,101.60\nS2,3.11,101.61\nS3,3.12,101.62\nS4,3.13,101.63\n'); await page.dispatchEvent('#batchIn', 'input');
    mode = 'slow'; const n = served.length;
    await page.click('#batchStart');
    await page.waitForFunction(() => { const j = window.__mci.getState().job; return j && j.nextIndex >= 1; }, null, { timeout: 60000 });
    await page.click('#batchStop');
    await page.waitForFunction(() => { const j = window.__mci.getState().job; return j && j.state === 'stopped'; }, null, { timeout: 60000 });
    const done1 = await page.evaluate(() => window.__mci.getState().job.nextIndex);
    await page.reload(); await page.waitForFunction(() => window.__mci && window.__mci.getState().dataReady, null, { timeout: 120000 });
    assert(!(await page.evaluate(() => window.__mci.hasKey())), 'key survived reload');
    await page.click('[data-tab=batch]'); await page.fill('#apiKey', FAKE_KEY); await page.dispatchEvent('#apiKey', 'input');
    mode = 'ok'; await page.click('#batchResume');
    await page.waitForFunction(() => { const j = window.__mci.getState().job; return j && j.state === 'done'; }, null, { timeout: 120000 });
    const bodies = served.slice(n).map(b => b.locations[0][1]);
    assert(new Set(bodies).size === bodies.length && bodies.length === 4, 'repeated/missing completed calls: ' + JSON.stringify(bodies));
    return `stopped after ${done1} store(s); resumed after reload; 4 completed API calls, none repeated (a request cancelled by Stop is re-sent once)`;
  });
  const walkCalls = [];
  await page.route(ENDPOINT.replace('driving-car', 'foot-walking'), async route => {
    const body = route.request().postDataJSON(); walkCalls.push(body);
    const d = body.range[0] / 111320;
    const feats = body.locations.map(([lon, lat], gi) => ({ type: 'Feature', properties: { group_index: gi, value: body.range[0], center: [lon, lat] },
      geometry: { type: 'Polygon', coordinates: [[[lon - d, lat], [lon, lat - d], [lon + d, lat], [lon, lat + d], [lon - d, lat]]] } }));
    await route.fulfill({ status: 200, contentType: 'application/geo+json', body: JSON.stringify({ type: 'FeatureCollection', features: feats }) });
  });
  await test('simulated-api', 'walking 200 m (single): foot-walking request, one area, stats, labelled, exports', async () => {
    await clearDB(); await page.reload(); await page.waitForFunction(() => window.__mci && window.__mci.getState().dataReady, null, { timeout: 120000 });
    await page.click('[data-tab=catchment]'); await page.fill('#coordIn', '3.1490, 101.7130'); await page.click('#coordGo');
    await page.click('[data-tab=iso]'); await page.fill('#apiKey', FAKE_KEY); await page.dispatchEvent('#apiKey', 'input');
    await page.check('input[name=mode][value=walk]');
    assert(await page.isHidden('#dirBox') && await page.isVisible('#walkM'), 'walk controls');
    assert((await page.textContent('#isoDirLbl')).includes('Walking 200 m'), 'label');
    const n = walkCalls.length; await page.click('#isoGo');
    await page.waitForFunction(() => { const s = window.__mci.getState().iso; return s && s.mode === 'walk' && s.stats; }, null, { timeout: 60000 });
    const b = walkCalls[walkCalls.length - 1];
    assert(walkCalls.length === n + 1, 'calls'); assert(JSON.stringify(b) === JSON.stringify({ locations: [[101.713, 3.149]], location_type: 'start', range_type: 'distance', range: [200] }), JSON.stringify(b));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#isoCsv')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8'); assert(dl.suggestedFilename() === 'walking_200m.csv' && csv.includes('walk_distance_m'), dl.suggestedFilename());
    const st = await page.evaluate(() => window.__mci.getState().iso.stats[0]);
    return `${JSON.stringify(b)} · area ${st.area_km2.toFixed(4)} km² · population ${st.population.toFixed(0)}`;
  });
  await test('simulated-api', 'walking batch: 7 buildings (1 invalid) → 2 requests of ≤5 locations, 7 rows in order, exports', async () => {
    await page.click('[data-tab=batch]');
    await page.fill('#batchIn', 'name,latitude,longitude\nW1,3.1490,101.7130\nW2,3.1500,101.7140\nBad,x,101\nW3,3.1510,101.7150\nW4,3.1520,101.7160\nW5,3.1530,101.7170\nW6,3.1540,101.7180\n');
    await page.dispatchEvent('#batchIn', 'input'); await page.waitForTimeout(400);
    const n = walkCalls.length; await page.click('#batchStart');
    await page.waitForFunction(() => { const j = window.__mci.getState().job; return j && j.state === 'done'; }, null, { timeout: 120000 });
    const calls = walkCalls.slice(n);
    // W1 already cached from the single test, so: [W2..W6] in one request
    assert(calls.every(c => c.locations.length <= 5), 'max 5'); 
    const locs = calls.flatMap(c => c.locations.map(l => l[1]));
    assert(new Set(locs).size === locs.length && locs.length === 5, 'unique uncached locations ' + JSON.stringify(locs));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#batchCsv')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8').trim().split(/\r?\n/);
    assert(csv[0] === 'name,latitude,longitude,walk_distance_m,population,population_weighted_rwi,wealth_coverage,area_km2,population_density,status', csv[0]);
    assert(csv.length === 8 && csv.slice(1).map(l => l.split(',')[0]).join() === 'W1,W2,Bad,W3,W4,W5,W6', 'rows/order');
    assert(csv[3].includes('failed: invalid coordinates'), 'invalid flagged');
    const [g] = await Promise.all([page.waitForEvent('download'), page.click('#batchGeo')]);
    const gj = JSON.parse(fs.readFileSync(await g.path(), 'utf8')); assert(gj.features.length === 6 && gj.features[0].properties.walk_distance_m === 200, 'geojson');
    const [k] = await Promise.all([page.waitForEvent('download'), page.click('#batchKml')]);
    assert((fs.readFileSync(await k.path(), 'utf8').match(/<Placemark>/g) || []).length === 6, 'kml');
    await page.click('#batchShow');
    await page.click('[data-tab=iso]'); await page.check('input[name=mode][value=drive]');
    return `${calls.length} request(s) with ${calls.map(c => c.locations.length).join('+')} locations (W1 reused from cache); 7 rows; GeoJSON/KML 6 areas`;
  });
  await test('simulated-api', 'API key is not stored in localStorage, sessionStorage, IndexedDB or cookies', async () => {
    await page.fill('#apiKey', FAKE_KEY); await page.dispatchEvent('#apiKey', 'input');
    const dump = await page.evaluate(async () => {
      const out = [JSON.stringify(localStorage), JSON.stringify(sessionStorage), document.cookie];
      const db = await new Promise(r => { const q = indexedDB.open('mci-dashboard'); q.onsuccess = () => r(q.result); q.onerror = () => r(null); });
      if (db) for (const s of db.objectStoreNames) out.push(JSON.stringify(await new Promise(r => { const t = db.transaction(s).objectStore(s).getAll(); t.onsuccess = () => r(t.result); })));
      return out.join('\n');
    });
    assert(!dump.includes(FAKE_KEY), 'key found in browser storage'); return 'not found in any storage';
  });
}
await test('real', 'no uncaught page errors', async () => { assert(!consoleErrors.length, consoleErrors.join(' | ')); return 'none'; });

await browser.close();
fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed (${MODE})`);
process.exit(failed.length ? 1 : 0);
