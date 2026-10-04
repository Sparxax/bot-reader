// db.js — обгортка над IndexedDB. Кожен запис у "чутливих" сторах шифрується прозоро (crypto.js).
import { encryptValue, decryptValue } from './crypto.js';

const DB_NAME = 'tgbot-manager';
const DB_VERSION = 1;
const ENCRYPTED_STORES = new Set(['bots', 'messages', 'chats']); // токени/чати/повідомлення — шифруємо
const STORES = {
  meta: 'meta',           // не шифрується: сіль PIN, версія, налаштування UI (тема тощо)
  bots: 'bots',           // {id, token, name, username, offset, settings...}
  chats: 'chats',         // {id: `${botId}:${chatId}`, botId, chatId, user info, lastMessage...}
  messages: 'messages',   // {id: `${botId}:${chatId}:${messageId}`, botId, chatId, ...}
  mediaCache: 'mediaCache' // {id: fileId, blob, ts} — не шифрується (не секретне), для швидкого доступу
};

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORES.bots)) db.createObjectStore(STORES.bots, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.chats)) {
        const s = db.createObjectStore(STORES.chats, { keyPath: 'id' });
        s.createIndex('botId', 'botId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.messages)) {
        const s = db.createObjectStore(STORES.messages, { keyPath: 'id' });
        s.createIndex('chatKey', 'chatKey', { unique: false });
        s.createIndex('ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.mediaCache)) {
        const s = db.createObjectStore(STORES.mediaCache, { keyPath: 'id' });
        s.createIndex('ts', 'ts', { unique: false });
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

export async function metaGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = tx(db, STORES.meta, 'readonly').get(key);
    r.onsuccess = () => resolve(r.result ? r.result.value : undefined);
    r.onerror = () => reject(r.error);
  });
}
export async function metaSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = tx(db, STORES.meta, 'readwrite').put({ key, value });
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

// Універсальний put/get з опційним шифруванням залежно від назви стору
export async function put(storeName, record) {
  const db = await openDb();
  let toStore = record;
  if (ENCRYPTED_STORES.has(storeName)) {
    const envelope = await encryptValue(record);
    toStore = { id: record.id, ...(record.chatKey ? { chatKey: record.chatKey, ts: record.ts } : {}), ...(record.botId && storeName === 'chats' ? { botId: record.botId } : {}), _env: envelope };
  }
  return new Promise((resolve, reject) => {
    const r = tx(db, storeName, 'readwrite').put(toStore);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

async function decode(storeName, rec) {
  if (!rec) return rec;
  if (ENCRYPTED_STORES.has(storeName)) return decryptValue(rec._env);
  return rec;
}

export async function get(storeName, id) {
  const db = await openDb();
  const rec = await new Promise((resolve, reject) => {
    const r = tx(db, storeName, 'readonly').get(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return decode(storeName, rec);
}

export async function getAll(storeName) {
  const db = await openDb();
  const recs = await new Promise((resolve, reject) => {
    const r = tx(db, storeName, 'readonly').getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const out = [];
  for (const rec of recs) out.push(await decode(storeName, rec));
  return out;
}

export async function getByIndex(storeName, indexName, value) {
  const db = await openDb();
  const recs = await new Promise((resolve, reject) => {
    const idx = tx(db, storeName, 'readonly').index(indexName);
    const r = idx.getAll(value);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const out = [];
  for (const rec of recs) out.push(await decode(storeName, rec));
  return out;
}

export async function del(storeName, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = tx(db, storeName, 'readwrite').delete(id);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function clearStore(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = tx(db, storeName, 'readwrite').clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

// --- Pruning: видаляє старі повідомлення/медіа понад ліміт (розділ 6 ТЗ) ---
export async function pruneMessages({ maxPerChat = 500, maxAgeDays = 60 } = {}) {
  const db = await openDb();
  const all = await getAll(STORES.messages);
  const byChat = {};
  for (const m of all) {
    (byChat[m.chatKey] = byChat[m.chatKey] || []).push(m);
  }
  const cutoff = Date.now() - maxAgeDays * 86400000;
  for (const chatKey in byChat) {
    const list = byChat[chatKey].sort((a, b) => a.ts - b.ts);
    const toDelete = [];
    // за віком (окрім тексту — текстові логи лишаємо довше, видаляємо лише важкі медіа-повідомлення)
    for (const m of list) {
      if (m.ts < cutoff && m.hasMedia) toDelete.push(m.id);
    }
    // за кількістю на чат
    if (list.length > maxPerChat) {
      const excess = list.slice(0, list.length - maxPerChat);
      for (const m of excess) toDelete.push(m.id);
    }
    for (const id of new Set(toDelete)) await del(STORES.messages, id);
  }
}

export async function pruneMediaCache({ maxItems = 300 } = {}) {
  const all = await getAll(STORES.mediaCache);
  if (all.length <= maxItems) return;
  const sorted = all.sort((a, b) => a.ts - b.ts);
  const excess = sorted.slice(0, sorted.length - maxItems);
  for (const item of excess) await del(STORES.mediaCache, item.id);
}

export { STORES };
