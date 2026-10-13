// Camada fina sobre o IndexedDB. Todos os dados do app ficam no aparelho.

const DB_NAME = "flashcards";
const DB_VERSION = 1;

export const STORES = ["decks", "notetypes", "notes", "cards", "media", "revlog", "meta"];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("decks", { keyPath: "id" });
      db.createObjectStore("notetypes", { keyPath: "id" });
      db.createObjectStore("notes", { keyPath: "id" });
      db.createObjectStore("cards", { keyPath: "id" }).createIndex("noteId", "noteId");
      db.createObjectStore("media", { keyPath: "name" });
      db.createObjectStore("revlog", { keyPath: "id", autoIncrement: true }).createIndex("ts", "ts");
      db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transação abortada"));
    result = fn(tx);
  });
}

export async function get(store, key) {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).get(key));
}

export async function getAll(store) {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).getAll());
}

export async function getAllKeys(store) {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).getAllKeys());
}

export async function getByIndex(store, index, query) {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).index(index).getAll(query));
}

export function put(store, value) {
  return run([store], "readwrite", (tx) => {
    tx.objectStore(store).put(value);
  });
}

export function add(store, value) {
  let key;
  return run([store], "readwrite", (tx) => {
    const req = tx.objectStore(store).add(value);
    req.onsuccess = () => (key = req.result);
  }).then(() => key);
}

export function bulkPut(store, values) {
  if (!values.length) return Promise.resolve();
  return run([store], "readwrite", (tx) => {
    const os = tx.objectStore(store);
    for (const v of values) os.put(v);
  });
}

export function del(store, key) {
  return run([store], "readwrite", (tx) => {
    tx.objectStore(store).delete(key);
  });
}

export function bulkDel(store, keys) {
  if (!keys.length) return Promise.resolve();
  return run([store], "readwrite", (tx) => {
    const os = tx.objectStore(store);
    for (const k of keys) os.delete(k);
  });
}

export function clearAll() {
  return run(STORES, "readwrite", (tx) => {
    for (const s of STORES) tx.objectStore(s).clear();
  });
}

export async function getMeta(key, fallback) {
  const row = await get("meta", key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  return put("meta", { key, value });
}

let idCounter = 0;
// Ids locais seguem o formato do Anki (milissegundos), sem repetir no mesmo instante.
export function newId() {
  const now = Date.now();
  idCounter = now > idCounter ? now : idCounter + 1;
  return idCounter;
}
