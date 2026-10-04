import { TelegramAPI, startLongPolling, stopLongPolling, stopAllPolling } from './api.js';
import * as DB from './db.js';
import * as Crypto from './crypto.js';
import * as Media from './media.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const ACCENTS = ['#3390ec', '#e53935', '#8e24aa', '#43a047', '#fb8c00', '#00acc1'];
const WALLPAPER_PRESETS = [
  { id: 'default', label: 'За замовчуванням', css: 'var(--bg-chat)' },
  { id: 'p1', label: '', css: 'linear-gradient(135deg,#dee9ff,#f4e9ff)' },
  { id: 'p2', label: '', css: 'linear-gradient(135deg,#d9f7e8,#e9fbd4)' },
  { id: 'p3', label: '', css: 'linear-gradient(135deg,#ffe8d6,#ffd6e0)' },
  { id: 'p4', label: '', css: 'repeating-linear-gradient(45deg,#eef2f5,#eef2f5 10px,#e4eaef 10px,#e4eaef 20px)' },
  { id: 'dark1', label: '', css: 'linear-gradient(135deg,#1b2b3a,#0e1621)' },
];

const state = {
  bots: [],
  currentBotId: null,
  currentChatKey: null,
  chatsCache: {},
  messagesCache: {},
  renderedCount: {},
  replyTo: null,
  pinBuffer: '',
  pendingPinSetup: false,
  settings: {
    theme: 'system', accent: ACCENTS[0], sound: true, push: false, pollingInterval: 1000,
    uiScale: 1, msgScale: 1, wallpaper: { type: 'preset', value: 'default' },
  },
  activeRecorder: null,   // { kind, controller }
  galleryFiles: [],       // File[] очікують підтвердження перед відправкою
  navStack: ['root'],
};

// ---------------------------------------------------------------------
// BOOTSTRAP
// ---------------------------------------------------------------------
async function boot() {
  await DB.openDb();
  await loadSettings();
  applyTheme();
  applyScale();
  applyWallpaper();

  const encEnabled = await DB.metaGet('encryptionEnabled');
  const onboarded = await DB.metaGet('onboarded');

  if (!onboarded) { show('#onboard-screen'); return; }
  if (encEnabled) { Crypto.setEncryptionEnabledFlag(true); showLockScreen(false); }
  else { await startApp(); }
  registerServiceWorker();
}

async function startApp() {
  hide('#lock-screen'); hide('#onboard-screen');
  history.replaceState({ nav: 'root' }, '');
  state.navStack = ['root'];
  state.bots = await DB.getAll(DB.STORES.bots);
  if (state.bots.length) await selectBot(state.bots[0].id);
  else { updateLeftHeader(); openAddBotModal(); }
  for (const bot of state.bots) resumePolling(bot);
}

function show(sel) { $(sel).classList.remove('hidden'); }
function hide(sel) { $(sel).classList.add('hidden'); }

// ---------------------------------------------------------------------
// NAVIGATION (History API) — системна кнопка "Назад" закриває оверлеї, а не застосунок
// ---------------------------------------------------------------------
const NAV_CLOSERS = {
  chat: () => document.body.classList.remove('show-chat'),
  settings: () => hide('#settings-modal'),
  'add-bot': () => hide('#add-bot-modal'),
  gallery: () => { hide('#gallery-modal'); clearGalleryPreview(); },
  'attach-menu': () => hide('#attach-menu'),
  recorder: () => { hide('#recorder-overlay'); cancelActiveRecording(); },
  'right-panel': () => $('#right-panel').classList.add('hidden'),
};

function pushNav(name) {
  if (state.navStack[state.navStack.length - 1] === name) return;
  state.navStack.push(name);
  history.pushState({ navId: state.navStack.length, name }, '');
}
function closeNav(name) {
  // Якщо цей екран справді відкритий через navStack — йдемо в history.back(), що викличе popstate і сам закриє.
  if (state.navStack[state.navStack.length - 1] === name) { history.back(); }
  else { NAV_CLOSERS[name] && NAV_CLOSERS[name](); }
}
window.addEventListener('popstate', () => {
  if (state.navStack.length <= 1) return;
  const closed = state.navStack.pop();
  NAV_CLOSERS[closed] && NAV_CLOSERS[closed]();
});

// ---------------------------------------------------------------------
// SETTINGS / THEME / SCALE / WALLPAPER
// ---------------------------------------------------------------------
async function loadSettings() {
  const s = await DB.metaGet('appSettings');
  if (s) state.settings = { ...state.settings, ...s, wallpaper: { ...state.settings.wallpaper, ...(s.wallpaper || {}) } };
}
async function saveSettings() { await DB.metaSet('appSettings', state.settings); }

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.settings.theme === 'system' ? '' : state.settings.theme);
  document.documentElement.style.setProperty('--accent', state.settings.accent);
  const rgb = hexToRgb(state.settings.accent);
  document.documentElement.style.setProperty('--accent-rgb', `${rgb.r},${rgb.g},${rgb.b}`);
}
function hexToRgb(hex) { const v = parseInt(hex.slice(1), 16); return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }; }

