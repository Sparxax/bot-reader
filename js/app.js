import { TelegramAPI, startLongPolling, stopLongPolling, stopAllPolling } from './api.js';
import * as DB from './db.js';
import * as Crypto from './crypto.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const ACCENTS = ['#3390ec', '#e53935', '#8e24aa', '#43a047', '#fb8c00', '#00acc1'];

const state = {
  bots: [],
  currentBotId: null,
  currentChatKey: null,
  chatsCache: {},      // botId -> [chat...]
  messagesCache: {},   // chatKey -> [message...] (loaded window)
  renderedCount: {},   // chatKey -> how many messages currently in DOM (for lazy load)
  replyTo: null,
  pinBuffer: '',
  pendingPinSetup: false,
  settings: { theme: 'system', accent: ACCENTS[0], sound: true, push: false, pollingInterval: 1000 },
};

// ---------------------------------------------------------------------
// BOOTSTRAP
// ---------------------------------------------------------------------
async function boot() {
  await DB.openDb();
  await loadSettings();
  applyTheme();

  const encEnabled = await DB.metaGet('encryptionEnabled');
  const onboarded = await DB.metaGet('onboarded');

  if (!onboarded) {
    show('#onboard-screen');
    return;
  }
  if (encEnabled) {
    Crypto.setEncryptionEnabledFlag(true);
    showLockScreen(false);
  } else {
    await startApp();
  }
  registerServiceWorker();
}

async function startApp() {
  hide('#lock-screen'); hide('#onboard-screen');
  state.bots = await DB.getAll(DB.STORES.bots);
  renderBotSwitcher();
  if (state.bots.length) {
    await selectBot(state.bots[0].id);
  } else {
    openAddBotModal();
  }
  for (const bot of state.bots) resumePolling(bot);
}

function show(sel) { $(sel).classList.remove('hidden'); }
function hide(sel) { $(sel).classList.add('hidden'); }

// ---------------------------------------------------------------------
// SETTINGS / THEME
// ---------------------------------------------------------------------
async function loadSettings() {
  const s = await DB.metaGet('appSettings');
  if (s) state.settings = { ...state.settings, ...s };
}
async function saveSettings() {
  await DB.metaSet('appSettings', state.settings);
}
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.settings.theme === 'system' ? '' : state.settings.theme);
  document.documentElement.style.setProperty('--accent', state.settings.accent);
  const rgb = hexToRgb(state.settings.accent);
  document.documentElement.style.setProperty('--accent-rgb', `${rgb.r},${rgb.g},${rgb.b}`);
}
function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

// ---------------------------------------------------------------------
// PIN / LOCK
// ---------------------------------------------------------------------
function renderKeypad() {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  $('#keypad').innerHTML = keys.map(k => k === '' ? '<span></span>' : `<button data-k="${k}">${k}</button>`).join('');
  $$('#keypad button').forEach(b => b.onclick = () => onKeyPress(b.dataset.k));
}
function renderPinDots() {
  $('#pin-dots').innerHTML = Array.from({ length: 4 }).map((_, i) =>
    `<div class="dot ${i < state.pinBuffer.length ? 'filled' : ''}"></div>`).join('');
}
async function onKeyPress(k) {
  if (k === '⌫') { state.pinBuffer = state.pinBuffer.slice(0, -1); renderPinDots(); return; }
  if (state.pinBuffer.length >= 4) return;
  state.pinBuffer += k;
  renderPinDots();
  if (state.pinBuffer.length === 4) {
    if (state.pendingPinSetup) await finishPinSetup(state.pinBuffer);
    else await tryUnlock(state.pinBuffer);
    state.pinBuffer = '';
  }
}
function showLockScreen(isSetup) {
  state.pendingPinSetup = isSetup;
  $('#lock-title').textContent = isSetup ? 'Створіть PIN-код' : 'Введіть PIN-код';
  $('#lock-error').textContent = '';
  state.pinBuffer = '';
  renderPinDots(); renderKeypad();
  show('#lock-screen');
}
async function finishPinSetup(pin) {
  const { salt, check } = await Crypto.initPin(pin);
  await DB.metaSet('pinSalt', salt);
  await DB.metaSet('pinCheck', check);
  await DB.metaSet('encryptionEnabled', true);
  await DB.metaSet('onboarded', true);
  await startApp();
}
async function tryUnlock(pin) {
  const salt = await DB.metaGet('pinSalt');
  const check = await DB.metaGet('pinCheck');
  try {
    await Crypto.unlockWithPin(pin, salt, check);
    await startApp();
  } catch (e) {
    $('#lock-error').textContent = 'Невірний PIN-код';
    renderPinDots();
  }
}

// ---------------------------------------------------------------------
// BOTS
// ---------------------------------------------------------------------
function renderBotSwitcher() {
  const el = $('#bot-switcher');
  el.innerHTML = state.bots.map(b =>
    `<div class="bot-chip ${b.id === state.currentBotId ? 'active' : ''}" data-bot="${b.id}">
       <span>🤖 ${escapeHtml(b.username ? '@' + b.username : b.name)}</span>
     </div>`
  ).join('') + `<div class="bot-chip" id="add-bot-chip"><span class="add">+ Додати бота</span></div>`;
  $$('.bot-chip[data-bot]').forEach(c => c.onclick = () => selectBot(c.dataset.bot));
  $('#add-bot-chip').onclick = openAddBotModal;
}

