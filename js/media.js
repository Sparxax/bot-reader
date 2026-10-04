// media.js — аватарки, завантаження/кешування медіафайлів, запис голосу та відеокружечків.
import { TelegramAPI } from './api.js';
import * as DB from './db.js';

const objectUrlCache = new Map(); // fileId -> blob URL (щоб не плодити URL.createObjectURL)

async function blobUrlFor(fileId, blob) {
  if (objectUrlCache.has(fileId)) return objectUrlCache.get(fileId);
  const url = URL.createObjectURL(blob);
  objectUrlCache.set(fileId, url);
  return url;
}

// --- Завантаження довільного медіафайлу Telegram (getFile -> fetch -> кеш IndexedDB) ---
export async function fetchTelegramFile(token, fileId) {
  const cached = await DB.get(DB.STORES.mediaCache, fileId).catch(() => null);
  if (cached) return blobUrlFor(fileId, cached.blob);
  const file = await TelegramAPI.getFile(token, fileId);
  if (!file.file_path) throw new Error('Файл недоступний (можливо, застарів file_id)');
  const url = TelegramAPI.fileUrl(token, file.file_path);
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const blob = await res.blob();
  DB.put(DB.STORES.mediaCache, { id: fileId, blob, ts: Date.now() }).then(() => DB.pruneMediaCache()).catch(() => {});
  return blobUrlFor(fileId, blob);
}

// --- Аватарки: користувачі й боти — обидва є "user" у Telegram, тож getUserProfilePhotos працює для обох.
// Резервний варіант — chat.photo, що повертає getChat (актуально для груп/каналів).
export async function getAvatarUrl(token, userOrChatId, chatPhotoFallback) {
  const cacheKey = 'avatar:' + userOrChatId;
  const cached = await DB.get(DB.STORES.mediaCache, cacheKey).catch(() => null);
  if (cached && Date.now() - cached.ts < 1000 * 60 * 30) return blobUrlFor(cacheKey, cached.blob);
  let fileId = null;
  try {
    const photos = await TelegramAPI.getUserProfilePhotos(token, userOrChatId, { limit: 1 });
    if (photos.total_count > 0) {
      const sizes = photos.photos[0];
      fileId = sizes[sizes.length - 1].file_id;
    }
  } catch (e) { /* не критично — спробуємо getChat нижче */ }
  if (!fileId && chatPhotoFallback) fileId = chatPhotoFallback.big_file_id || chatPhotoFallback.small_file_id;
  if (!fileId) return null;
  try {
    const file = await TelegramAPI.getFile(token, fileId);
    const url = TelegramAPI.fileUrl(token, file.file_path);
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    await DB.put(DB.STORES.mediaCache, { id: cacheKey, blob, ts: Date.now() });
    return blobUrlFor(cacheKey, blob);
  } catch (e) { return null; }
}

export async function getBotAvatarUrl(token, botId) {
  // Для власного бота найнадійніше — getChat(botId), що повертає photo навіть якщо getUserProfilePhotos порожній.
  const cacheKey = 'avatar:' + botId;
  const cached = await DB.get(DB.STORES.mediaCache, cacheKey).catch(() => null);
  if (cached && Date.now() - cached.ts < 1000 * 60 * 30) return blobUrlFor(cacheKey, cached.blob);
  let chatPhoto = null;
  try {
    const chat = await TelegramAPI.getChat(token, botId);
    chatPhoto = chat.photo || null;
  } catch (e) { /* ignore */ }
  return getAvatarUrl(token, botId, chatPhoto);
}

// ---------------------------------------------------------------------
// ЗАПИС ГОЛОСОВОГО ПОВІДОМЛЕННЯ (MediaRecorder + мікрофон)
// ---------------------------------------------------------------------
export function pickAudioMime() {
  const candidates = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const c of candidates) if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  return '';
}

export async function startVoiceRecording({ onLevel } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = pickAudioMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  // Аналізатор рівня сигналу для живого візуалізатора хвиль
  let audioCtx, analyser, raf;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const level = data.reduce((a, b) => a + b, 0) / data.length / 255;
      onLevel && onLevel(level);
      raf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) { /* аналізатор не критичний */ }

  recorder.start();
  return {
    stop: () => new Promise((resolve) => {
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        if (raf) cancelAnimationFrame(raf);
        if (audioCtx) audioCtx.close().catch(() => {});
        resolve(new Blob(chunks, { type: mime || 'audio/webm' }));
      };
      recorder.stop();
    }),
    cancel: () => {
      try { recorder.stop(); } catch (e) {}
      stream.getTracks().forEach(t => t.stop());
      if (raf) cancelAnimationFrame(raf);
      if (audioCtx) audioCtx.close().catch(() => {});
    }
  };
}

// ---------------------------------------------------------------------
// ЗАПИС ВІДЕОКРУЖЕЧКА (камера, квадратний кадр під video_note)
// ---------------------------------------------------------------------
export function pickVideoMime() {
  const candidates = ['video/mp4;codecs=h264', 'video/webm;codecs=vp9', 'video/webm'];
  for (const c of candidates) if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  return '';
}

export async function startVideoNoteRecording(previewEl) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 }, aspectRatio: 1 },
    audio: true
  });
  if (previewEl) previewEl.srcObject = stream;
  const mime = pickVideoMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.start();
  return {
    stop: () => new Promise((resolve) => {
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        resolve(new Blob(chunks, { type: mime || 'video/webm' }));
      };
      recorder.stop();
    }),
    cancel: () => {
      try { recorder.stop(); } catch (e) {}
      stream.getTracks().forEach(t => t.stop());
    }
  };
}

// Файлове ім'я з правильним розширенням для FormData (Telegram орієнтується на mime, ім'я — для зручності)
export function fileFromBlob(blob, baseName) {
  const ext = (blob.type.split('/')[1] || 'bin').split(';')[0];
  return new File([blob], `${baseName}.${ext}`, { type: blob.type });
}