function applyScale() {
  document.documentElement.style.setProperty('--ui-scale', state.settings.uiScale);
  document.documentElement.style.setProperty('--msg-scale', state.settings.msgScale);
  $('#ui-scale-range') && ($('#ui-scale-range').value = Math.round(state.settings.uiScale * 100));
  $('#ui-scale-val') && ($('#ui-scale-val').textContent = Math.round(state.settings.uiScale * 100) + '%');
  $('#msg-scale-range') && ($('#msg-scale-range').value = Math.round(state.settings.msgScale * 100));
  $('#msg-scale-val') && ($('#msg-scale-val').textContent = Math.round(state.settings.msgScale * 100) + '%');
}

function applyWallpaper() {
  const wp = state.settings.wallpaper;
  if (wp.type === 'image') {
    document.documentElement.style.setProperty('--wallpaper-image', `url(${wp.value})`);
    document.documentElement.style.setProperty('--wallpaper-color', 'var(--bg-chat)');
  } else {
    const preset = WALLPAPER_PRESETS.find(p => p.id === wp.value) || WALLPAPER_PRESETS[0];
    document.documentElement.style.setProperty('--wallpaper-image', preset.css.startsWith('linear') || preset.css.startsWith('repeating') ? preset.css : 'none');
    document.documentElement.style.setProperty('--wallpaper-color', preset.css.startsWith('var') ? preset.css : 'transparent');
  }
}

function renderWallpaperPresets() {
  $('#wallpaper-presets').innerHTML = WALLPAPER_PRESETS.map(p =>
    `<div class="wallpaper-swatch ${state.settings.wallpaper.type === 'preset' && state.settings.wallpaper.value === p.id ? 'active' : ''}" data-preset="${p.id}" style="background:${p.css};"></div>`
  ).join('');
  $$('.wallpaper-swatch').forEach(el => el.onclick = async () => {
    state.settings.wallpaper = { type: 'preset', value: el.dataset.preset };
    applyWallpaper(); await saveSettings(); renderWallpaperPresets();
  });
}

async function compressImageToDataUrl(file, maxDim = 1600, quality = 0.82) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = URL.createObjectURL(file);
  });
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
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
  try { await Crypto.unlockWithPin(pin, salt, check); await startApp(); }
  catch (e) { $('#lock-error').textContent = 'Невірний PIN-код'; renderPinDots(); }
}

// ---------------------------------------------------------------------
// BOTS (керування перенесено в Налаштування → Акаунти)
// ---------------------------------------------------------------------
function updateLeftHeader() {
  const bot = state.bots.find(b => b.id === state.currentBotId);
  $('#left-title').textContent = bot ? (bot.username ? '@' + bot.username : bot.name) : 'Немає ботів';
  const avatarEl = $('#current-bot-avatar');
  avatarEl.innerHTML = (bot?.name || '?').trim()[0]?.toUpperCase() || '?';
  if (bot) fillBotAvatar(avatarEl, bot);
}
async function fillBotAvatar(el, bot) {
  try {
    const url = await Media.getBotAvatarUrl(bot.token, bot.id.replace('bot_', ''));
    if (url) el.innerHTML = `<img src="${url}" alt="">`;
  } catch (e) { /* лишаємо літеру */ }
}

function renderSettingsBotList() {
  $('#settings-bot-list').innerHTML = state.bots.map(b => `
    <div class="settings-bot-row ${b.id === state.currentBotId ? 'active' : ''}" data-bot="${b.id}">
      <div class="avatar" style="width:40px;height:40px;font-size:15px;" data-bot-avatar="${b.id}">${(b.name || '?')[0]?.toUpperCase() || '?'}</div>
      <div class="meta"><div class="name">${escapeHtml(b.name)}</div><div class="sub">${b.username ? '@' + escapeHtml(b.username) : ''}</div></div>
      ${b.id === state.currentBotId ? '<span style="color:var(--accent);font-size:12px;">Активний</span>' : ''}
    </div>`).join('') || '<p style="color:var(--text-2);font-size:13px;">Ще немає доданих ботів.</p>';
  $$('.settings-bot-row').forEach(row => {
    row.onclick = async () => { await selectBot(row.dataset.bot); closeNav('settings'); };
    const avatarEl = row.querySelector('[data-bot-avatar]');
    const bot = state.bots.find(b => b.id === row.dataset.bot);
    if (bot) fillBotAvatar(avatarEl, bot);
  });
}

function openAddBotModal() {
  $('#bot-token-input').value = '';
  $('#add-bot-error').textContent = '';
  pushNav('add-bot');
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
    closeNav('add-bot');
    renderSettingsBotList();
    await selectBot(bot.id);
    resumePolling(bot);
  } catch (e) { $('#add-bot-error').textContent = 'Не вдалося перевірити токен: ' + e.message; }
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
    TelegramAPI.answerCallbackQuery(getBotToken(botId), cb.id).catch(() => {});
    if (cb.message) {
      const chatKey = `${botId}:${cb.message.chat.id}`;
      await storeMessage(botId, chatKey, cb.message, true);
      if (state.currentChatKey === chatKey) await renderChatMessages(chatKey, { append: true });
    }
  }
}

function getBotToken(botId) { const b = state.bots.find(b => b.id === botId); return b ? b.token : null; }

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
  if (rec) { rec.out = true; await DB.put(DB.STORES.messages, { ...rec }); }
  await upsertChatFromMessage(botId, chatKey, resultMsg);
}