function openAddBotModal() {
  $('#bot-token-input').value = '';
  $('#add-bot-error').textContent = '';
  show('#add-bot-modal');
}

async function confirmAddBot() {
  const token = $('#bot-token-input').value.trim();
  if (!token) return;
  $('#add-bot-error').textContent = 'Перевірка токена…';
  try {
    const me = await TelegramAPI.getMe(token);
    const bot = { id: 'bot_' + me.id, token, name: me.first_name, username: me.username, offset: 0, createdAt: Date.now() };
    await DB.put(DB.STORES.bots, bot);
    state.bots.push(bot);
    hide('#add-bot-modal');
    renderBotSwitcher();
    await selectBot(bot.id);
    resumePolling(bot);
  } catch (e) {
    $('#add-bot-error').textContent = 'Не вдалося перевірити токен: ' + e.message;
  }
}

async function removeCurrentBot() {
  if (!state.currentBotId) return;
  if (!confirm('Видалити бота та всі його локальні дані (чати, повідомлення)? Дію не можна скасувати.')) return;
  const botId = state.currentBotId;
  stopLongPolling(botId);
  await DB.del(DB.STORES.bots, botId);
  const chats = await DB.getByIndex(DB.STORES.chats, 'botId', botId);
  for (const c of chats) await DB.del(DB.STORES.chats, c.id);
  const allMsgs = await DB.getAll(DB.STORES.messages);
  for (const m of allMsgs) if (m.botId === botId) await DB.del(DB.STORES.messages, m.id);
  state.bots = state.bots.filter(b => b.id !== botId);
  state.currentBotId = null;
  hide('#settings-modal');
  renderBotSwitcher();
  if (state.bots.length) await selectBot(state.bots[0].id);
  else { hide('#chat-view'); show('#chat-empty'); $('#chat-list').innerHTML = ''; openAddBotModal(); }
}

function resumePolling(bot) {
  startLongPolling(bot, {
    intervalMs: state.settings.pollingInterval || 1000,
    getOffset: async () => (await DB.get(DB.STORES.bots, bot.id))?.offset || 0,
    setOffset: async (offset) => {
      const fresh = await DB.get(DB.STORES.bots, bot.id);
      if (fresh) { fresh.offset = offset; await DB.put(DB.STORES.bots, fresh); }
    },
    onUpdate: (u) => handleUpdate(bot.id, u),
    onError: (e) => console.warn('Polling error for', bot.id, e.message),
  });
}

// ---------------------------------------------------------------------
// INCOMING UPDATES
// ---------------------------------------------------------------------
async function handleUpdate(botId, update) {
  if (update.message || update.edited_message) {
    const msg = update.message || update.edited_message;
    const chatId = msg.chat.id;
    const chatKey = `${botId}:${chatId}`;
    await upsertChatFromMessage(botId, chatKey, msg);
    await storeMessage(botId, chatKey, msg, !!update.edited_message);
    if (state.currentChatKey === chatKey) await renderChatMessages(chatKey, { append: true });
    else bumpUnread(chatKey);
    if (state.currentBotId === botId) renderChatList();
    if (state.settings.sound && !update.edited_message) playNotifySound();
  } else if (update.callback_query) {
    const cb = update.callback_query;
    // Автовідповідь, щоб прибрати "годинник" завантаження на кнопці у користувача
    TelegramAPI.answerCallbackQuery(getBotToken(botId), cb.id).catch(() => {});
    if (cb.message) {
      const chatKey = `${botId}:${cb.message.chat.id}`;
      await storeMessage(botId, chatKey, cb.message, true);
      if (state.currentChatKey === chatKey) await renderChatMessages(chatKey, { append: true });
    }
  }
}

function getBotToken(botId) {
  const b = state.bots.find(b => b.id === botId);
  return b ? b.token : null;
}

async function upsertChatFromMessage(botId, chatKey, msg) {
  const chat = msg.chat;
  let rec = await DB.get(DB.STORES.chats, chatKey);
  rec = rec || { id: chatKey, botId, chatId: chat.id, unread: 0 };
  rec.type = chat.type;
  rec.title = chat.type === 'private' ? [chat.first_name, chat.last_name].filter(Boolean).join(' ') : (chat.title || 'Чат');
  rec.username = chat.username;
  rec.first_name = chat.first_name;
  rec.last_name = chat.last_name;
  rec.raw = chat;
  rec.lastMessageText = summarizeMessage(msg);
  rec.lastMessageTs = (msg.date || Date.now() / 1000) * 1000;
  rec.firstSeen = rec.firstSeen || rec.lastMessageTs;
  await DB.put(DB.STORES.chats, rec);
  const list = state.chatsCache[botId] || [];
  const idx = list.findIndex(c => c.id === chatKey);
  if (idx >= 0) list[idx] = rec; else list.push(rec);
  state.chatsCache[botId] = list;
}

