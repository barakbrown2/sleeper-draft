// src/storage.js
// Versioned browser storage. localStorage holds small JSON (settings, raw CSV
// text, cached league/draft JSON); IndexedDB holds the Sleeper player map.
// Falls back to in-memory maps under node so the pure modules stay testable.

export const SCHEMA_VERSION = 1;

export const KEYS = {
  schema: 'schema:version',
  settings: 'settings:v1',
  projections: 'file:projections',
  rankings1qb: 'file:rankings:1qb',
  rankingsSuperflex: 'file:rankings:superflex',
  league: (id) => `league:${id}`,
  log: 'debug:log',
};

const memLS = new Map();

function ls() {
  try {
    const l = globalThis.localStorage;
    if (!l) return null;
    l.getItem('__probe__');
    return l;
  } catch {
    return null;
  }
}

export function loadJSON(key, fallback = null) {
  try {
    const l = ls();
    const raw = l ? l.getItem(key) : memLS.get(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function saveJSON(key, value) {
  const raw = JSON.stringify(value);
  const l = ls();
  if (l) l.setItem(key, raw);
  else memLS.set(key, raw);
}

export function removeKey(key) {
  const l = ls();
  if (l) l.removeItem(key);
  else memLS.delete(key);
}

export function allKeys() {
  const l = ls();
  if (!l) return [...memLS.keys()];
  const out = [];
  for (let i = 0; i < l.length; i++) out.push(l.key(i));
  return out;
}

function isAppKey(k) {
  return /^(settings:|file:|league:|debug:|schema:)/.test(k);
}

// Wipe app keys when the schema version changes (plan section 12).
export function migrate() {
  const v = loadJSON(KEYS.schema, null);
  if (v === SCHEMA_VERSION) return false;
  if (v !== null) {
    for (const k of allKeys()) if (isAppKey(k)) removeKey(k);
  }
  saveJSON(KEYS.schema, SCHEMA_VERSION);
  return v !== null;
}

export async function clearAll() {
  for (const k of allKeys()) if (isAppKey(k)) removeKey(k);
  await idbClear();
}

export function storageEstimate() {
  const l = ls();
  if (!l) return 0;
  let bytes = 0;
  for (const k of allKeys()) bytes += (l.getItem(k) || '').length + k.length;
  return bytes * 2;
}

// ---- IndexedDB (single key/value store) ----
const DB_NAME = 'sleeper-draft';
const STORE = 'kv';
const memIDB = new Map();

function hasIDB() {
  return typeof indexedDB !== 'undefined';
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

function tx(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => {
          db.close();
          resolve(req ? req.result : undefined);
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
        t.onabort = () => {
          db.close();
          reject(t.error || new Error('IndexedDB aborted'));
        };
      }),
  );
}

export async function idbGet(key) {
  if (!hasIDB()) return memIDB.get(key);
  return tx('readonly', (s) => s.get(key));
}

export async function idbSet(key, value) {
  if (!hasIDB()) {
    memIDB.set(key, value);
    return;
  }
  await tx('readwrite', (s) => s.put(value, key));
}

export async function idbDelete(key) {
  if (!hasIDB()) {
    memIDB.delete(key);
    return;
  }
  await tx('readwrite', (s) => s.delete(key));
}

export async function idbClear() {
  if (!hasIDB()) {
    memIDB.clear();
    return;
  }
  await tx('readwrite', (s) => s.clear());
}