// ---------------------------------------------------------------------
// SELECT BOT / CHAT
// ---------------------------------------------------------------------
async function selectBot(botId) {
  state.currentBotId = botId;
  updateLeftHeader();
  if (!state.chatsCache[botId]) {
    state.chatsCache[botId] = (await DB.getByIndex(DB.STORES.chats, 'botId', botId)).sort((a, b) => b.lastMessageTs - a.lastMessageTs);
  }
  renderChatList();
  hide('#chat-view'); show('#chat-empty');
  document.body.classList.remove('show-chat');
  state.currentChatKey = null;
}

function renderChatList(filter = '') {
  const list = (state.chatsCache[state.currentBotId] || []).slice().sort((a, b) => b.lastMessageTs - a.lastMessageTs);
  const f = filter.trim().toLowerCase();
  const filtered = f ? list.filter(c => (c.title || '').toLowerCase().includes(f) || (c.username || '').toLowerCase().includes(f)) : list;
  $('#chat-list').innerHTML = filtered.map(c => `
    <div class="chat-item ${c.id === state.currentChatKey ? 'active' : ''}" data-chat="${c.id}">
      <div class="avatar" data-chat-avatar="${c.id}">${(c.title || '?').trim()[0]?.toUpperCase() || '?'}</div>
      <div class="meta">
        <div class="row1"><span class="name">${escapeHtml(c.title || 'Чат')}</span><span class="time">${fmtTime(c.lastMessageTs)}</span></div>
        <div class="row2"><span class="preview">${escapeHtml(c.lastMessageText || '')}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>
      </div>
    </div>`).join('') || '<div style="padding:20px;color:var(--text-2);text-align:center;">Ще немає чатів. Напишіть боту в Telegram, щоб розпочати.</div>';
  $$('.chat-item').forEach(el => {
    el.onclick = () => selectChat(el.dataset.chat);
    const avatarEl = el.querySelector('[data-chat-avatar]');
    const chat = filtered.find(c => c.id === el.dataset.chat);
    if (chat) fillChatAvatar(avatarEl, chat);
  });
}

async function fillChatAvatar(el, chat) {
  const token = getBotToken(chat.botId || state.currentBotId);
  if (!token) return;
  try {
    const url = await Media.getAvatarUrl(token, chat.chatId, chat.raw?.photo);
    if (url) el.innerHTML = `<img src="${url}" alt="">`;
  } catch (e) { /* лишаємо літеру */ }
}

async function selectChat(chatKey) {
  state.currentChatKey = chatKey;
  const chat = await DB.get(DB.STORES.chats, chatKey);
  if (chat) { chat.unread = 0; await DB.put(DB.STORES.chats, chat); }
  renderChatList();
  document.body.classList.add('show-chat');
  pushNav('chat');
  hide('#chat-empty'); show('#chat-view');
  $('#chat-header-name').textContent = chat?.title || 'Чат';
  $('#chat-header-status').textContent = chat?.type === 'private' ? (chat.username ? '@' + chat.username : 'приватний чат') : chat?.type;
  const headerAvatar = $('#chat-header-avatar');
  headerAvatar.innerHTML = (chat?.title || '?').trim()[0]?.toUpperCase() || '?';
  if (chat) fillChatAvatar(headerAvatar, chat);
  state.replyTo = null; hide('#reply-preview');
  await renderChatMessages(chatKey, { initial: true });
  renderRightPanel(chat);
}

// ---------------------------------------------------------------------
// MESSAGES RENDERING (проста віртуалізація вікна)
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
  lastDaySep = null;
  container.innerHTML = renderLoadMoreBtn(startIdx) + windowMsgs.map(m => renderMessageGroup(m)).join('');
  bindMessageEvents(container);
  const loadMoreBtn = $('#load-more-btn');
  if (loadMoreBtn) loadMoreBtn.onclick = () => { state.renderedCount[chatKey] = Math.min(all.length, state.renderedCount[chatKey] + PAGE_SIZE); renderChatMessages(chatKey); };
  if ((append && wasNearBottom) || initial) container.scrollTop = container.scrollHeight;
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
  if (msg.reply_to_message) inner += `<div class="reply-quote">${escapeHtml(summarizeMessage(msg.reply_to_message))}</div>`;
  inner += renderContent(msg);
  if (msg.reply_markup?.inline_keyboard) inner += renderInlineKeyboard(msg.reply_markup.inline_keyboard, m.id);
  inner += `<div class="meta"><span>${fmtTime(m.ts)}</span>${out ? '<span>✓✓</span>' : ''}</div>`;
  return `<div class="msg-row ${out ? 'out' : 'in'}" data-msgid="${m.id}"><div class="bubble">${inner}</div></div>`;
}

function renderInlineKeyboard(rows, msgDomId) {
  return `<div class="inline-kb">${rows.map(row =>
    `<div class="inline-kb-row">${row.map(btn =>
      `<button data-cb="${encodeURIComponent(btn.callback_data || '')}" data-url="${encodeURIComponent(btn.url || '')}" data-msg="${msgDomId}">${escapeHtml(btn.text)}</button>`
    ).join('')}</div>`
  ).join('')}</div>`;
}

