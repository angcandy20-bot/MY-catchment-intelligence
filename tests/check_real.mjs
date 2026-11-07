// Compare dashboard aggregation (tiles + scanline, Node) with the independent Python raster check.
// Usage: node tests/check_real.mjs site/data py_check.json out.json
import fs from 'node:fs'; import path from 'node:path';
import { parseTile, aggregateGeometry } from '../site/js/core/aggregate.js';
const [dataDir, pyPath, outPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json')));
const py = JSON.parse(fs.readFileSync(pyPath));
const cache = {};
const load = async t => cache[t.id] ??= (b => parseTile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))(fs.readFileSync(path.join(dataDir, t.file)));
const checks = [];
for (const s of py) {
  const js = await aggregateGeometry(s.geometry, manifest, load, 3000);
  const relPop = s.population > 0 ? Math.abs(js.population - s.population) / s.population : Math.abs(js.population);
  const dR = (s.population_weighted_rwi === null || js.population_weighted_rwi === null) ? (s.population_weighted_rwi === js.population_weighted_rwi ? 0 : Infinity) : Math.abs(js.population_weighted_rwi - s.population_weighted_rwi);
  const dC = (s.wealth_coverage === null || js.wealth_coverage === null) ? (s.wealth_coverage === js.wealth_coverage ? 0 : Infinity) : Math.abs(js.wealth_coverage - s.wealth_coverage);
  const relArea = Math.abs(js.area_km2 - s.area_km2_ellipsoid) / Math.max(1e-9, s.area_km2_ellipsoid);
  const pass = relPop <= 0.002 && dR <= 0.002 && dC <= 0.002 && relArea <= 0.005;
  checks.push({ kind: 'real-data', name: `Independent raster check: ${s.name}`, pass,
    detail: `population JS ${js.population.toFixed(0)} vs raster ${s.population.toFixed(0)} (Δ ${(relPop * 100).toFixed(3)}%); RWI JS ${js.population_weighted_rwi?.toFixed(4) ?? 'No data'} vs ${s.population_weighted_rwi?.toFixed(4) ?? 'No data'}; coverage ${js.wealth_coverage?.toFixed(4) ?? 'No data'} vs ${s.wealth_coverage?.toFixed(4) ?? 'No data'}; area ${js.area_km2.toFixed(3)} vs ${s.area_km2_ellipsoid.toFixed(3)} km²`,
    js: { population: js.population, rwi: js.population_weighted_rwi, coverage: js.wealth_coverage, area: js.area_km2 }, python: { population: s.population, rwi: s.population_weighted_rwi, coverage: s.wealth_coverage, area: s.area_km2_ellipsoid } });
  console.log(pass ? 'PASS' : 'FAIL', checks.at(-1).name, '|', checks.at(-1).detail);
}
fs.writeFileSync(outPath, JSON.stringify(checks, null, 1));
process.exit(checks.every(c => c.pass) ? 0 : 1);
