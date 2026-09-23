// api.js — пряма робота з Telegram Bot API. Жодні запити нікуди, крім api.telegram.org, не йдуть.

function base(token) {
  return `https://api.telegram.org/bot${token}`;
}
function fileBase(token) {
  return `https://api.telegram.org/file/bot${token}`;
}

async function call(token, method, params = {}, { isForm = false } = {}) {
  const url = `${base(token)}/${method}`;
  let opts;
  if (isForm) {
    opts = { method: 'POST', body: params }; // params — FormData
  } else {
    opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    };
  }
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(data.description || `Telegram API error (${method})`);
    err.code = data.error_code;
    err.payload = data;
    throw err;
  }
  return data.result;
}

export const TelegramAPI = {
  getMe: (token) => call(token, 'getMe'),
  getUpdates: (token, { offset, timeout = 25, allowed_updates } = {}) =>
    call(token, 'getUpdates', { offset, timeout, allowed_updates }),

  sendMessage: (token, chat_id, text, opts = {}) =>
    call(token, 'sendMessage', { chat_id, text, ...opts }),
  editMessageText: (token, chat_id, message_id, text, opts = {}) =>
    call(token, 'editMessageText', { chat_id, message_id, text, ...opts }),
  deleteMessage: (token, chat_id, message_id) =>
    call(token, 'deleteMessage', { chat_id, message_id }),
  forwardMessage: (token, chat_id, from_chat_id, message_id) =>
    call(token, 'forwardMessage', { chat_id, from_chat_id, message_id }),
  setMessageReaction: (token, chat_id, message_id, reaction) =>
    call(token, 'setMessageReaction', { chat_id, message_id, reaction }),
  sendChatAction: (token, chat_id, action) =>
    call(token, 'sendChatAction', { chat_id, action }),

  sendPoll: (token, chat_id, question, options, opts = {}) =>
    call(token, 'sendPoll', { chat_id, question, options: JSON.stringify(options), ...opts }),
  sendLocation: (token, chat_id, latitude, longitude, opts = {}) =>
    call(token, 'sendLocation', { chat_id, latitude, longitude, ...opts }),
  sendContact: (token, chat_id, phone_number, first_name, opts = {}) =>
    call(token, 'sendContact', { chat_id, phone_number, first_name, ...opts }),

  // Надсилання медіа — приймає File/Blob і робить multipart/form-data
  sendMedia: (token, method, chat_id, fieldName, file, opts = {}) => {
    const fd = new FormData();
    fd.append('chat_id', chat_id);
    fd.append(fieldName, file, file.name || 'file');
    for (const k in opts) {
      if (opts[k] !== undefined && opts[k] !== null) {
        fd.append(k, typeof opts[k] === 'object' ? JSON.stringify(opts[k]) : String(opts[k]));
      }
    }
    return call(token, method, fd, { isForm: true });
  },

  getFile: (token, file_id) => call(token, 'getFile', { file_id }),
  fileUrl: (token, filePath) => `${fileBase(token)}/${filePath}`,

  // Профіль бота (лише методи, дійсно наявні в Bot API — аватар бота встановлюється тільки вручну через @BotFather)
  setMyName: (token, name) => call(token, 'setMyName', { name }),
  getMyName: (token) => call(token, 'getMyName'),
  setMyDescription: (token, description) => call(token, 'setMyDescription', { description }),
  getMyDescription: (token) => call(token, 'getMyDescription'),
  setMyShortDescription: (token, short_description) => call(token, 'setMyShortDescription', { short_description }),
  setMyCommands: (token, commands) => call(token, 'setMyCommands', { commands: JSON.stringify(commands) }),
  getMyCommands: (token) => call(token, 'getMyCommands'),
  deleteMyCommands: (token) => call(token, 'deleteMyCommands'),

  getChat: (token, chat_id) => call(token, 'getChat', { chat_id }),
  getUserProfilePhotos: (token, user_id, opts = {}) => call(token, 'getUserProfilePhotos', { user_id, ...opts }),

  answerCallbackQuery: (token, callback_query_id, opts = {}) =>
    call(token, 'answerCallbackQuery', { callback_query_id, ...opts }),
};

// --- Long Polling manager -------------------------------------------------
// Один активний "поллер" на бота, з persist offset у IndexedDB (щоб не втрачати updates).
const activePollers = new Map(); // botId -> { stop }

export function startLongPolling(bot, { onUpdate, onError, getOffset, setOffset, intervalMs = 1000 }) {
  stopLongPolling(bot.id);
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        const offset = await getOffset();
        const updates = await TelegramAPI.getUpdates(bot.token, { offset, timeout: 25 });
        if (updates.length) {
          for (const u of updates) {
            await onUpdate(u);
          }
          await setOffset(updates[updates.length - 1].update_id + 1);
        }
      } catch (e) {
        onError && onError(e);
        await new Promise(r => setTimeout(r, Math.max(intervalMs, 3000)));
      }
      if (!stopped && intervalMs > 0) await new Promise(r => setTimeout(r, intervalMs));
    }
  };
  loop();
  activePollers.set(bot.id, { stop: () => { stopped = true; } });
}

export function stopLongPolling(botId) {
  const p = activePollers.get(botId);
  if (p) { p.stop(); activePollers.delete(botId); }
}

export function stopAllPolling() {
  for (const id of Array.from(activePollers.keys())) stopLongPolling(id);
}
