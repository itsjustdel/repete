// Minimal promise wrapper around IndexedDB.
// Stores:
//   cards  { id, ef, reps, interval, due, lapses, last }   flashcard SRS state
//   days   { date: 'YYYY-MM-DD', seconds }                  practice time per day
const DB_NAME = 'repete';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('days')) db.createObjectStore('days', { keyPath: 'date' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const db = {
  get: (store, key) => run(store, 'readonly', s => s.get(key)),
  getAll: (store) => run(store, 'readonly', s => s.getAll()),
  put: (store, value) => run(store, 'readwrite', s => s.put(value)),
  delete: (store, key) => run(store, 'readwrite', s => s.delete(key)),
  clear: (store) => run(store, 'readwrite', s => s.clear()),
};
