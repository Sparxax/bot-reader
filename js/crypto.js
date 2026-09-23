// crypto.js — локальне шифрування даних застосунку (AES-GCM 256, ключ з PIN через PBKDF2)
// Ключ ніколи не зберігається на диску — лише в пам'яті поточної сесії (CryptoKey об'єкт).

const PBKDF2_ITERATIONS = 210000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

let sessionKey = null;      // CryptoKey | null — null означає "шифрування вимкнено / вхід не виконано"
let encryptionEnabled = false;

export function isUnlocked() {
  return !encryptionEnabled || sessionKey !== null;
}

export function isEncryptionEnabled() {
  return encryptionEnabled;
}

export function setEncryptionEnabledFlag(v) {
  encryptionEnabled = v;
}

export function lock() {
  sessionKey = null;
}

function toB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function fromB64(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0)).buffer;
}

async function deriveKey(pin, saltBuf) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBuf, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Створює новий PIN (перше налаштування шифрування). Повертає сіль (b64) для збереження у meta-сторі.
export async function initPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  sessionKey = await deriveKey(pin, salt.buffer);
  encryptionEnabled = true;
  // Зберігаємо перевірочний токен (щоб потім валідувати введений PIN), сам токен не є секретом.
  const check = await encryptRaw(sessionKey, 'vault-ok');
  return { salt: toB64(salt.buffer), check };
}

// Розблокування існуючого сховища введеним PIN
export async function unlockWithPin(pin, saltB64, check) {
  const salt = fromB64(saltB64);
  const key = await deriveKey(pin, salt);
  try {
    const plain = await decryptRaw(key, check);
    if (plain !== 'vault-ok') throw new Error('bad pin');
  } catch (e) {
    throw new Error('WRONG_PIN');
  }
  sessionKey = key;
  encryptionEnabled = true;
  return true;
}

export function disableEncryption() {
  sessionKey = null;
  encryptionEnabled = false;
}

async function encryptRaw(key, plainStr) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const enc = new TextEncoder();
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plainStr));
  return { iv: toB64(iv.buffer), ct: toB64(ct) };
}
async function decryptRaw(key, { iv, ct }) {
  const dec = new TextDecoder();
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(ct));
  return dec.decode(plain);
}

// Публічні хелпери для db.js — шифрують/розшифровують довільний серіалізований об'єкт.
export async function encryptValue(value) {
  const plainStr = JSON.stringify(value);
  if (!encryptionEnabled) return { plain: true, data: plainStr };
  if (!sessionKey) throw new Error('LOCKED');
  const { iv, ct } = await encryptRaw(sessionKey, plainStr);
  return { plain: false, iv, ct };
}

export async function decryptValue(envelope) {
  if (!envelope) return envelope;
  if (envelope.plain) return JSON.parse(envelope.data);
  if (!sessionKey) throw new Error('LOCKED');
  const plainStr = await decryptRaw(sessionKey, envelope);
  return JSON.parse(plainStr);
}

export async function exportVaultKeyCheck() {
  return sessionKey ? await encryptRaw(sessionKey, 'vault-ok') : null;
}
