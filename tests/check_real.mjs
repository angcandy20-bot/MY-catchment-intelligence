// Compare dashboard aggregation (tiles + scanline, Node) with the independent Python raster check.
// Usage: node tests/check_real.mjs site/data py_check.json out.json
import fs from 'node:fs'; import path from 'node:path';
import { parseTile, aggregateGeometry } from '../site/js/core/aggregate.js';
const [dataDir, pyPath, outPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json')));
const py = JSON.parse(fs.readFileSync(pyPath));
const areasPath = path.join(dataDir, 'areas.json');
const areas = fs.existsSync(areasPath) ? JSON.parse(fs.readFileSync(areasPath)).areas : null;
const distPath = path.join(dataDir, 'districts.json');
const districts = fs.existsSync(distPath) ? JSON.parse(fs.readFileSync(distPath)).districts : null;
const cache = {};
const load = async t => cache[t.id] ??= (b => parseTile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))(fs.readFileSync(path.join(dataDir, t.file)));
const checks = [];
for (const s of py) {
  const js = await aggregateGeometry(s.geometry, manifest, load, 3000, null, areas, districts);
  const relPop = s.population > 0 ? Math.abs(js.population - s.population) / s.population : Math.abs(js.population);
  const dR = (s.population_weighted_rwi === null || js.population_weighted_rwi === null) ? (s.population_weighted_rwi === js.population_weighted_rwi ? 0 : Infinity) : Math.abs(js.population_weighted_rwi - s.population_weighted_rwi);
  const dC = (s.wealth_coverage === null || js.wealth_coverage === null) ? (s.wealth_coverage === js.wealth_coverage ? 0 : Infinity) : Math.abs(js.wealth_coverage - s.wealth_coverage);
  const relArea = Math.abs(js.area_km2 - s.area_km2_ellipsoid) / Math.max(1e-9, s.area_km2_ellipsoid);
  // income & spending: relative difference (or both "No data")
  const rel = (a, b) => (a == null || b == null) ? (a == b ? 0 : Infinity) : Math.abs(a - b) / Math.max(1, Math.abs(b));
  const econKeys = ['income_median_hh_avg', 'income_mean_hh_avg', 'expenditure_mean_hh_avg', 'est_households', 'spending_power_rm_month'];
  const demoKeys = ['working_age_pop', 'labour_force', 'employed', 'pct_chinese', 'pct_bumi_malay', 'pct_age_25_34'];
  const econDiff = areas && 'est_households' in s ? Math.max(...econKeys.map(k => rel(js[k], s[k] ?? null)),
    ...(districts && 'working_age_pop' in s ? demoKeys.map(k => k.startsWith('pct') ? Math.abs((js[k] ?? 0) - (s[k] ?? 0)) : rel(js[k], s[k] ?? null)) : [0])) : 0;
  const pass = relPop <= 0.002 && dR <= 0.002 && dC <= 0.002 && relArea <= 0.001 && econDiff <= 0.005;
  checks.push({ kind: 'real-data', name: `Independent raster check: ${s.name}`, pass,
    detail: `population JS ${js.population.toFixed(0)} vs raster ${s.population.toFixed(0)} (Δ ${(relPop * 100).toFixed(3)}%); RWI JS ${js.population_weighted_rwi?.toFixed(4) ?? 'No data'} vs ${s.population_weighted_rwi?.toFixed(4) ?? 'No data'}; coverage ${js.wealth_coverage?.toFixed(4) ?? 'No data'} vs ${s.wealth_coverage?.toFixed(4) ?? 'No data'}; area ${js.area_km2.toFixed(3)} vs ${s.area_km2_ellipsoid.toFixed(3)} km²` +
      (areas ? `; median HH income RM ${js.income_median_hh_avg?.toFixed(0) ?? 'No data'} vs ${s.income_median_hh_avg?.toFixed(0) ?? 'No data'}; spending power RM ${js.spending_power_rm_month?.toFixed(0) ?? 'No data'} vs ${s.spending_power_rm_month?.toFixed(0) ?? 'No data'}; employed ${js.employed?.toFixed(0) ?? 'No data'} vs ${s.employed?.toFixed(0) ?? 'No data'}; Chinese ${js.pct_chinese != null ? (js.pct_chinese * 100).toFixed(1) + '%' : 'No data'} vs ${s.pct_chinese != null ? (s.pct_chinese * 100).toFixed(1) + '%' : 'No data'} (max Δ ${(econDiff * 100).toFixed(3)}%)` : ''),
    js: { population: js.population, rwi: js.population_weighted_rwi, coverage: js.wealth_coverage, area: js.area_km2 }, python: { population: s.population, rwi: s.population_weighted_rwi, coverage: s.wealth_coverage, area: s.area_km2_ellipsoid } });
  console.log(pass ? 'PASS' : 'FAIL', checks.at(-1).name, '|', checks.at(-1).detail);
}
fs.writeFileSync(outPath, JSON.stringify(checks, null, 1));
process.exit(checks.every(c => c.pass) ? 0 : 1);
