// IndexedDB-backed storage for the activity logs (visits, searches, keystrokes,
// blocked attempts). chrome.storage.local has a small quota and keeps the whole
// value in memory on every read/write, so it does not scale to unlimited logs.
// IndexedDB stores data in on-disk database files managed by the browser and,
// together with the "unlimitedStorage" permission, has effectively no size cap.
//
// Every store keeps one row per log entry, keyed by an auto-incrementing id
// (insertion order). A "ts" index lets us page and date-filter newest-first
// without loading everything into memory. The key store also has a
// [domain, bucket] index so we can find and update the current typing bucket.

const DB_NAME = "guardianLogs";
const DB_VERSION = 1;

export const STORES = {
  visit: "visit",
  search: "search",
  key: "key",
  blocked: "blocked"
};

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

// Insert a new entry, returns its generated id.
export async function add(store, record) {
  const db = await openDB();
  return reqPromise(tx(db, store, "readwrite").add(record));
}

// Insert/overwrite an entry (record must contain its id).
export async function put(store, record) {
  const db = await openDB();
  return reqPromise(tx(db, store, "readwrite").put(record));
}

// Look up the current typing bucket for a domain (key store only).
export async function getKeyBucket(domain, bucket) {
  const db = await openDB();
  const index = tx(db, STORES.key, "readonly").index("domain_bucket");
  return reqPromise(index.get([domain, bucket]));
}

function tsRange(cutoff) {
  return cutoff ? IDBKeyRange.lowerBound(cutoff) : null;
}

// Number of entries with ts >= cutoff (or all when cutoff is null).
export async function count(store, cutoff) {
  const db = await openDB();
  const os = tx(db, store, "readonly");
  const range = tsRange(cutoff);
  return reqPromise(range ? os.index("ts").count(range) : os.count());
}

// One page of entries, newest-first, honoring an optional ts cutoff.
export async function getPage(store, { cutoff = null, offset = 0, limit = 500 }) {
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

// Every entry, newest-first, honoring an optional ts cutoff (used for export).
export async function getAll(store, cutoff = null) {
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

export async function clear(store) {
  const db = await openDB();
  return reqPromise(tx(db, store, "readwrite").clear());
}

// Insert many entries in a single transaction (used for one-time migration).
export async function bulkAdd(store, records) {
  if (!records || !records.length) return;
  const db = await openDB();
  const os = tx(db, store, "readwrite");
  await Promise.all(records.map((r) => reqPromise(os.add(r))));
}
