// HeiGIT openrouteservice isochrone client. DOM-free.
// The API key is passed in per call and is never stored, logged or returned.

export const HEIGIT_ISOCHRONES_ENDPOINT = 'https://api.heigit.org/openrouteservice/v2/isochrones/driving-car';
export const MINUTES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export const DIRECTIONS = {
  to: { location_type: 'destination', label: 'Driving TO the store (arrival)' },
  from: { location_type: 'start', label: 'Driving FROM the store (departure)' },
};

export function buildIsochroneBody(lat, lon, direction = 'to') {
  const d = DIRECTIONS[direction];
  if (!d) throw new Error('Unknown direction ' + direction);
  return {
    locations: [[lon, lat]],          // openrouteservice expects [longitude, latitude]
    location_type: d.location_type,
    range_type: 'time',
    range: [600],
    interval: 60,
  };
}

export class HeigitError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}

export const ERROR_TEXT = {
  missing_key: 'No API key entered. Paste your HeiGIT API key in the API setup panel.',
  invalid_key: 'The API key was rejected (invalid or mistyped). Check it in your HeiGIT dashboard and paste it again.',
  forbidden: 'HeiGIT refused this key (HTTP 403): either the key is invalid or mistyped, or it does not have access to the Isochrones service. Check the key and its Isochrones access in your HeiGIT dashboard.',
  quota_exhausted: 'The Isochrones quota for this key is used up. Check your remaining quota in the HeiGIT dashboard and try again after it resets.',
  rate_limited: 'Too many requests per minute. Pausing before continuing.',
  bad_request: 'HeiGIT could not compute an isochrone for this location (for example, no road nearby).',
  server_error: 'HeiGIT server error. Try again later.',
  network: 'Could not connect to the HeiGIT API (offline, blocked by a network filter, or the service is unreachable).',
  incomplete: 'HeiGIT returned an incomplete response (not all ten contours).',
  aborted: 'Request stopped.',
};

function headerNum(h, name) { const v = h && h.get ? h.get(name) : null; const n = v == null ? NaN : Number(v); return Number.isFinite(n) ? n : null; }

export async function classifyError(res) {
  let body = '';
  try { body = await res.text(); } catch (e) { /* ignore */ }
  let msg = body;
  try { const j = JSON.parse(body); msg = (j.error && (j.error.message || j.error)) || j.message || body; if (typeof msg !== 'string') msg = JSON.stringify(msg); } catch (e) { /* plain text */ }
  const low = String(msg).toLowerCase();
  const s = res.status;
  const detail = String(msg).slice(0, 300);
  if (s === 401) return new HeigitError('invalid_key', ERROR_TEXT.invalid_key, { status: s, detail });
  if (s === 403) {
    if (low.includes('quota')) return new HeigitError('quota_exhausted', ERROR_TEXT.quota_exhausted, { status: s, detail });
    return new HeigitError('forbidden', ERROR_TEXT.forbidden, { status: s, detail });
  }
  if (s === 429) {
    const retryAfter = headerNum(res.headers, 'retry-after');
    const reset = headerNum(res.headers, 'x-ratelimit-reset');
    let waitMs = retryAfter != null ? retryAfter * 1000 : reset != null ? Math.max(0, reset * 1000 - Date.now()) : 60000;
    if (low.includes('quota') || waitMs > 15 * 60 * 1000) {
      return new HeigitError('quota_exhausted', ERROR_TEXT.quota_exhausted, { status: s, detail, retryAfterMs: waitMs });
    }
    waitMs = Math.min(Math.max(waitMs, 5000), 120000) + 1000;
    return new HeigitError('rate_limited', ERROR_TEXT.rate_limited, { status: s, detail, retryAfterMs: waitMs });
  }
  if (s >= 500) return new HeigitError('server_error', ERROR_TEXT.server_error, { status: s, detail });
  return new HeigitError('bad_request', ERROR_TEXT.bad_request + (detail ? ' (' + detail + ')' : ''), { status: s, detail });
}

// Parse and validate a response: exactly the ten cumulative contours 60..600 s.
export function parseContours(json) {
  const feats = (json && json.features) || [];
  const byMin = new Map();
  for (const f of feats) {
    const v = f && f.properties && Number(f.properties.value);
    const g = f && f.geometry;
    if (!Number.isFinite(v) || !g || !/Polygon$/.test(g.type)) continue;
    const m = Math.round(v / 60);
    if (MINUTES.includes(m)) byMin.set(m, g);
  }
  const missing = MINUTES.filter(m => !byMin.has(m));
  if (missing.length) throw new HeigitError('incomplete', ERROR_TEXT.incomplete + ' Missing minute(s): ' + missing.join(', '), { missing });
  return MINUTES.map(m => ({ minutes: m, geometry: byMin.get(m) }));
}

export async function requestIsochrones({ lat, lon, direction = 'to', apiKey, fetchImpl, signal }) {
  if (!apiKey || !String(apiKey).trim()) throw new HeigitError('missing_key', ERROR_TEXT.missing_key);
  const f = fetchImpl || globalThis.fetch;
  const body = buildIsochroneBody(lat, lon, direction);
  let res;
  try {
    res = await f(HEIGIT_ISOCHRONES_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': String(apiKey).trim(),
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json, application/geo+json',
      },
      body: JSON.stringify(body),
      signal,
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new HeigitError('aborted', ERROR_TEXT.aborted);
    throw new HeigitError('network', ERROR_TEXT.network);
  }
  if (!res.ok) throw await classifyError(res);
  let json;
  try { json = await res.json(); } catch (e) { throw new HeigitError('incomplete', 'HeiGIT returned a response that is not valid JSON.'); }
  return { contours: parseContours(json), direction, request: body };
}

export function cacheKey(lat, lon, direction) {
  return ['driving-car', direction, 'r600i60', Number(lat).toFixed(6), Number(lon).toFixed(6)].join('|');
}