function renderContent(msg) {
  let captionHtml = '';
  if (msg.caption) captionHtml = `<div style="margin-top:4px;">${formatText(msg.caption, msg.caption_entities)}</div>`;

  if (msg.text) return formatText(msg.text, msg.entities);
  if (msg.photo) {
    const p = msg.photo[msg.photo.length - 1];
    return mediaPlaceholder(p.file_id, 'photo') + captionHtml;
  }
  if (msg.video) return mediaPlaceholder(msg.video.file_id, 'video') + captionHtml;
  if (msg.video_note) return `<div class="video-note" data-media-placeholder="${msg.video_note.file_id}" data-kind="video-note"><div class="media-placeholder" style="width:100%;height:100%;border-radius:50%;">⏳</div></div>`;
  if (msg.voice) return renderVoice(msg.voice) + captionHtml;
  if (msg.audio) return `<div class="doc" data-doc-file="${msg.audio.file_id}" data-doc-name="${escapeHtml(msg.audio.title || msg.audio.file_name || 'Аудіо')}">🎵 <span>${escapeHtml(msg.audio.title || msg.audio.file_name || 'Аудіо')}</span></div>` + captionHtml;
  if (msg.document) return `<div class="doc" data-doc-file="${msg.document.file_id}" data-doc-name="${escapeHtml(msg.document.file_name || 'Документ')}">📄 <span>${escapeHtml(msg.document.file_name || 'Документ')}</span></div>` + captionHtml;
  if (msg.sticker) return renderSticker(msg.sticker);
  if (msg.poll) return renderPoll(msg.poll);
  if (msg.location) return `📍 <a href="https://maps.google.com/?q=${msg.location.latitude},${msg.location.longitude}" target="_blank" rel="noopener">Геопозиція (${msg.location.latitude.toFixed(4)}, ${msg.location.longitude.toFixed(4)})</a>`;
  if (msg.contact) return `👤 ${escapeHtml(msg.contact.first_name || '')} ${escapeHtml(msg.contact.last_name || '')} — ${escapeHtml(msg.contact.phone_number || '')}`;
  return '<i style="color:var(--text-2);">Непідтримуваний тип повідомлення</i>';
}

function mediaPlaceholder(fileId, kind) {
  return `<div class="media-placeholder" data-media-placeholder="${fileId}" data-kind="${kind}" style="width:200px;height:140px;">⏳ Завантаження…</div>`;
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
  if (sticker.is_video) return `<div class="sticker-box" data-media-placeholder="${sticker.file_id}" data-kind="sticker-video"><span style="font-size:56px;">${sticker.emoji || '🩹'}</span></div>`;
  if (sticker.is_animated) return `<div class="sticker-box" data-media-placeholder="${sticker.file_id}" data-kind="sticker-tgs"><span style="font-size:40px;">${sticker.emoji || '🩹'}</span></div>`;
  return `<div class="sticker-box" data-media-placeholder="${sticker.file_id}" data-kind="sticker-static"><span style="font-size:56px;">${sticker.emoji || '🩹'}</span></div>`;
}

// --- Надійне ліниве завантаження медіа: плейсхолдер → реальний контент або текст помилки ---
async function bindMessageEvents(container) {
  const token = getBotToken(state.currentBotId);
  if (!token) return;
  for (const el of container.querySelectorAll('[data-media-placeholder]')) resolveMediaPlaceholder(el, token);
  for (const canvas of container.querySelectorAll('.voice-msg canvas')) drawWaveform(canvas);
  container.querySelectorAll('.play-voice').forEach(btn => btn.onclick = () => playVoice(btn, token));
  container.querySelectorAll('.inline-kb button').forEach(btn => btn.onclick = () => onInlineButton(btn));
  container.querySelectorAll('[data-doc-file]').forEach(el => el.onclick = () => openDocument(el, token));
}

async function resolveMediaPlaceholder(el, token) {
  const fileId = el.dataset.mediaPlaceholder;
  const kind = el.dataset.kind;
  try {
    if (kind === 'photo') {
      const url = await Media.fetchTelegramFile(token, fileId);
      el.outerHTML = `<img class="media" src="${url}" alt="photo">`;
    } else if (kind === 'video') {
      const url = await Media.fetchTelegramFile(token, fileId);
      el.outerHTML = `<video class="media" src="${url}" controls preload="metadata"></video>`;
    } else if (kind === 'video-note') {
      const url = await Media.fetchTelegramFile(token, fileId);
      el.innerHTML = `<video src="${url}" controls autoplay muted loop playsinline></video>`;
    } else if (kind === 'sticker-static') {
      const url = await Media.fetchTelegramFile(token, fileId);
      el.innerHTML = `<img src="${url}" alt="sticker">`;
    } else if (kind === 'sticker-video') {
      const url = await Media.fetchTelegramFile(token, fileId);
      el.innerHTML = `<video src="${url}" autoplay loop muted playsinline></video>`;
    } else if (kind === 'sticker-tgs') {
      if (window.pako && window.lottie) {
        const url = await Media.fetchTelegramFile(token, fileId);
        const buf = await (await fetch(url)).arrayBuffer();
        const json = JSON.parse(window.pako.inflate(new Uint8Array(buf), { to: 'string' }));
        el.innerHTML = '';
        window.lottie.loadAnimation({ container: el, renderer: 'svg', loop: true, autoplay: true, animationData: json });
      }
    }
  } catch (e) {
    console.warn('Media load failed for', fileId, e.message);
    if (el.classList.contains('media-placeholder')) { el.textContent = '⚠️ Не вдалося завантажити медіа'; }
    else el.innerHTML = `<div class="media-placeholder">⚠️ Не вдалося завантажити медіа</div>`;
  }
}

