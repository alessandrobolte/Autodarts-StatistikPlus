(() => {
  const SP = window.__STATISTIK_PLUS__;
  if (!SP) return;

  const DB_NAME = 'statistik_plus_db';
  const DB_VERSION = 3;
  const STORE_NAMES = {
    rawEvents: 'rawEvents',
    legs: 'legs',
    checkouts: 'checkouts',
    darts: 'darts',
    matches: 'matches',
    meta: 'meta'
  };

  class StatistikPlusDB {
    constructor() {
      this.dbPromise = null;
    }

    async open() {
      if (this.dbPromise) return this.dbPromise;
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;

          if (!db.objectStoreNames.contains(STORE_NAMES.rawEvents)) {
            const store = db.createObjectStore(STORE_NAMES.rawEvents, { keyPath: 'id' });
            store.createIndex('createdAt', 'createdAt', { unique: false });
            store.createIndex('hash', 'hash', { unique: false });
          }

          if (!db.objectStoreNames.contains(STORE_NAMES.legs)) {
            const store = db.createObjectStore(STORE_NAMES.legs, { keyPath: 'id' });
            store.createIndex('endedAt', 'endedAt', { unique: false });
            store.createIndex('createdAt', 'createdAt', { unique: false });
            store.createIndex('matchId', 'matchId', { unique: false });
            store.createIndex('playerName', 'playerName', { unique: false });
          }

          if (!db.objectStoreNames.contains(STORE_NAMES.checkouts)) {
            const store = db.createObjectStore(STORE_NAMES.checkouts, { keyPath: 'id' });
            store.createIndex('endedAt', 'endedAt', { unique: false });
            store.createIndex('legId', 'legId', { unique: false });
            store.createIndex('value', 'value', { unique: false });
          }

          if (!db.objectStoreNames.contains(STORE_NAMES.darts)) {
            const store = db.createObjectStore(STORE_NAMES.darts, { keyPath: 'id' });
            store.createIndex('createdAt', 'createdAt', { unique: false });
            store.createIndex('legId', 'legId', { unique: false });
            store.createIndex('matchId', 'matchId', { unique: false });
            store.createIndex('playerName', 'playerName', { unique: false });
            store.createIndex('field', 'field', { unique: false });
          }

          if (!db.objectStoreNames.contains(STORE_NAMES.matches)) {
            const store = db.createObjectStore(STORE_NAMES.matches, { keyPath: 'id' });
            store.createIndex('updatedAt', 'updatedAt', { unique: false });
            store.createIndex('endedAt', 'endedAt', { unique: false });
            store.createIndex('playerName', 'playerName', { unique: false });
            store.createIndex('status', 'status', { unique: false });
          }

          if (!db.objectStoreNames.contains(STORE_NAMES.meta)) {
            db.createObjectStore(STORE_NAMES.meta, { keyPath: 'key' });
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return this.dbPromise;
    }

    async transaction(storeNames, mode, run) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        const stores = {};
        storeNames.forEach((name) => {
          stores[name] = tx.objectStore(name);
        });

        let result;
        try {
          result = run(stores, tx);
        } catch (error) {
          reject(error);
          return;
        }

        tx.oncomplete = async () => {
          try {
            resolve(await result);
          } catch (error) {
            reject(error);
          }
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      });
    }

    async put(storeName, item) {
      return this.transaction([storeName], 'readwrite', (stores) => {
        stores[storeName].put(item);
      });
    }

    async bulkPut(storeName, items) {
      if (!Array.isArray(items) || !items.length) return;
      return this.transaction([storeName], 'readwrite', (stores) => {
        items.forEach((item) => stores[storeName].put(item));
      });
    }

    async get(storeName, key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([storeName], 'readonly');
        const request = tx.objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    async getAll(storeName) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([storeName], 'readonly');
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    }


    async clearStore(storeName) {
      return this.transaction([storeName], 'readwrite', (stores) => {
        stores[storeName].clear();
      });
    }

    async setMeta(key, value) {
      return this.put(STORE_NAMES.meta, { key, value, updatedAt: new Date().toISOString() });
    }

    async getMeta(key, fallback = null) {
      const entry = await this.get(STORE_NAMES.meta, key);
      return entry ? entry.value : fallback;
    }

    async clearAll() {
      return this.transaction(Object.values(STORE_NAMES), 'readwrite', (stores) => {
        Object.values(stores).forEach((store) => store.clear());
      });
    }

    sanitizeExportValue(value) {
      if (Array.isArray(value)) {
        return value.map((entry) => this.sanitizeExportValue(entry));
      }
      if (!value || typeof value !== 'object') return value;
      const clone = { ...value };
      const sensitiveKeys = ['access_token', 'refresh_token', 'id_token', 'authorization', 'Authorization'];
      sensitiveKeys.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(clone, key) && clone[key]) {
          clone[key] = '[redacted]';
        }
      });
      Object.keys(clone).forEach((key) => {
        clone[key] = this.sanitizeExportValue(clone[key]);
      });
      return clone;
    }

    async exportAll() {
      const [rawEvents, legs, checkouts, darts, matches, meta] = await Promise.all([
        this.getAll(STORE_NAMES.rawEvents),
        this.getAll(STORE_NAMES.legs),
        this.getAll(STORE_NAMES.checkouts),
        this.getAll(STORE_NAMES.darts),
        this.getAll(STORE_NAMES.matches),
        this.getAll(STORE_NAMES.meta)
      ]);
      return {
        exportedAt: new Date().toISOString(),
        version: SP.version,
        rawEvents: rawEvents.map((entry) => this.sanitizeExportValue(entry)),
        legs,
        checkouts,
        darts,
        matches,
        meta
      };
    }

    async importAll(payload) {
      const rawEvents = Array.isArray(payload?.rawEvents) ? payload.rawEvents : [];
      const legs = Array.isArray(payload?.legs) ? payload.legs : [];
      const checkouts = Array.isArray(payload?.checkouts) ? payload.checkouts : [];
      const darts = Array.isArray(payload?.darts) ? payload.darts : [];
      const matches = Array.isArray(payload?.matches) ? payload.matches : [];
      const meta = Array.isArray(payload?.meta) ? payload.meta : [];

      await this.clearAll();
      await this.transaction(Object.values(STORE_NAMES), 'readwrite', (stores) => {
        rawEvents.forEach((entry) => stores[STORE_NAMES.rawEvents].put(entry));
        legs.forEach((entry) => stores[STORE_NAMES.legs].put(entry));
        checkouts.forEach((entry) => stores[STORE_NAMES.checkouts].put(entry));
        darts.forEach((entry) => stores[STORE_NAMES.darts].put(entry));
        matches.forEach((entry) => stores[STORE_NAMES.matches].put(entry));
        meta.forEach((entry) => stores[STORE_NAMES.meta].put(entry));
      });
    }
  }

  SP.db = new StatistikPlusDB();
  SP.dbStores = STORE_NAMES;
})();