function bumpUnread(chatKey) {
  const [botId] = chatKey.split(':');
  const list = state.chatsCache[botId] || [];
  const c = list.find(c => c.id === chatKey);
  if (c) { c.unread = (c.unread || 0) + 1; DB.put(DB.STORES.chats, c); }
  if (state.currentBotId === botId) renderChatList();
}

function summarizeMessage(msg) {
  if (msg.text) return msg.text.slice(0, 80);
  if (msg.photo) return '📷 Фото';
  if (msg.video) return '🎥 Відео';
  if (msg.video_note) return '⚪ Відеоповідомлення';
  if (msg.voice) return '🎤 Голосове';
  if (msg.audio) return '🎵 Аудіо';
  if (msg.document) return '📄 ' + (msg.document.file_name || 'Документ');
  if (msg.sticker) return '🩹 Стікер ' + (msg.sticker.emoji || '');
  if (msg.poll) return '📊 ' + msg.poll.question;
  if (msg.location) return '📍 Геопозиція';
  if (msg.contact) return '👤 Контакт';
  return 'Повідомлення';
}

async function storeMessage(botId, chatKey, msg, isEdit) {
  const id = `${botId}:${chatKey.split(':')[1]}:${msg.message_id}`;
  const hasMedia = !!(msg.photo || msg.video || msg.video_note || msg.voice || msg.audio || msg.document || msg.sticker);
  const rec = { id, botId, chatKey, msgId: msg.message_id, ts: (msg.date || Date.now() / 1000) * 1000, hasMedia, raw: msg, out: false };
  await DB.put(DB.STORES.messages, rec);
  const cache = state.messagesCache[chatKey] || [];
  const idx = cache.findIndex(m => m.id === id);
  if (idx >= 0) cache[idx] = rec; else cache.push(rec);
  state.messagesCache[chatKey] = cache;
}

async function storeOutgoingMessage(botId, chatKey, resultMsg) {
  await storeMessage(botId, chatKey, resultMsg, false);
  const cache = state.messagesCache[chatKey] || [];
  const rec = cache[cache.length - 1];
  if (rec) rec.out = true;
  await DB.put(DB.STORES.messages, { ...rec });
  await upsertChatFromMessage(botId, chatKey, resultMsg);
}

// ---------------------------------------------------------------------
// SELECT BOT / CHAT
// ---------------------------------------------------------------------
async function selectBot(botId) {
  state.currentBotId = botId;
  renderBotSwitcher();
  if (!state.chatsCache[botId]) {
    state.chatsCache[botId] = (await DB.getByIndex(DB.STORES.chats, 'botId', botId)).sort((a, b) => b.lastMessageTs - a.lastMessageTs);
  }
  renderChatList();
  hide('#chat-view'); show('#chat-empty');
  state.currentChatKey = null;
}

function renderChatList(filter = '') {
  const list = (state.chatsCache[state.currentBotId] || []).slice().sort((a, b) => b.lastMessageTs - a.lastMessageTs);
  const f = filter.trim().toLowerCase();
  const filtered = f ? list.filter(c => (c.title || '').toLowerCase().includes(f) || (c.username || '').toLowerCase().includes(f)) : list;
  $('#chat-list').innerHTML = filtered.map(c => `
    <div class="chat-item ${c.id === state.currentChatKey ? 'active' : ''}" data-chat="${c.id}">
      ${avatarHtml(c.title)}
      <div class="meta">
        <div class="row1"><span class="name">${escapeHtml(c.title || 'Чат')}</span><span class="time">${fmtTime(c.lastMessageTs)}</span></div>
        <div class="row2"><span class="preview">${escapeHtml(c.lastMessageText || '')}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>
      </div>
    </div>`).join('') || '<div style="padding:20px;color:var(--text-2);text-align:center;">Ще немає чатів. Напишіть боту в Telegram, щоб розпочати.</div>';
  $$('.chat-item').forEach(el => el.onclick = () => selectChat(el.dataset.chat));
}

function avatarHtml(title) {
  const letter = (title || '?').trim()[0]?.toUpperCase() || '?';
  return `<div class="avatar">${letter}</div>`;
}

async function selectChat(chatKey) {
  state.currentChatKey = chatKey;
  const chat = await DB.get(DB.STORES.chats, chatKey);
  if (chat) { chat.unread = 0; await DB.put(DB.STORES.chats, chat); }
  renderChatList();
  document.body.classList.add('show-chat');
  hide('#chat-empty'); show('#chat-view');
  $('#chat-header-name').textContent = chat?.title || 'Чат';
  $('#chat-header-status').textContent = chat?.type === 'private' ? (chat.username ? '@' + chat.username : 'приватний чат') : chat?.type;
  $('#chat-header-avatar').innerHTML = avatarHtml(chat?.title).match(/>([^<]*)</)[1];
  state.replyTo = null; hide('#reply-preview');
  await renderChatMessages(chatKey, { initial: true });
  renderRightPanel(chat);
}

// ---------------------------------------------------------------------
// MESSAGES RENDERING (з базовою "лінивою" підвантаженням — віртуалізація вікна)
// ---------------------------------------------------------------------
const PAGE_SIZE = 40;

