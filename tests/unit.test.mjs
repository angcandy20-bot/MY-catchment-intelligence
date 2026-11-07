// Local unit tests. Run: node tests/unit.test.mjs /tmp/synth
// API tests here are SIMULATED (mocked fetch). They check request shape and error handling, not the live service.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseTile, aggregateGeometry, polygonsAreaM2 } from '../site/js/core/aggregate.js';
import { requestIsochrones, buildIsochroneBody, HEIGIT_ISOCHRONES_ENDPOINT, parseContours } from '../site/js/core/heigit.js';
import { parseLatLon, parseStoresTable, importGeoJSON, toCSV, toKML, toTSV } from '../site/js/core/geo.js';
import { BatchRunner, newJob, jobRows, BATCH_COLUMNS } from '../site/js/core/batch.js';

const results = [];
async function test(kind, name, fn) {
  try { await fn(); results.push({ kind, name, pass: true }); console.log('PASS', `[${kind}]`, name); }
  catch (e) { results.push({ kind, name, pass: false, detail: e.message }); console.log('FAIL', `[${kind}]`, name, '\n   ', e.message); }
}
const close = (a, b, tol, msg) => { if (a === null || b === null) return assert.equal(a, b, msg); assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`); };

const synth = process.argv[2] || '/tmp/synth';

// ---------- aggregation vs independent expected (synthetic data)
const manifest = JSON.parse(fs.readFileSync(path.join(synth, 'manifest.json')));
const { cases, expected } = JSON.parse(fs.readFileSync(path.join(synth, 'expected.json')));
const loadTile = async t => { const b = fs.readFileSync(path.join(synth, t.file)); return parseTile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
for (const [name, g] of Object.entries(cases)) {
  for (const thr of [3000, 1000]) {
    await test('synthetic-data', `aggregation ${name} @${thr} m matches independent brute force`, async () => {
      const got = await aggregateGeometry(g, manifest, loadTile, thr);
      const exp = expected[`${name}@${thr}`];
      assert.equal(got.cells, exp.cells, 'cell count');
      close(got.population, exp.population, Math.max(0.01, exp.population * 1e-5), 'population');
      close(got.matched_population, exp.matched_population, Math.max(0.01, exp.matched_population * 1e-4), 'matched pop');
      close(got.population_weighted_rwi, exp.population_weighted_rwi, 2e-4, 'pw rwi');
      close(got.wealth_coverage, exp.wealth_coverage, 2e-4, 'coverage');
      if (exp.population === 0) { assert.equal(got.population_weighted_rwi, null, 'No data, not zero'); assert.equal(got.wealth_coverage, null); }
    });
  }
}
await test('unit', 'unmatched cells count in population but not RWI (coverage < 1)', async () => {
  const got = await aggregateGeometry(cases.outside_rwi_area_unmatched, manifest, loadTile, 3000);
  assert.ok(got.population > 0); assert.equal(got.population_weighted_rwi, null); assert.equal(got.wealth_coverage, 0);
});
await test('unit', 'geodesic area of 0.01° square at equator ≈ 1.2364 km²', async () => {
  const a = polygonsAreaM2([[[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]]]) / 1e6;
  close(a, 1.2364, 0.002, 'area');
});
await test('unit', 'area subtracts holes', async () => {
  const outer = [[0, 0], [0.02, 0], [0.02, 0.02], [0, 0.02], [0, 0]], hole = [[0.005, 0.005], [0.015, 0.005], [0.015, 0.015], [0.005, 0.015], [0.005, 0.005]];
  const a = polygonsAreaM2([[outer, hole]]), b = polygonsAreaM2([[outer]]), c = polygonsAreaM2([[hole]]);
  close(a, b - c, 1, 'hole');
});

// ---------- HeiGIT client (SIMULATED)
const ok10 = (vals = [60, 120, 180, 240, 300, 360, 420, 480, 540, 600]) => ({ type: 'FeatureCollection', features: vals.map(v => ({ type: 'Feature', properties: { value: v, group_index: 0 }, geometry: { type: 'Polygon', coordinates: [[[101.7, 3.1], [101.71, 3.1], [101.71, 3.11], [101.7, 3.1]]] } })) });
const mockRes = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => headers[k.toLowerCase()] ?? null }, text: async () => typeof body === 'string' ? body : JSON.stringify(body), json: async () => body });

await test('simulated-api', 'request uses api.heigit.org endpoint, [lon,lat] order, destination, 600/60', async () => {
  let seen;
  const r = await requestIsochrones({ lat: 3.1579, lon: 101.7116, direction: 'to', apiKey: 'K', fetchImpl: async (u, o) => { seen = { u, o }; return mockRes(200, ok10()); } });
  assert.equal(seen.u, 'https://api.heigit.org/openrouteservice/v2/isochrones/driving-car');
  assert.ok(!seen.u.includes('api.openrouteservice.org'));
  const b = JSON.parse(seen.o.body);
  assert.deepEqual(b, { locations: [[101.7116, 3.1579]], location_type: 'destination', range_type: 'time', range: [600], interval: 60 });
  assert.equal(seen.o.headers.Authorization, 'K'); assert.equal(seen.o.method, 'POST');
  assert.equal(r.contours.length, 10); assert.deepEqual(r.contours.map(c => c.minutes), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
await test('simulated-api', 'FROM direction uses location_type "start"', async () => {
  assert.equal(buildIsochroneBody(3, 101, 'from').location_type, 'start');
  assert.equal(buildIsochroneBody(3, 101, 'to').location_type, 'destination');
});
await test('simulated-api', 'contours returned out of order are sorted 1..10', async () => {
  const c = parseContours(ok10([600, 60, 300, 120, 540, 180, 480, 240, 420, 360]));
  assert.deepEqual(c.map(x => x.minutes), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
const errCase = async (status, body, headers, kind) => {
  try { await requestIsochrones({ lat: 3, lon: 101, apiKey: 'K', fetchImpl: async () => mockRes(status, body, headers) }); assert.fail('should throw'); }
  catch (e) { assert.equal(e.kind, kind, `status ${status}: got ${e.kind}`); assert.ok(!String(e.message).includes('K ')); return e; }
};
await test('simulated-api', 'missing key → missing_key (no request made)', async () => {
  let called = false;
  try { await requestIsochrones({ lat: 3, lon: 101, apiKey: '', fetchImpl: async () => { called = true; } }); } catch (e) { assert.equal(e.kind, 'missing_key'); }
  assert.equal(called, false);
});
await test('simulated-api', '401 → invalid_key', () => errCase(401, { error: 'Access to this API has been disallowed' }, {}, 'invalid_key'));
await test('simulated-api', '403 → forbidden (insufficient permissions)', () => errCase(403, { error: 'Access to this API has been disallowed' }, {}, 'forbidden'));
await test('simulated-api', '403 with quota message → quota_exhausted', () => errCase(403, { error: 'Quota exceeded' }, {}, 'quota_exhausted'));
await test('simulated-api', '429 short reset → rate_limited with wait', async () => { const e = await errCase(429, { error: 'Rate Limit Exceeded' }, { 'retry-after': '20' }, 'rate_limited'); assert.ok(e.retryAfterMs >= 20000 && e.retryAfterMs <= 125000); });
await test('simulated-api', '429 quota message → quota_exhausted', () => errCase(429, { error: { message: 'Quota Exceeded' } }, {}, 'quota_exhausted'));
await test('simulated-api', '500 → server_error', () => errCase(502, 'Bad gateway', {}, 'server_error'));
await test('simulated-api', '400/404 routing error → bad_request', () => errCase(404, { error: { code: 3002, message: 'Unable to find a route point' } }, {}, 'bad_request'));
await test('simulated-api', 'network failure → network', async () => {
  try { await requestIsochrones({ lat: 3, lon: 101, apiKey: 'K', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }); } catch (e) { assert.equal(e.kind, 'network'); }
});
await test('simulated-api', 'only 9 contours → incomplete', () => errCase(200, ok10([60, 120, 180, 240, 300, 360, 420, 480, 540]), {}, 'incomplete'));

// ---------- parsing / exports
await test('unit', 'lat,lon parsing incl. swapped detection', async () => {
  assert.deepEqual([parseLatLon('3.1579, 101.7116').lat, parseLatLon('3.1579, 101.7116').lon], [3.1579, 101.7116]);
  assert.ok(parseLatLon('101.7116, 3.1579').error.includes('latitude'));
  assert.ok(parseLatLon('abc').error);
  assert.ok(parseLatLon('51.5, -0.1').warn);
});
await test('unit', 'store table parsing (CSV, TSV from Excel, quoted names, invalid rows)', async () => {
  const a = parseStoresTable('name,latitude,longitude\n"Store, A",3.1,101.6\nB,x,101\n');
  assert.equal(a.stores.length, 2); assert.equal(a.stores[0].name, 'Store, A'); assert.equal(a.stores[1].valid, false);
  const b = parseStoresTable('Name\tLat\tLng\r\nS1\t3.2\t101.7\r\n');
  assert.equal(b.stores[0].latitude, 3.2);
  assert.ok(parseStoresTable('a,b\n1,2').errors.length);
});
await test('unit', 'GeoJSON import: Polygon with hole, MultiPolygon, unclosed ring, non-polygon skipped', async () => {
  const fc = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { name: 'P' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]], [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.2]]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[2, 2], [3, 2], [3, 3], [2, 2]]]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }] };
  const r = importGeoJSON(JSON.stringify(fc));
  assert.equal(r.features.length, 2); assert.equal(r.skipped, 1); assert.equal(r.features[0].holes, 1);
  assert.deepEqual(r.features[0].geometry.coordinates[0].at(-1), [0, 0]); // closed
  assert.equal(r.features[1].geometry.type, 'MultiPolygon');
});
await test('unit', 'KML has outer + inner boundaries and MultiGeometry; CSV escapes', async () => {
  const k = toKML([{ geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]], [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.1]]], [[[2, 2], [3, 2], [3, 3], [2, 2]]]] }, properties: { name: 'A & B' } }]);
  assert.ok(k.includes('<MultiGeometry>') && k.includes('<innerBoundaryIs>') && k.includes('A &amp; B'));
  assert.equal(toCSV([{ a: 'x,"y"', b: null }], ['a', 'b']), 'a,b\r\n"x,""y""",\r\n');
  assert.ok(!toTSV([{ a: 'x\ty' }], ['a']).split('\n')[1].includes('\t'));
});

// ---------- batch engine (SIMULATED API)
const mem = {}; const save = async j => { mem.job = JSON.parse(JSON.stringify(j)); };
const stores = [{ name: 'A', latitude: 3.15, longitude: 101.7, valid: true }, { name: 'Bad', latitude: 'x', longitude: 101, valid: false, error: 'invalid coordinates' }, { name: 'C', latitude: 3.16, longitude: 101.71, valid: true }, { name: 'D', latitude: 3.17, longitude: 101.72, valid: true }];
const fakeAgg = async (g, maxD) => ({ population: 100 * (g.__m || 1), population_weighted_rwi: g.__m === 1 ? null : 0.1, wealth_coverage: g.__m === 1 ? null : 0.9, area_km2: g.__m, population_density: 100 });
const contoursFor = () => [10, 3, 1, 2, 4, 5, 6, 7, 8, 9].map(m => ({ minutes: m, geometry: { type: 'Polygon', coordinates: [], __m: m } }));
await test('simulated-api', 'batch: N×10 rows, store order kept, minutes 1..10, invalid row flagged', async () => {
  let calls = 0;
  const job = newJob({ stores, direction: 'to', maxDistM: 3000 });
  await new BatchRunner(job, { getContours: async () => { calls++; return { contours: contoursFor(), fromCache: false }; }, aggregate: fakeAgg, save, sleep: async () => {}, minIntervalMs: 0 }).run();
  const rows = jobRows(job);
  assert.equal(rows.length, 40); assert.equal(calls, 3);
  assert.deepEqual(rows.slice(0, 10).map(r => r.minutes), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual([...new Set(rows.map(r => r.name))], ['A', 'Bad', 'C', 'D']);
  assert.ok(rows[10].status.startsWith('failed: invalid'));
  assert.equal(rows[10].population, ''); // never fabricated
  assert.equal(rows[0].population_weighted_rwi, 'No data');
  assert.equal(rows[0].direction, 'to_store (arrival)');
  assert.deepEqual(Object.keys(rows[0]), BATCH_COLUMNS);
  assert.equal(job.state, 'done');
});
await test('simulated-api', 'batch: stop then resume continues from saved index without repeating calls', async () => {
  const called = [];
  const job = newJob({ stores, direction: 'from', maxDistM: 3000 });
  let runner;
  const gc = async (s) => { called.push(s.name); if (s.name === 'A') setTimeout(() => runner.stop(), 0); await new Promise(r => setTimeout(r, 5)); return { contours: contoursFor(), fromCache: false }; };
  runner = new BatchRunner(job, { getContours: gc, aggregate: fakeAgg, save, sleep: async () => {}, minIntervalMs: 0 });
  await runner.run();
  assert.equal(mem.job.state, 'stopped'); assert.equal(mem.job.nextIndex, 1);
  assert.ok(jobRows(mem.job)[30].status.startsWith('incomplete'));
  const resumed = mem.job;
  await new BatchRunner(resumed, { getContours: gc, aggregate: fakeAgg, save, sleep: async () => {}, minIntervalMs: 0 }).run();
  assert.deepEqual(called, ['A', 'C', 'D']); assert.equal(resumed.state, 'done');
  assert.equal(jobRows(resumed)[0].direction, 'from_store (departure)');
});
await test('simulated-api', 'batch: rate limit pauses for advised time (no rapid retries), then continues', async () => {
  const sleeps = []; let n = 0;
  const job = newJob({ stores: stores.slice(0, 1), direction: 'to', maxDistM: 3000 });
  await new BatchRunner(job, { getContours: async () => { n++; if (n === 1) { const e = new Error('rate'); e.kind = 'rate_limited'; e.retryAfterMs = 61000; throw e; } return { contours: contoursFor(), fromCache: false }; },
    aggregate: fakeAgg, save, sleep: async ms => { sleeps.push(ms); }, minIntervalMs: 3100 }).run();
  assert.equal(n, 2); assert.ok(sleeps.includes(61000), 'paused 61 s'); assert.equal(job.results[0].status, 'ok');
});
await test('simulated-api', 'batch: exhausted quota halts and keeps resume point', async () => {
  const job = newJob({ stores: stores.slice(2), direction: 'to', maxDistM: 3000 }); let n = 0;
  await new BatchRunner(job, { getContours: async () => { n++; if (n === 2) { const e = new Error('quota'); e.kind = 'quota_exhausted'; throw e; } return { contours: contoursFor(), fromCache: false }; }, aggregate: fakeAgg, save, sleep: async () => {}, minIntervalMs: 0 }).run();
  assert.equal(job.state, 'halted'); assert.equal(job.nextIndex, 1); assert.equal(n, 2);
  assert.ok(jobRows(job)[10].status.startsWith('incomplete'));
});
await test('simulated-api', 'batch: per-store API failure marks 10 failed rows and continues', async () => {
  const job = newJob({ stores: stores.slice(2), direction: 'to', maxDistM: 3000 });
  await new BatchRunner(job, { getContours: async s => { if (s.name === 'C') { const e = new Error('no route'); e.kind = 'bad_request'; throw e; } return { contours: contoursFor(), fromCache: true }; }, aggregate: fakeAgg, save, sleep: async () => {}, minIntervalMs: 0 }).run();
  const rows = jobRows(job); assert.equal(rows.filter(r => r.status.startsWith('failed')).length, 10); assert.equal(rows[11].status, 'ok'); assert.equal(rows[10].status, 'ok (no RWI match within threshold)');
});

const out = process.env.TEST_REPORT;
if (out) fs.writeFileSync(out, JSON.stringify(results, null, 1));
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