async function openDocument(el, token) {
  const fileId = el.dataset.docFile;
  const name = el.dataset.docName;
  const original = el.innerHTML;
  el.innerHTML = `⏳ <span>Завантаження «${name}»…</span>`;
  try {
    const url = await Media.fetchTelegramFile(token, fileId);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    el.innerHTML = original;
  } catch (e) { el.innerHTML = `⚠️ <span>Не вдалося завантажити файл</span>`; }
}

function drawWaveform(canvas) {
  const bars = JSON.parse(canvas.dataset.bars);
  const ctx = canvas.getContext('2d');
  const w = canvas.width / bars.length;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent');
  bars.forEach((h, i) => ctx.fillRect(i * w, (32 - h) / 2, w - 2, h));
}
async function playVoice(btn, token) {
  try {
    const url = await Media.fetchTelegramFile(token, btn.dataset.file);
    const audio = new Audio(url);
    btn.textContent = '⏸️'; audio.play();
    audio.onended = () => btn.textContent = '▶️';
  } catch (e) { alert('Не вдалося відтворити голосове повідомлення'); }
}

async function onInlineButton(btn) {
  const url = decodeURIComponent(btn.dataset.url || '');
  if (url) { window.open(url, '_blank'); return; }
  alert('Ця кнопка активується користувачем у Telegram. Із застосунку-адміністратора її не можна "натиснути" від імені клієнта.');
}

// ---------------------------------------------------------------------
// TEXT FORMATTING
// ---------------------------------------------------------------------
function formatText(text, entities) {
  if (!entities || !entities.length) return escapeHtml(text).replace(/\n/g, '<br>');
  const chars = Array.from(text);
  const sorted = entities.slice().sort((a, b) => a.offset - b.offset);
  const points = new Set([0, chars.length]);
  sorted.forEach(e => { points.add(e.offset); points.add(e.offset + e.length); });
  const sortedPoints = Array.from(points).sort((a, b) => a - b);
  let html = '';
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
      case 'mention': case 'hashtag': s = `<span style="color:var(--accent);">${s}</span>`; break;
    }
  }
  return s;
}

// ---------------------------------------------------------------------
// COMPOSER — текст
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
  } catch (e) { alert('Помилка надсилання: ' + e.message); }
}

async function sendFileDirect(file, extraOpts = {}) {
  if (!state.currentChatKey) return;
  const [botId, chatId] = state.currentChatKey.split(':');
  const token = getBotToken(botId);
  const { method, field } = pickSendMethod(file);
  try {
    const result = await TelegramAPI.sendMedia(token, method, chatId, field, file, extraOpts);
    await storeOutgoingMessage(botId, state.currentChatKey, result);
    await renderChatMessages(state.currentChatKey, { append: true });
    renderChatList();
  } catch (e) { alert('Помилка надсилання файлу: ' + e.message); }
}
function pickSendMethod(file) {
  if (file.type.startsWith('image/')) return { method: 'sendPhoto', field: 'photo' };
  if (file.type.startsWith('video/')) return { method: 'sendVideo', field: 'video' };
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
// ВНУТРІШНЄ МЕНЮ ВКЛАДЕННЯ + ГАЛЕРЕЯ-ПРЕВ'Ю
// ---------------------------------------------------------------------
function toggleAttachMenu() {
  const menu = $('#attach-menu');
  if (menu.classList.contains('hidden')) { show('#attach-menu'); pushNav('attach-menu'); }
  else closeNav('attach-menu');
}
function onAttachAction(action) {
  closeNav('attach-menu');
  if (action === 'photo-video') $('#photo-video-input').click();
  else if (action === 'document') $('#document-input').click();
  else if (action === 'voice') openRecorder('voice');
  else if (action === 'video-note') openRecorder('video-note');
  else if (action === 'location') sendCurrentLocation();
}

function onPhotoVideoPicked(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  state.galleryFiles = files;
  renderGalleryPreview();
  pushNav('gallery');
  show('#gallery-modal');
}
function renderGalleryPreview() {
  $('#gallery-grid').innerHTML = state.galleryFiles.map((f, i) => {
    const url = URL.createObjectURL(f);
    const isVideo = f.type.startsWith('video/');
    return `<div class="gallery-item">${isVideo ? `<video src="${url}" muted></video>` : `<img src="${url}">`}<button class="remove" data-i="${i}">✕</button></div>`;
  }).join('');
  $$('#gallery-grid .remove').forEach(b => b.onclick = () => { state.galleryFiles.splice(+b.dataset.i, 1); state.galleryFiles.length ? renderGalleryPreview() : closeNav('gallery'); });
}
function clearGalleryPreview() { state.galleryFiles = []; $('#gallery-grid').innerHTML = ''; $('#gallery-caption').value = ''; }

async function sendGalleryFiles() {
  const caption = $('#gallery-caption').value.trim();
  const files = state.galleryFiles.slice();
  closeNav('gallery');
  for (let i = 0; i < files.length; i++) {
    await sendFileDirect(files[i], i === 0 && caption ? { caption } : {});
  }
}

async function sendCurrentLocation() {
  if (!navigator.geolocation) { alert('Геолокація недоступна в цьому браузері'); return; }
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const [botId, chatId] = state.currentChatKey.split(':');
    const token = getBotToken(botId);
    try {
      const result = await TelegramAPI.sendLocation(token, chatId, pos.coords.latitude, pos.coords.longitude);
      await storeOutgoingMessage(botId, state.currentChatKey, result);
      await renderChatMessages(state.currentChatKey, { append: true });
    } catch (e) { alert('Помилка надсилання геопозиції: ' + e.message); }
  }, (err) => alert('Не вдалося визначити геопозицію: ' + err.message));
}

