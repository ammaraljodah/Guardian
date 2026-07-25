// Activity-log storage for Guardian (visits, searches, keystrokes, blocked hits).
//
// Primary backend: local Guardian HTTP API (shared SQLite). Every Chrome profile
// posts to the same API, so logs are UNIFIED across profiles.
//
// Fallback: per-profile IndexedDB offline queue when the API is unreachable;
// entries flush once the backend is back.

import { API_BASE, EXTENSION_TOKEN } from "./config.js";

export const STORES = {
  visit: "visit",
  search: "search",
  key: "key",
  blocked: "blocked"
};

/* --------------------------- HTTP API client --------------------------- */

async function apiCall(path, { method = "GET", body = null, query = null } = {}) {
  let url = `${API_BASE}${path}`;
  if (query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) q.set(k, String(v));
    }
    const s = q.toString();
    if (s) url += `?${s}`;
  }
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Guardian-Token": EXTENSION_TOKEN
    }
  };
  if (body != null) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    /* empty */
  }
  if (!res.ok) {
    throw new Error(data.detail || data.error || res.statusText);
  }
  return data;
}

let apiAvailable = null;
async function hasApi() {
  if (apiAvailable !== null) return apiAvailable;
  try {
    await apiCall("/api/logs/visit", { query: { cmd: "count" } });
    apiAvailable = true;
  } catch (e) {
    apiAvailable = false;
    console.warn(
      "[Guardian] shared API unavailable, using per-profile storage:",
      e.message
    );
  }
  return apiAvailable;
}

export function resetApiProbe() {
  apiAvailable = null;
}

/* ------------------------- IndexedDB fallback ---------------------------- */

const DB_NAME = "guardianLogs";
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, {
          keyPath: "id",
          autoIncrement: true
        });
        store.createIndex("ts", "ts", { unique: false });
        if (name === STORES.key) {
          store.createIndex("domain_bucket", ["domain", "bucket"], {
            unique: false
          });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tsRange(cutoff) {
  return cutoff ? IDBKeyRange.lowerBound(cutoff) : null;
}

async function idbAdd(store, record) {
  const db = await openDB();
  return reqPromise(tx(db, store, "readwrite").add(record));
}

async function idbPut(store, record) {
  const db = await openDB();
  return reqPromise(tx(db, store, "readwrite").put(record));
}

async function idbGetKeyBucket(domain, bucket) {
  const db = await openDB();
  const index = tx(db, STORES.key, "readonly").index("domain_bucket");
  return reqPromise(index.get([domain, bucket]));
}

async function idbCount(store, cutoff) {
  const db = await openDB();
  const os = tx(db, store, "readonly");
  const range = tsRange(cutoff);
  return reqPromise(range ? os.index("ts").count(range) : os.count());
}

async function idbGetPage(store, { cutoff = null, offset = 0, limit = 500 }) {
  const db = await openDB();
  const index = tx(db, store, "readonly").index("ts");
  const range = tsRange(cutoff);
  const results = [];
  let skipped = false;
  return new Promise((resolve, reject) => {
    const cursorReq = index.openCursor(range, "prev");
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve(results);
      if (offset > 0 && !skipped) {
        skipped = true;
        cursor.advance(offset);
        return;
      }
      results.push(cursor.value);
      if (results.length >= limit) return resolve(results);
      cursor.continue();
    };
  });
}

async function idbGetAll(store, cutoff = null) {
  const db = await openDB();
  const index = tx(db, store, "readonly").index("ts");
  const range = tsRange(cutoff);
  const results = [];
  return new Promise((resolve, reject) => {
    const cursorReq = index.openCursor(range, "prev");
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve(results);
      results.push(cursor.value);
      cursor.continue();
    };
  });
}

async function idbClear(store) {
  const db = await openDB();
  return reqPromise(tx(db, store, "readwrite").clear());
}

async function idbBulkAdd(store, records) {
  if (!records || !records.length) return;
  const db = await openDB();
  const os = tx(db, store, "readwrite");
  await Promise.all(records.map((r) => reqPromise(os.add(r))));
}

/* ------------------------------ Public API ------------------------------- */

export async function add(store, record) {
  if (await hasApi()) {
    try {
      return (await apiCall(`/api/logs/${store}`, { method: "POST", body: { record } })).id;
    } catch (e) {
      apiAvailable = false;
    }
  }
  return idbAdd(store, record);
}

export async function put(store, record) {
  if (await hasApi()) {
    try {
      return (await apiCall(`/api/logs/${store}`, { method: "PUT", body: { record } })).id;
    } catch (e) {
      apiAvailable = false;
    }
  }
  return idbPut(store, record);
}

export async function getKeyBucket(domain, bucket) {
  if (await hasApi()) {
    try {
      const resp = await apiCall("/api/logs/key/bucket", {
        query: { domain, bucket }
      });
      return resp.record || undefined;
    } catch (e) {
      apiAvailable = false;
    }
  }
  return idbGetKeyBucket(domain, bucket);
}

export async function count(store, cutoff) {
  if (await hasApi()) {
    try {
      return (
        await apiCall(`/api/logs/${store}`, {
          query: { cmd: "count", cutoff }
        })
      ).count;
    } catch (e) {
      apiAvailable = false;
    }
  }
  return idbCount(store, cutoff);
}

export async function getPage(store, { cutoff = null, offset = 0, limit = 500 }) {
  if (await hasApi()) {
    try {
      return (
        await apiCall(`/api/logs/${store}`, {
          query: { cmd: "getPage", cutoff, offset, limit }
        })
      ).entries;
    } catch (e) {
      apiAvailable = false;
    }
  }
  return idbGetPage(store, { cutoff, offset, limit });
}

export async function getAll(store, cutoff = null) {
  if (await hasApi()) {
    try {
      return (
        await apiCall(`/api/logs/${store}`, {
          query: { cmd: "getAll", cutoff }
        })
      ).entries;
    } catch (e) {
      apiAvailable = false;
    }
  }
  return idbGetAll(store, cutoff);
}

export async function clear(store) {
  // Clear is parent-dashboard only on the server (session). Extension uses IDB clear locally.
  if (await hasApi()) {
    try {
      // Extension token cannot DELETE logs — only queue locally if needed.
      // Parents clear via the web UI.
      return;
    } catch (e) {
      /* ignore */
    }
  }
  return idbClear(store);
}

export async function bulkAdd(store, records) {
  if (!records || !records.length) return;
  if (await hasApi()) {
    try {
      return void (await apiCall(`/api/logs/${store}/bulk`, {
        method: "POST",
        body: { records }
      }));
    } catch (e) {
      apiAvailable = false;
    }
  }
  return idbBulkAdd(store, records);
}

export { apiCall, hasApi };