async function renderChatMessages(chatKey, { initial = false, append = false } = {}) {
  if (!state.messagesCache[chatKey] || initial) {
    state.messagesCache[chatKey] = (await DB.getByIndex(DB.STORES.messages, 'chatKey', chatKey)).sort((a, b) => a.ts - b.ts);
    state.renderedCount[chatKey] = Math.min(PAGE_SIZE, state.messagesCache[chatKey].length);
  }
  const all = state.messagesCache[chatKey];
  if (append) state.renderedCount[chatKey] = all.length;
  const startIdx = Math.max(0, all.length - state.renderedCount[chatKey]);
  const windowMsgs = all.slice(startIdx);

  const container = $('#messages');
  const wasNearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 120;
  container.innerHTML = renderLoadMoreBtn(startIdx) + windowMsgs.map(m => renderMessageGroup(m)).join('');
  bindMessageEvents(container);
  const loadMoreBtn = $('#load-more-btn');
  if (loadMoreBtn) loadMoreBtn.onclick = () => { state.renderedCount[chatKey] = Math.min(all.length, state.renderedCount[chatKey] + PAGE_SIZE); renderChatMessages(chatKey); };
  if (append && wasNearBottom || initial) container.scrollTop = container.scrollHeight;
}

function renderLoadMoreBtn(startIdx) {
  if (startIdx <= 0) return '';
  return `<div style="text-align:center;padding:8px;"><button class="btn btn-secondary" id="load-more-btn">Завантажити попередні</button></div>`;
}

let lastDaySep = null;
function renderMessageGroup(m) {
  const msg = m.raw;
  const day = new Date(m.ts).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
  let daySepHtml = '';
  if (day !== lastDaySep) { daySepHtml = `<div class="day-sep">${day}</div>`; lastDaySep = day; }
  return daySepHtml + renderBubble(m, msg);
}

function renderBubble(m, msg) {
  const out = m.out;
  let inner = '';
  if (msg.reply_to_message) {
    inner += `<div class="reply-quote">${escapeHtml(summarizeMessage(msg.reply_to_message))}</div>`;
  }
  inner += renderContent(msg);
  if (msg.reply_markup?.inline_keyboard) inner += renderInlineKeyboard(msg.reply_markup.inline_keyboard, m.id);
  const reactions = groupReactions(msg);
  if (reactions) inner += reactions;
  inner += `<div class="meta"><span>${fmtTime(m.ts)}</span>${out ? '<span>✓✓</span>' : ''}</div>`;
  return `<div class="msg-row ${out ? 'out' : 'in'}" data-msgid="${m.id}"><div class="bubble">${inner}</div></div>`;
}

function groupReactions(msg) {
  // Bot API 7.x надсилає реакції окремим апдейтом message_reaction; тут — заглушка для майбутнього розширення.
  return '';
}

function renderInlineKeyboard(rows, msgDomId) {
  return `<div class="inline-kb">${rows.map(row =>
    `<div class="inline-kb-row">${row.map(btn =>
      `<button data-cb="${encodeURIComponent(btn.callback_data || '')}" data-url="${encodeURIComponent(btn.url || '')}" data-msg="${msgDomId}">${escapeHtml(btn.text)}</button>`
    ).join('')}</div>`
  ).join('')}</div>`;
}

function renderContent(msg) {
  if (msg.text) return formatText(msg.text, msg.entities);
  if (msg.caption) var captionHtml = `<div style="margin-top:4px;">${formatText(msg.caption, msg.caption_entities)}</div>`; else captionHtml = '';

  if (msg.photo) {
    const largest = msg.photo[msg.photo.length - 1];
    return mediaImgTag(largest.file_id) + captionHtml;
  }
  if (msg.video) return mediaVideoTag(msg.video.file_id) + captionHtml;
  if (msg.video_note) return `<div class="video-note">${mediaVideoTag(msg.video_note.file_id, true)}</div>`;
  if (msg.voice) return renderVoice(msg.voice) + captionHtml;
  if (msg.audio) return `<div class="doc">🎵 <span>${escapeHtml(msg.audio.title || msg.audio.file_name || 'Аудіо')}</span></div>` + captionHtml;
  if (msg.document) return `<div class="doc">📄 <span>${escapeHtml(msg.document.file_name || 'Документ')}</span></div>` + captionHtml;
  if (msg.sticker) return renderSticker(msg.sticker);
  if (msg.poll) return renderPoll(msg.poll);
  if (msg.location) return `📍 <a href="https://maps.google.com/?q=${msg.location.latitude},${msg.location.longitude}" target="_blank" rel="noopener">Геопозиція (${msg.location.latitude.toFixed(4)}, ${msg.location.longitude.toFixed(4)})</a>`;
  if (msg.contact) return `👤 ${escapeHtml(msg.contact.first_name || '')} ${escapeHtml(msg.contact.last_name || '')} — ${escapeHtml(msg.contact.phone_number || '')}`;
  return '<i style="color:var(--text-2);">Непідтримуваний тип повідомлення</i>';
}