// ---------------------------------------------------------------------
// ЗАПИС ГОЛОСУ / ВІДЕОКРУЖЕЧКА
// ---------------------------------------------------------------------
let recorderTimerInterval = null, recorderStartTs = 0;

async function openRecorder(kind) {
  pushNav('recorder');
  show('#recorder-overlay');
  $('#recorder-video-wrap').classList.toggle('hidden', kind !== 'video-note');
  $('#recorder-waveform').classList.toggle('hidden', kind !== 'voice');
  $('#recorder-timer').textContent = '00:00';
  recorderStartTs = Date.now();
  recorderTimerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - recorderStartTs) / 1000);
    $('#recorder-timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
  try {
    if (kind === 'voice') {
      const ctrl = await Media.startVoiceRecording({ onLevel: drawLiveLevel });
      state.activeRecorder = { kind, ctrl };
    } else {
      const ctrl = await Media.startVideoNoteRecording($('#recorder-video'));
      state.activeRecorder = { kind, ctrl };
    }
  } catch (e) {
    alert('Немає доступу до мікрофона/камери: ' + e.message);
    closeNav('recorder');
  }
}
function drawLiveLevel(level) {
  const canvas = $('#recorder-waveform');
  if (!canvas || canvas.classList.contains('hidden')) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent');
  const bars = 20;
  for (let i = 0; i < bars; i++) {
    const h = Math.max(3, Math.random() * level * canvas.height);
    ctx.fillRect(i * (canvas.width / bars), (canvas.height - h) / 2, canvas.width / bars - 3, h);
  }
}
function cancelActiveRecording() {
  if (recorderTimerInterval) { clearInterval(recorderTimerInterval); recorderTimerInterval = null; }
  if (state.activeRecorder) { state.activeRecorder.ctrl.cancel(); state.activeRecorder = null; }
}
async function stopAndSendRecording() {
  if (!state.activeRecorder) { closeNav('recorder'); return; }
  const { kind, ctrl } = state.activeRecorder;
  if (recorderTimerInterval) { clearInterval(recorderTimerInterval); recorderTimerInterval = null; }
  const blob = await ctrl.stop();
  state.activeRecorder = null;
  closeNav('recorder');
  const [botId, chatId] = state.currentChatKey.split(':');
  const token = getBotToken(botId);
  try {
    let result;
    if (kind === 'voice') {
      const file = Media.fileFromBlob(blob, 'voice');
      result = await TelegramAPI.sendMedia(token, 'sendVoice', chatId, 'voice', file);
    } else {
      const file = Media.fileFromBlob(blob, 'video_note');
      result = await TelegramAPI.sendMedia(token, 'sendVideoNote', chatId, 'video_note', file, { length: 360 });
    }
    await storeOutgoingMessage(botId, state.currentChatKey, result);
    await renderChatMessages(state.currentChatKey, { append: true });
  } catch (e) { alert('Помилка надсилання запису: ' + e.message); }
}

// ---------------------------------------------------------------------
// RIGHT PANEL — інформація про користувача
// ---------------------------------------------------------------------
function renderRightPanel(chat) {
  if (!chat) return;
  const raw = chat.raw || {};
  $('#right-content').innerHTML = `
    <div class="big-avatar" data-chat-avatar="${chat.id}">${(chat.title || '?').trim()[0]?.toUpperCase() || '?'}</div>
    <div class="info-name">${escapeHtml(chat.title || '')}</div>
    <div class="info-row"><label>User ID</label><div class="val">${chat.chatId}</div></div>
    ${raw.username ? `<div class="info-row"><label>Username</label><div class="val">@${escapeHtml(raw.username)}</div></div>` : ''}
    ${raw.first_name ? `<div class="info-row"><label>First name</label><div class="val">${escapeHtml(raw.first_name)}</div></div>` : ''}
    ${raw.last_name ? `<div class="info-row"><label>Last name</label><div class="val">${escapeHtml(raw.last_name)}</div></div>` : ''}
    <div class="info-row"><label>Перше повідомлення</label><div class="val">${fmtDateTime(chat.firstSeen)}</div></div>
    <div class="info-row"><label>Останнє повідомлення</label><div class="val">${fmtDateTime(chat.lastMessageTs)}</div></div>
    <div class="info-row"><label>Повний JSON (Bot API)</label><pre>${escapeHtml(JSON.stringify(raw, null, 2))}</pre></div>
  `;
  const avatarEl = $('#right-content [data-chat-avatar]');
  if (avatarEl) fillChatAvatar(avatarEl, chat);
}

