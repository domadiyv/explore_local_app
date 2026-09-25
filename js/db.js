'use strict';
// Minimal IndexedDB wrapper. All data stays on this device.
const DB = (() => {
  const NAME = 'estate-ledger';
  const VERSION = 1;
  const STORES = ['settings', 'partners', 'properties', 'units', 'tenants', 'leases', 'accounts', 'txns', 'files', 'blobs'];
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }

  async function getAll(store) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store).objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function get(store, id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store).objectStore(store).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function put(store, obj) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(obj);
    return done(tx);
  }

  async function putMany(store, rows) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const r of rows) os.put(r);
    return done(tx);
  }

  async function delMany(store, ids) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const id of ids) os.delete(id);
    return done(tx);
  }

  async function del(store, id) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    return done(tx);
  }

  // Replace the entire database content in one transaction (used by restore).
  async function replaceAll(data) {
    const db = await open();
    const tx = db.transaction(STORES, 'readwrite');
    for (const s of STORES) {
      const os = tx.objectStore(s);
      os.clear();
      for (const row of data[s] || []) os.put(row);
    }
    return done(tx);
  }

  async function clearAll() {
    return replaceAll({});
  }

  return { STORES, open, getAll, get, put, putMany, del, delMany, replaceAll, clearAll };
})();