function renderPoll(poll) {
  const total = poll.total_voter_count || 0;
  const opts = poll.options.map(o => {
    const pct = total ? Math.round((o.voter_count / total) * 100) : 0;
    return `<div style="margin:4px 0;"><div style="display:flex;justify-content:space-between;font-size:13px;"><span>${escapeHtml(o.text)}</span><span>${pct}%</span></div>
      <div style="background:var(--bg-hover);border-radius:4px;height:6px;"><div style="width:${pct}%;background:var(--accent);height:6px;border-radius:4px;"></div></div></div>`;
  }).join('');
  return `<div><b>📊 ${escapeHtml(poll.question)}</b>${opts}<div style="font-size:12px;color:var(--text-2);">${total} голос(ів)</div></div>`;
}

function renderVoice(voice) {
  const bars = Array.from({ length: 28 }).map(() => Math.round(4 + Math.random() * 20));
  return `<div class="voice-msg"><button class="icon-btn play-voice" data-file="${voice.file_id}">▶️</button>
    <canvas width="180" height="32" data-bars='${JSON.stringify(bars)}'></canvas>
    <span style="font-size:12px;color:var(--text-2);">${voice.duration}s</span></div>`;
}

function renderSticker(sticker) {
  const boxId = 'stk_' + Math.random().toString(36).slice(2);
  if (sticker.is_video) return `<div class="sticker-box" id="${boxId}" data-video-sticker="${sticker.file_id}"></div>`;
  if (sticker.is_animated) return `<div class="sticker-box" id="${boxId}" data-tgs-sticker="${sticker.file_id}"><span style="font-size:40px;">${sticker.emoji || '🩹'}</span></div>`;
  return `<div class="sticker-box" id="${boxId}" data-static-sticker="${sticker.file_id}"><span style="font-size:56px;">${sticker.emoji || '🩹'}</span></div>`;
}

function mediaImgTag(fileId) {
  return `<img class="media" data-file="${fileId}" alt="photo" src="" onerror="this.style.display='none'">`;
}
function mediaVideoTag(fileId, note) {
  return `<video class="media" data-file="${fileId}" controls ${note ? 'muted loop autoplay playsinline' : ''}></video>`;
}

// Ліниве завантаження реальних медіафайлів через getFile + кеш IndexedDB (розділ 6 ТЗ)
async function bindMessageEvents(container) {
  const token = getBotToken(state.currentBotId);
  for (const img of container.querySelectorAll('img.media[data-file]')) resolveMediaEl(img, token);
  for (const vid of container.querySelectorAll('video.media[data-file]')) resolveMediaEl(vid, token);
  for (const box of container.querySelectorAll('[data-static-sticker],[data-video-sticker],[data-tgs-sticker]')) resolveStickerEl(box, token);
  for (const canvas of container.querySelectorAll('.voice-msg canvas')) drawWaveform(canvas);
  container.querySelectorAll('.play-voice').forEach(btn => btn.onclick = () => playVoice(btn, token));
  container.querySelectorAll('.inline-kb button').forEach(btn => btn.onclick = () => onInlineButton(btn));
}

async function resolveMediaEl(el, token) {
  const fileId = el.dataset.file;
  const cached = await DB.get(DB.STORES.mediaCache, fileId);
  if (cached) { el.src = URL.createObjectURL(cached.blob); return; }
  try {
    const file = await TelegramAPI.getFile(token, fileId);
    const url = TelegramAPI.fileUrl(token, file.file_path);
    el.src = url;
    fetch(url).then(r => r.blob()).then(blob => DB.put(DB.STORES.mediaCache, { id: fileId, blob, ts: Date.now() })).then(() => DB.pruneMediaCache());
  } catch (e) { console.warn('media load failed', e.message); }
}

async function resolveStickerEl(el, token) {
  const fileId = el.dataset.staticSticker || el.dataset.videoSticker || el.dataset.tgsSticker;
  try {
    const file = await TelegramAPI.getFile(token, fileId);
    const url = TelegramAPI.fileUrl(token, file.file_path);
    if (el.dataset.staticSticker) { el.innerHTML = `<img src="${url}">`; }
    else if (el.dataset.videoSticker) { el.innerHTML = `<video src="${url}" autoplay loop muted playsinline></video>`; }
    else if (el.dataset.tgsSticker && window.pako && window.lottie) {
      const buf = await (await fetch(url)).arrayBuffer();
      const json = JSON.parse(window.pako.inflate(new Uint8Array(buf), { to: 'string' }));
      el.innerHTML = '';
      window.lottie.loadAnimation({ container: el, renderer: 'svg', loop: true, autoplay: true, animationData: json });
    }
  } catch (e) { /* лишаємо емодзі-заглушку */ }
}

function drawWaveform(canvas) {
  const bars = JSON.parse(canvas.dataset.bars);
  const ctx = canvas.getContext('2d');
  const w = canvas.width / bars.length;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent');
  bars.forEach((h, i) => ctx.fillRect(i * w, (32 - h) / 2, w - 2, h));
}
async function playVoice(btn, token) {
  const fileId = btn.dataset.file;
  const cached = await DB.get(DB.STORES.mediaCache, fileId);
  let url;
  if (cached) url = URL.createObjectURL(cached.blob);
  else {
    const file = await TelegramAPI.getFile(token, fileId);
    url = TelegramAPI.fileUrl(token, file.file_path);
    fetch(url).then(r => r.blob()).then(blob => DB.put(DB.STORES.mediaCache, { id: fileId, blob, ts: Date.now() }));
  }
  const audio = new Audio(url);
  btn.textContent = '⏸️';
  audio.play();
  audio.onended = () => btn.textContent = '▶️';
}

