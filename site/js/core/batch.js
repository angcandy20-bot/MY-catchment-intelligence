// Batch store analysis engine. DOM-free; all I/O is injected so it can be tested with mocks.
import { MINUTES } from './heigit.js';

export const BATCH_COLUMNS = ['name', 'latitude', 'longitude', 'minutes', 'direction', 'population',
  'population_weighted_rwi', 'wealth_coverage', 'area_km2', 'population_density', 'status'];

export const DIRECTION_VALUE = { to: 'to_store (arrival)', from: 'from_store (departure)' };
const HALT_KINDS = new Set(['missing_key', 'invalid_key', 'forbidden', 'quota_exhausted']);

const r = (v, d) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

export function statRow(store, minutes, direction, stats, status) {
  return {
    name: store.name, latitude: store.latitude, longitude: store.longitude, minutes,
    direction: DIRECTION_VALUE[direction],
    population: stats ? r(stats.population, 1) : '',
    population_weighted_rwi: stats ? (stats.population_weighted_rwi === null ? 'No data' : r(stats.population_weighted_rwi, 4)) : '',
    wealth_coverage: stats ? (stats.wealth_coverage === null ? 'No data' : r(stats.wealth_coverage, 4)) : '',
    area_km2: stats ? r(stats.area_km2, 4) : '',
    population_density: stats ? (stats.population_density === null ? 'No data' : r(stats.population_density, 1)) : '',
    status,
  };
}
export function placeholderRows(store, direction, status) {
  return MINUTES.map(m => statRow(store, m, direction, null, status));
}

export function newJob({ stores, direction = 'to', maxDistM = 3000 }) {
  return {
    id: 'job-' + Date.now(), createdAt: new Date().toISOString(), direction, maxDistM,
    stores: stores.map(s => ({ name: s.name, latitude: s.latitude, longitude: s.longitude, valid: s.valid !== false, error: s.error || '' })),
    results: {}, nextIndex: 0, state: 'ready', message: '',
  };
}

// All N x 10 rows in original store order, minutes 1..10. Unprocessed stores are flagged, never filled.
export function jobRows(job) {
  const rows = [];
  job.stores.forEach((s, i) => {
    const res = job.results[i];
    rows.push(...(res ? res.rows : placeholderRows(s, job.direction, 'incomplete: not processed yet')));
  });
  return rows;
}

export function jobSummary(job) {
  const n = job.stores.length; let ok = 0, failed = 0;
  for (const k of Object.keys(job.results)) { const st = job.results[k].status; if (st === 'ok') ok++; else failed++; }
  return { total: n, ok, failed, pending: n - ok - failed };
}

export class BatchRunner {
  // deps: getContours(store, direction, {signal}) -> {contours:[{minutes, geometry}], fromCache}
  //       aggregate(geometry, maxDistM) -> stats (see aggregate.finalize)
  //       save(job) -> Promise, onUpdate(job, info), sleep(ms, signal) -> Promise, minIntervalMs
  constructor(job, deps) {
    this.job = job; this.d = Object.assign({ minIntervalMs: 3100, onUpdate: () => {}, now: () => Date.now() }, deps);
    this.stopRequested = false; this.ctrl = null; this.lastCall = 0;
  }
  stop() { this.stopRequested = true; if (this.ctrl) this.ctrl.abort(); }

  async _sleep(ms, info) {
    this.ctrl = new AbortController();
    this.d.onUpdate(this.job, Object.assign({ waitingMs: ms }, info));
    try { await this.d.sleep(ms, this.ctrl.signal); } catch (e) { /* aborted by stop */ }
    this.ctrl = null;
  }

  async run() {
    const job = this.job;
    job.state = 'running'; job.message = ''; await this.d.save(job); this.d.onUpdate(job, {});
    for (let i = job.nextIndex; i < job.stores.length; i++) {
      if (this.stopRequested) break;
      const store = job.stores[i];
      if (!store.valid) {
        job.results[i] = { status: 'failed', rows: placeholderRows(store, job.direction, 'failed: ' + (store.error || 'invalid coordinates')) };
        job.nextIndex = i + 1; await this.d.save(job); this.d.onUpdate(job, { index: i }); continue;
      }
      let contours = null, failure = null, pauses = 0;
      while (!this.stopRequested) {
        const wait = this.lastCall + this.d.minIntervalMs - this.d.now();
        if (wait > 0 && this.lastCall) await this._sleep(wait, { index: i, reason: 'spacing requests' });
        if (this.stopRequested) break;
        this.ctrl = new AbortController();
        try {
          const res = await this.d.getContours(store, job.direction, { signal: this.ctrl.signal });
          this.ctrl = null;
          if (!res.fromCache) this.lastCall = this.d.now();
          contours = res.contours; break;
        } catch (e) {
          this.ctrl = null; this.lastCall = this.d.now();
          const kind = e.kind || 'unknown';
          if (kind === 'aborted' || this.stopRequested) break;
          if (HALT_KINDS.has(kind)) {
            job.state = 'halted'; job.message = e.message; job.haltKind = kind;
            await this.d.save(job); this.d.onUpdate(job, { index: i, error: e }); return job;
          }
          if (kind === 'rate_limited' && pauses < 3) { pauses++; await this._sleep(e.retryAfterMs || 60000, { index: i, reason: 'rate limit: pausing as advised by the API' }); continue; }
          if (kind === 'network' && pauses < 1) { pauses++; await this._sleep(30000, { index: i, reason: 'connection failed: waiting before one retry' }); continue; }
          failure = e; break;
        }
      }
      if (this.stopRequested && !contours) break;
      if (failure) {
        job.results[i] = { status: 'failed', rows: placeholderRows(store, job.direction, 'failed: ' + failure.message) };
      } else {
        const rows = []; let aggFail = false;
        for (const c of contours) {
          try {
            const st = await this.d.aggregate(c.geometry, job.maxDistM);
            rows.push(statRow(store, c.minutes, job.direction, st, st.population_weighted_rwi === null ? 'ok (no RWI match within threshold)' : 'ok'));
          } catch (e) { aggFail = true; rows.push(statRow(store, c.minutes, job.direction, null, 'failed: aggregation error (' + e.message + ')')); }
        }
        rows.sort((a, b) => a.minutes - b.minutes);
        job.results[i] = { status: aggFail ? 'failed' : 'ok', rows, contours };
      }
      job.nextIndex = i + 1;
      await this.d.save(job); this.d.onUpdate(job, { index: i });
    }
    job.state = this.stopRequested ? 'stopped' : (job.nextIndex >= job.stores.length ? 'done' : job.state);
    if (job.state === 'stopped') job.message = 'Stopped. Progress is saved; press Resume to continue.';
    await this.d.save(job); this.d.onUpdate(job, {});
    return job;
  }
}
