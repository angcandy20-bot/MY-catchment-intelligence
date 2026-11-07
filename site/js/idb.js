// Minimal IndexedDB key-value wrapper (stores: jobs, iso, catchments). Never used for the API key.
const DB_NAME = 'mci-dashboard', DB_VER = 1, STORES = ['jobs', 'iso', 'catchments'];
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((ok, no) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbp = null; }; ok(db); };
    req.onerror = () => no(req.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return open().then(db => new Promise((ok, no) => {
    const t = db.transaction(store, mode); const s = t.objectStore(store); const r = fn(s);
    t.oncomplete = () => ok(r && 'result' in r ? r.result : undefined);
    t.onerror = () => no(t.error); t.onabort = () => no(t.error);
  }));
}
export const idb = {
  get: (store, key) => tx(store, 'readonly', s => s.get(key)),
  set: (store, key, val) => tx(store, 'readwrite', s => s.put(val, key)),
  del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
  all: (store) => tx(store, 'readonly', s => s.getAll()),
  clear: (store) => tx(store, 'readwrite', s => s.clear()),
};