async function onInlineButton(btn) {
  const url = decodeURIComponent(btn.dataset.url || '');
  if (url) { window.open(url, '_blank'); return; }
  // callback_data кнопки без бекенду ми не можемо "натиснути" від імені юзера (це робить клієнт Telegram).
  // Показуємо підказку, оскільки Bot API не дозволяє боту емулювати натискання власної кнопки.
  alert('Ця кнопка активується користувачем у Telegram. Із застосунку-адміністратора її не можна "натиснути" від імені клієнта.');
}

// ---------------------------------------------------------------------
// TEXT FORMATTING (рендер вхідних entities Telegram → HTML)
// ---------------------------------------------------------------------
function formatText(text, entities) {
  if (!entities || !entities.length) return escapeHtml(text).replace(/\n/g, '<br>');
  const chars = Array.from(text);
  const openTags = {};
  const sorted = entities.slice().sort((a, b) => a.offset - b.offset);
  let html = '';
  let i = 0;
  const points = new Set([0, chars.length]);
  sorted.forEach(e => { points.add(e.offset); points.add(e.offset + e.length); });
  const sortedPoints = Array.from(points).sort((a, b) => a - b);
  for (let p = 0; p < sortedPoints.length - 1; p++) {
    const start = sortedPoints[p], end = sortedPoints[p + 1];
    const segment = escapeHtml(chars.slice(start, end).join(''));
    const active = sorted.filter(e => e.offset <= start && e.offset + e.length >= end);
    html += wrapEntities(segment, active);
  }
  return html.replace(/\n/g, '<br>');
}
function wrapEntities(segment, entities) {
  let s = segment;
  for (const e of entities) {
    switch (e.type) {
      case 'bold': s = `<b>${s}</b>`; break;
      case 'italic': s = `<i>${s}</i>`; break;
      case 'code': s = `<code>${s}</code>`; break;
      case 'pre': s = `<pre>${s}</pre>`; break;
      case 'strikethrough': s = `<s>${s}</s>`; break;
      case 'underline': s = `<u>${s}</u>`; break;
      case 'spoiler': s = `<span style="background:currentColor;border-radius:3px;">${s}</span>`; break;
      case 'blockquote': s = `<blockquote style="border-left:3px solid var(--accent);padding-left:8px;margin:4px 0;">${s}</blockquote>`; break;
      case 'text_link': s = `<a href="${e.url}" target="_blank" rel="noopener">${s}</a>`; break;
      case 'url': s = `<a href="${s}" target="_blank" rel="noopener">${s}</a>`; break;
      case 'mention': case 'hashtag': case 'code_reference': s = `<span style="color:var(--accent);">${s}</span>`; break;
    }
  }
  return s;
}

// ---------------------------------------------------------------------
// COMPOSER — надсилання
// ---------------------------------------------------------------------
async function sendCurrentMessage() {
  const input = $('#msg-input');
  const text = input.value.trim();
  if (!text || !state.currentChatKey) return;
  const [botId, chatId] = state.currentChatKey.split(':');
  const token = getBotToken(botId);
  const opts = {};
  if (state.replyTo) opts.reply_to_message_id = state.replyTo.msgId;
  input.value = ''; autoGrow(input);
  try {
    const result = await TelegramAPI.sendMessage(token, chatId, text, opts);
    await storeOutgoingMessage(botId, state.currentChatKey, result);
    await renderChatMessages(state.currentChatKey, { append: true });
    renderChatList();
    cancelReply();
  } catch (e) {
    alert('Помилка надсилання: ' + e.message);
  }
}

async function sendFile(file) {
  if (!state.currentChatKey) return;
  const [botId, chatId] = state.currentChatKey.split(':');
  const token = getBotToken(botId);
  const { method, field } = pickSendMethod(file);
  try {
    const result = await TelegramAPI.sendMedia(token, method, chatId, field, file);
    await storeOutgoingMessage(botId, state.currentChatKey, result);
    await renderChatMessages(state.currentChatKey, { append: true });
    renderChatList();
  } catch (e) {
    alert('Помилка надсилання файлу: ' + e.message);
  }
}
function pickSendMethod(file) {
  if (file.type.startsWith('image/')) return { method: 'sendPhoto', field: 'photo' };
  if (file.type.startsWith('video/')) return { method: 'sendVideo', field: 'video' };
  if (file.type.startsWith('audio/')) return { method: 'sendVoice', field: 'voice' };
  return { method: 'sendDocument', field: 'document' };
}

function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(140, el.scrollHeight) + 'px'; }