// ---------------------------------------------------------------------
// НАЛАШТУВАННЯ: вкладки
// ---------------------------------------------------------------------
const TAB_TITLES = {
  accounts: 'Акаунти / Боти', 'bot-profile': 'Профіль бота', 'chat-wallpaper': 'Чати та фон',
  notifications: 'Сповіщення та звуки', security: 'Безпека та пароль', storage: "Пристрої та пам'ять", appearance: 'Вигляд / Теми'
};
function switchSettingsTab(tab) {
  $$('.settings-nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.settings-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== tab));
  $('#settings-tab-title').textContent = TAB_TITLES[tab] || '';
  if (tab === 'accounts') renderSettingsBotList();
  if (tab === 'bot-profile') loadBotProfileIntoSettings();
  if (tab === 'chat-wallpaper') renderWallpaperPresets();
  if (tab === 'storage') updateCacheSizeLabel();
}
async function openSettingsModal(tab = 'accounts') {
  pushNav('settings');
  show('#settings-modal');
  renderSettingsModal();
  switchSettingsTab(tab);
}
function renderSettingsModal() {
  $('#theme-select').value = state.settings.theme;
  $('#accent-dots').innerHTML = ACCENTS.map(c =>
    `<div class="accent-dot ${c === state.settings.accent ? 'active' : ''}" style="background:${c}" data-c="${c}"></div>`).join('');
  $$('.accent-dot').forEach(d => d.onclick = () => { state.settings.accent = d.dataset.c; applyTheme(); saveSettings(); renderSettingsModal(); });
  $('#toggle-encryption').checked = Crypto.isEncryptionEnabled();
  $('#polling-interval').value = state.settings.pollingInterval;
  applyScale();
}

async function updateCacheSizeLabel() {
  try {
    const all = await DB.getAll(DB.STORES.mediaCache);
    const bytes = all.reduce((sum, r) => sum + (r.blob?.size || 0), 0);
    $('#cache-size-label').textContent = `Кеш медіа: ${(bytes / 1024 / 1024).toFixed(1)} МБ (${all.length} файлів)`;
  } catch (e) { $('#cache-size-label').textContent = 'Кеш медіа'; }
}

// --- Профіль бота ---
async function loadBotProfileIntoSettings() {
  const bot = state.bots.find(b => b.id === state.currentBotId);
  if (!bot) return;
  $('#bot-profile-handle').textContent = bot.username ? '@' + bot.username : bot.name;
  const avatarEl = $('#bot-profile-avatar');
  avatarEl.innerHTML = (bot.name || '?')[0]?.toUpperCase() || '?';
  fillBotAvatar(avatarEl, bot);
  try {
    const [name, desc, commands] = await Promise.all([
      TelegramAPI.getMyName(bot.token), TelegramAPI.getMyDescription(bot.token), TelegramAPI.getMyCommands(bot.token)
    ]);
    $('#bot-name-input').value = name.name || '';
    $('#bot-desc-input').value = desc.description || '';
    $('#bot-commands-input').value = commands.map(c => `${c.command} — ${c.description}`).join('\n');
  } catch (e) { /* ignore */ }
}
async function saveBotProfile() {
  const bot = state.bots.find(b => b.id === state.currentBotId);
  if (!bot) return;
  const msgEl = $('#profile-save-msg'); msgEl.style.color = 'var(--online)'; msgEl.textContent = 'Збереження…';
  try {
    const name = $('#bot-name-input').value.trim();
    const desc = $('#bot-desc-input').value.trim();
    const shortDesc = $('#bot-short-desc-input').value.trim();
    if (name) await TelegramAPI.setMyName(bot.token, name);
    if (desc) await TelegramAPI.setMyDescription(bot.token, desc);
    if (shortDesc) await TelegramAPI.setMyShortDescription(bot.token, shortDesc);
    const commandsText = $('#bot-commands-input').value.trim();
    if (commandsText) {
      const commands = commandsText.split('\n').filter(Boolean).map(line => {
        const [command, ...rest] = line.split('—');
        return { command: command.trim().replace(/^\//, ''), description: rest.join('—').trim() || command.trim() };
      });
      await TelegramAPI.setMyCommands(bot.token, commands);
    }
    if (name) { bot.name = name; await DB.put(DB.STORES.bots, bot); updateLeftHeader(); }
    msgEl.textContent = 'Збережено ✓';
  } catch (e) { msgEl.style.color = 'var(--danger)'; msgEl.textContent = 'Помилка: ' + e.message; }
}

// --- Бекап ---
async function exportBackup() {
  const bots = await DB.getAll(DB.STORES.bots);
  const chats = await DB.getAll(DB.STORES.chats);
  const messages = await DB.getAll(DB.STORES.messages);
  const payload = { version: 1, exportedAt: Date.now(), bots, chats, messages };
  let outStr = JSON.stringify(payload);
  if (Crypto.isEncryptionEnabled()) {
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
// SERVICE WORKER
// ---------------------------------------------------------------------
function registerServiceWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW registration failed', e));
}

// ---------------------------------------------------------------------
// UTIL
// ---------------------------------------------------------------------
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
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
  $$('#add-bot-modal [data-close]').forEach(b => b.onclick = () => closeNav('add-bot'));
  $('#settings-add-bot-btn').onclick = openAddBotModal;

  $('#current-bot-avatar').onclick = () => openSettingsModal('accounts');
  $('#open-settings-btn').onclick = () => openSettingsModal('accounts');
  $$('#settings-modal [data-close]').forEach(b => b.onclick = () => closeNav('settings'));
  $$('.settings-nav-item').forEach(b => b.onclick = () => switchSettingsTab(b.dataset.tab));

  $('#msg-input').addEventListener('input', (e) => autoGrow(e.target));
  $('#msg-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrentMessage(); } });
  $('#send-btn').onclick = sendCurrentMessage;
  $('#cancel-reply').onclick = cancelReply;

  $('#attach-btn').onclick = (e) => { e.stopPropagation(); toggleAttachMenu(); };
  document.addEventListener('click', (e) => {
    if (!$('#attach-menu').classList.contains('hidden') && !e.target.closest('#attach-menu') && e.target.id !== 'attach-btn') closeNav('attach-menu');
  });
  $$('#attach-menu button').forEach(b => b.onclick = () => onAttachAction(b.dataset.action));
  $('#photo-video-input').onchange = (e) => { onPhotoVideoPicked(e.target.files); e.target.value = ''; };
  $('#document-input').onchange = (e) => { if (e.target.files[0]) sendFileDirect(e.target.files[0]); e.target.value = ''; };
  $('#gallery-send-btn').onclick = sendGalleryFiles;
  $$('#gallery-modal [data-close]').forEach(b => b.onclick = () => closeNav('gallery'));

  $('#recorder-stop').onclick = stopAndSendRecording;
  $('#recorder-cancel').onclick = () => closeNav('recorder');

  $('#back-btn').onclick = () => closeNav('chat');
  $('#chat-info-btn').onclick = () => { $('#right-panel').classList.remove('hidden'); pushNav('right-panel'); };
  $('#close-right-btn').onclick = () => closeNav('right-panel');
  $('#chat-search').addEventListener('input', (e) => renderChatList(e.target.value));

  $('#theme-select').onchange = (e) => { state.settings.theme = e.target.value; applyTheme(); saveSettings(); };
  $('#ui-scale-range').oninput = (e) => { state.settings.uiScale = +e.target.value / 100; applyScale(); };
  $('#ui-scale-range').onchange = saveSettings;
  $('#msg-scale-range').oninput = (e) => { state.settings.msgScale = +e.target.value / 100; applyScale(); };
  $('#msg-scale-range').onchange = saveSettings;

  $('#wallpaper-upload-btn').onclick = () => $('#wallpaper-file-input').click();
  $('#wallpaper-file-input').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const dataUrl = await compressImageToDataUrl(file);
    state.settings.wallpaper = { type: 'image', value: dataUrl };
    applyWallpaper(); await saveSettings(); renderWallpaperPresets();
    e.target.value = '';
  };
  $('#wallpaper-reset-btn').onclick = async () => { state.settings.wallpaper = { type: 'preset', value: 'default' }; applyWallpaper(); await saveSettings(); renderWallpaperPresets(); };

  $('#toggle-encryption').onchange = async (e) => {
    if (e.target.checked) { closeNav('settings'); showLockScreen(true); }
    else { Crypto.disableEncryption(); await DB.metaSet('encryptionEnabled', false); }
  };
  $('#connection-mode').onchange = (e) => {
    $('#polling-interval-row').classList.toggle('hidden', e.target.value !== 'polling');
    $('#webhook-row').classList.toggle('hidden', e.target.value !== 'webhook');
  };
  $('#polling-interval').onchange = (e) => { state.settings.pollingInterval = parseInt(e.target.value) || 1000; saveSettings(); const bot = state.bots.find(b => b.id === state.currentBotId); if (bot) resumePolling(bot); };
  $('#apply-webhook').onclick = async () => {
    const bot = state.bots.find(b => b.id === state.currentBotId); const url = $('#webhook-url').value.trim();
    if (!bot || !url) return;
    try {
      stopLongPolling(bot.id);
      await fetch(`https://api.telegram.org/bot${bot.token}/setWebhook?url=${encodeURIComponent(url)}`);
      alert('Webhook зареєстровано на боці Telegram. Приймати вхідні запити застосунок на GitHub Pages не може — для цього потрібен ваш сервер.');
    } catch (e) { alert('Помилка: ' + e.message); }
  };
  $('#remove-webhook').onclick = async () => {
    const bot = state.bots.find(b => b.id === state.currentBotId); if (!bot) return;
    await fetch(`https://api.telegram.org/bot${bot.token}/deleteWebhook`);
    resumePolling(bot);
    alert('Webhook видалено, повернулись на Long Polling.');
  };
  $('#toggle-sound').onchange = (e) => { state.settings.sound = e.target.checked; saveSettings(); };
  $('#toggle-push').onchange = async (e) => {
    state.settings.push = e.target.checked; saveSettings();
    if (e.target.checked && 'Notification' in window) await Notification.requestPermission();
  };
  $('#save-bot-profile').onclick = saveBotProfile;
  $('#export-backup').onclick = exportBackup;
  $('#import-backup').onclick = () => $('#import-file-input').click();
  $('#import-file-input').onchange = (e) => { if (e.target.files[0]) importBackupFile(e.target.files[0]); };
  $('#clear-media-cache').onclick = async () => { await DB.clearStore(DB.STORES.mediaCache); updateCacheSizeLabel(); };

  document.addEventListener('dblclick', (e) => {
    const row = e.target.closest?.('.msg-row');
    if (row) startReply(row.dataset.msgid);
  });
}

window.addEventListener('DOMContentLoaded', () => { wireEvents(); boot(); });
window.addEventListener('beforeunload', () => stopAllPolling());
