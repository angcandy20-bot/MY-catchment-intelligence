// Merge test outputs into site/build-report.json (shown in the dashboard's "Build & verification" card).
import fs from 'node:fs';
const [out, ...inputs] = process.argv.slice(2);
const checks = [];
for (const f of inputs) {
  try { for (const c of JSON.parse(fs.readFileSync(f, 'utf8'))) checks.push({ kind: c.kind, name: c.name, pass: c.pass, detail: c.detail || '' }); }
  catch (e) { checks.push({ kind: 'build', name: 'report file ' + f, pass: false, detail: 'missing (step failed or skipped)' }); }
}
const summary = {};
for (const c of checks) { summary[c.kind] ??= { pass: 0, fail: 0 }; summary[c.kind][c.pass ? 'pass' : 'fail']++; }
fs.writeFileSync(out, JSON.stringify({ build: (process.env.GITHUB_SHA || 'local').slice(0, 8), generated_at: new Date().toISOString(),
  legend: { 'simulated-api': 'HeiGIT responses mocked; checks request shape, UI and batch logic only', 'real': 'real network (OSM tiles, data files, live HeiGIT endpoint probe)', 'real-api': 'real HeiGIT isochrone calls (needs HEIGIT_API_KEY secret)', 'real-data': 'calculation on the real HDX data vs independent raster check', 'synthetic-data': 'calculation on generated test data vs brute force', unit: 'unit tests' },
  summary, checks }, null, 1));
console.log(JSON.stringify(summary));