function startReply(msgRecId) {
  const rec = findMessageById(msgRecId);
  if (!rec) return;
  state.replyTo = rec;
  $('#reply-preview-text').textContent = summarizeMessage(rec.raw);
  show('#reply-preview');
}
function cancelReply() { state.replyTo = null; hide('#reply-preview'); }
function findMessageById(id) {
  for (const key in state.messagesCache) {
    const found = state.messagesCache[key].find(m => m.id === id);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------
// RIGHT PANEL — інформація про користувача
// ---------------------------------------------------------------------
function renderRightPanel(chat) {
  if (!chat) return;
  const raw = chat.raw || {};
  $('#right-content').innerHTML = `
    <div class="big-avatar">${avatarHtml(chat.title).match(/>([^<]*)</)[1]}</div>
    <div class="info-name">${escapeHtml(chat.title || '')}</div>
    <div class="info-row"><label>User ID</label><div class="val">${chat.chatId}</div></div>
    ${raw.username ? `<div class="info-row"><label>Username</label><div class="val">@${escapeHtml(raw.username)}</div></div>` : ''}
    ${raw.first_name ? `<div class="info-row"><label>First name</label><div class="val">${escapeHtml(raw.first_name)}</div></div>` : ''}
    ${raw.last_name ? `<div class="info-row"><label>Last name</label><div class="val">${escapeHtml(raw.last_name)}</div></div>` : ''}
    <div class="info-row"><label>Перше повідомлення</label><div class="val">${fmtDateTime(chat.firstSeen)}</div></div>
    <div class="info-row"><label>Останнє повідомлення</label><div class="val">${fmtDateTime(chat.lastMessageTs)}</div></div>
    <div class="info-row"><label>Повний JSON (Bot API)</label><pre>${escapeHtml(JSON.stringify(raw, null, 2))}</pre></div>
  `;
}

// ---------------------------------------------------------------------
// BOT PROFILE (settings modal)
// ---------------------------------------------------------------------
async function loadBotProfileIntoSettings() {
  const token = getBotToken(state.currentBotId);
  if (!token) return;
  try {
    const [name, desc, shortDesc, commands] = await Promise.all([
      TelegramAPI.getMyName(token), TelegramAPI.getMyDescription(token),
      TelegramAPI.getMyDescription(token).catch(() => ({ description: '' })), TelegramAPI.getMyCommands(token)
    ]);
    $('#bot-name-input').value = name.name || '';
    $('#bot-desc-input').value = desc.description || '';
    $('#bot-commands-input').value = commands.map(c => `${c.command} — ${c.description}`).join('\n');
  } catch (e) { /* ignore */ }
}
async function saveBotProfile() {
  const token = getBotToken(state.currentBotId);
  if (!token) return;
  const msgEl = $('#profile-save-msg'); msgEl.textContent = 'Збереження…';
  try {
    const name = $('#bot-name-input').value.trim();
    const desc = $('#bot-desc-input').value.trim();
    const shortDesc = $('#bot-short-desc-input').value.trim();
    if (name) await TelegramAPI.setMyName(token, name);
    if (desc) await TelegramAPI.setMyDescription(token, desc);
    if (shortDesc) await TelegramAPI.setMyShortDescription(token, shortDesc);
    const commandsText = $('#bot-commands-input').value.trim();
    if (commandsText) {
      const commands = commandsText.split('\n').filter(Boolean).map(line => {
        const [command, ...rest] = line.split('—');
        return { command: command.trim().replace(/^\//, ''), description: rest.join('—').trim() || command.trim() };
      });
      await TelegramAPI.setMyCommands(token, commands);
    }
    msgEl.textContent = 'Збережено ✓';
  } catch (e) { msgEl.style.color = 'var(--danger)'; msgEl.textContent = 'Помилка: ' + e.message; }
}

// ---------------------------------------------------------------------
// BACKUP EXPORT / IMPORT
// ---------------------------------------------------------------------
async function exportBackup() {
  const bots = await DB.getAll(DB.STORES.bots);
  const chats = await DB.getAll(DB.STORES.chats);
  const messages = await DB.getAll(DB.STORES.messages);
  const payload = { version: 1, exportedAt: Date.now(), bots, chats, messages };
  const json = JSON.stringify(payload);
  let outStr = json;
  if (Crypto.isEncryptionEnabled()) {
    // Додатково шифруємо весь бекап тим самим сесійним ключем (див. crypto.js)
    const enc = await Crypto.encryptValue(payload);
    outStr = JSON.stringify({ encrypted: true, envelope: enc });
  }
  const blob = new Blob([outStr], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bot-manager-backup-${Date.now()}.json`;
  a.click();
}
async function importBackupFile(file) {
  const text = await file.text();
  let payload;
  try {
    const parsed = JSON.parse(text);
    payload = parsed.encrypted ? await Crypto.decryptValue(parsed.envelope) : parsed;
  } catch (e) { alert('Не вдалося прочитати файл бекапу: ' + e.message); return; }
  for (const b of payload.bots || []) await DB.put(DB.STORES.bots, b);
  for (const c of payload.chats || []) await DB.put(DB.STORES.chats, c);
  for (const m of payload.messages || []) await DB.put(DB.STORES.messages, m);
  alert('Бекап імпортовано. Застосунок перезавантажиться.');
  location.reload();
}

// ---------------------------------------------------------------------
// SERVICE WORKER / PWA
// ---------------------------------------------------------------------
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW registration failed', e));
  }
}

// ---------------------------------------------------------------------
// UTIL
// ---------------------------------------------------------------------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(ts) { return new Date(ts).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }); }
function fmtDateTime(ts) { return ts ? new Date(ts).toLocaleString('uk-UA') : '—'; }
function playNotifySound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.05;
    o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 120);
  } catch (e) {}
}

// ---------------------------------------------------------------------
// EVENT WIRING
// ---------------------------------------------------------------------
function wireEvents() {
  $('#skip-pin').onclick = async () => { await DB.metaSet('encryptionEnabled', false); await DB.metaSet('onboarded', true); await startApp(); };
  $('#setup-pin').onclick = () => { hide('#onboard-screen'); showLockScreen(true); };

  $('#confirm-add-bot').onclick = confirmAddBot;
  $$('#add-bot-modal [data-close]').forEach(b => b.onclick = () => hide('#add-bot-modal'));

  $('#open-settings-btn').onclick = async () => { renderSettingsModal(); await loadBotProfileIntoSettings(); show('#settings-modal'); };
  $$('#settings-modal [data-close]').forEach(b => b.onclick = () => hide('#settings-modal'));

  $('#msg-input').addEventListener('input', (e) => autoGrow(e.target));
  $('#msg-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrentMessage(); } });
  $('#send-btn').onclick = sendCurrentMessage;
  $('#cancel-reply').onclick = cancelReply;
  $('#attach-btn').onclick = () => $('#file-input').click();
  $('#file-input').onchange = (e) => { if (e.target.files[0]) sendFile(e.target.files[0]); e.target.value = ''; };

  $('#back-btn').onclick = () => document.body.classList.remove('show-chat');
  $('#chat-info-btn').onclick = () => $('#right-panel').classList.toggle('hidden');
  $('#close-right-btn').onclick = () => $('#right-panel').classList.add('hidden');
  $('#chat-search').addEventListener('input', (e) => renderChatList(e.target.value));

  $('#theme-select').onchange = (e) => { state.settings.theme = e.target.value; applyTheme(); saveSettings(); };
  $('#toggle-encryption').onchange = async (e) => {
    if (e.target.checked) { hide('#settings-modal'); showLockScreen(true); }
    else { Crypto.disableEncryption(); await DB.metaSet('encryptionEnabled', false); }
  };
  $('#connection-mode').onchange = (e) => {
    $('#polling-interval-row').classList.toggle('hidden', e.target.value !== 'polling');
    $('#webhook-row').classList.toggle('hidden', e.target.value !== 'webhook');
  };
  $('#polling-interval').onchange = (e) => { state.settings.pollingInterval = parseInt(e.target.value) || 1000; saveSettings(); const bot = state.bots.find(b => b.id === state.currentBotId); if (bot) resumePolling(bot); };
  $('#apply-webhook').onclick = async () => {
    const token = getBotToken(state.currentBotId); const url = $('#webhook-url').value.trim();
    if (!token || !url) return;
    try { await TelegramAPI.call?.(); } catch (e) {}
    try { stopLongPolling(state.currentBotId); await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(url)}`); alert('Webhook зареєстровано на боці Telegram. Приймати вхідні запити застосунок на GitHub Pages не може — для цього потрібен ваш сервер.'); }
    catch (e) { alert('Помилка: ' + e.message); }
  };
  $('#remove-webhook').onclick = async () => {
    const token = getBotToken(state.currentBotId); if (!token) return;
    await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
    const bot = state.bots.find(b => b.id === state.currentBotId); if (bot) resumePolling(bot);
    alert('Webhook видалено, повернулись на Long Polling.');
  };
  $('#toggle-sound').onchange = (e) => { state.settings.sound = e.target.checked; saveSettings(); };
  $('#toggle-push').onchange = async (e) => {
    state.settings.push = e.target.checked; saveSettings();
    if (e.target.checked && 'Notification' in window) await Notification.requestPermission();
  };
  $('#save-bot-profile').onclick = saveBotProfile;
  $('#remove-bot-btn').onclick = removeCurrentBot;
  $('#export-backup').onclick = exportBackup;
  $('#import-backup').onclick = () => $('#import-file-input').click();
  $('#import-file-input').onchange = (e) => { if (e.target.files[0]) importBackupFile(e.target.files[0]); };

  document.addEventListener('click', (e) => {
    const row = e.target.closest?.('.msg-row');
    if (row && e.detail === 2) startReply(row.dataset.msgid); // подвійний клік = відповісти
  });
}

function renderSettingsModal() {
  $('#theme-select').value = state.settings.theme;
  $('#accent-dots').innerHTML = ACCENTS.map(c =>
    `<div class="accent-dot ${c === state.settings.accent ? 'active' : ''}" style="background:${c}" data-c="${c}"></div>`).join('');
  $$('.accent-dot').forEach(d => d.onclick = () => { state.settings.accent = d.dataset.c; applyTheme(); saveSettings(); renderSettingsModal(); });
  $('#toggle-encryption').checked = Crypto.isEncryptionEnabled();
  $('#polling-interval').value = state.settings.pollingInterval;
}

// ---------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => { wireEvents(); boot(); });
window.addEventListener('beforeunload', () => stopAllPolling());
