/* Sentinel DD — storage layer (IndexedDB)
 * Stores: users, projects, docblobs (raw file blobs + full extracted text),
 *         outcomes (anonymized post-deal learning bank — see js/learning.js)
 * Everything hangs off window.DD so the non-module scripts can share state. */
(function () {
  const DB_NAME = "sentinel-dd-db";
  const DB_VERSION = 3;

  const DD = (window.DD = window.DD || {});
  let db;

  function cryptoId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[char]);
  }

  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("users")) {
          const users = database.createObjectStore("users", { keyPath: "id" });
          users.createIndex("email", "email", { unique: true });
        }
        if (!database.objectStoreNames.contains("projects")) {
          const projectStore = database.createObjectStore("projects", { keyPath: "id" });
          projectStore.createIndex("ownerId", "ownerId", { unique: false });
        }
        if (!database.objectStoreNames.contains("docblobs")) {
          database.createObjectStore("docblobs", { keyPath: "id" });
        }
        // Learning bank: anonymized, structured outcomes of finalized deals.
        // Never holds documents, evidence, or company names — only the fields
        // js/learning.js records with the contributor's explicit consent.
        if (!database.objectStoreNames.contains("outcomes")) {
          const outcomes = database.createObjectStore("outcomes", { keyPath: "id" });
          outcomes.createIndex("ownerId", "ownerId", { unique: false });
          outcomes.createIndex("dealType", "dealType", { unique: false });
          outcomes.createIndex("industry", "industry", { unique: false });
        }
      };
      request.onsuccess = () => { db = request.result; resolve(db); };
      request.onerror = () => reject(request.error);
    });
  }

  function tx(storeName, mode, operation) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const request = operation(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const store = {
    get: (name, key) => tx(name, "readonly", (s) => s.get(key)),
    getAll: (name) => tx(name, "readonly", (s) => s.getAll()),
    getByIndex: (name, index, value) => tx(name, "readonly", (s) => s.index(index).get(value)),
    getAllByIndex: (name, index, value) => tx(name, "readonly", (s) => s.index(index).getAll(value)),
    put: (name, record) => tx(name, "readwrite", (s) => s.put(record)),
    del: (name, key) => tx(name, "readwrite", (s) => s.delete(key))
  };

  // ---- password hashing (prototype only) ----
  async function hashPassword(password, salt) {
    const input = `${salt}:${password}`;
    if (window.crypto?.subtle) {
      const bytes = new TextEncoder().encode(input);
      const digest = await window.crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16);
  }

  function makeSalt() {
    const values = new Uint32Array(4);
    if (window.crypto?.getRandomValues) {
      window.crypto.getRandomValues(values);
      return [...values].map((v) => v.toString(16)).join("");
    }
    return `${Date.now()}${Math.random()}`;
  }

  async function sha256Hex(arrayBuffer) {
    if (window.crypto?.subtle) {
      const digest = await window.crypto.subtle.digest("SHA-256", arrayBuffer);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    // fallback content hash
    const bytes = new Uint8Array(arrayBuffer);
    let hash = 2166136261;
    for (let i = 0; i < bytes.length; i += 1) {
      hash ^= bytes[i];
      hash = (hash * 16777619) >>> 0;
    }
    return hash.toString(16);
  }

  DD.util = { cryptoId, clone, escapeHtml };
  DD.store = store;
  DD.db = { open, hashPassword, makeSalt, sha256Hex };
})();
