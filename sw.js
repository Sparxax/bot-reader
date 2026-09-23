const CACHE_VERSION = 'v1';
const SHELL_CACHE = `bot-manager-shell-${CACHE_VERSION}`;
const MEDIA_CACHE = `bot-manager-media-${CACHE_VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/api.js',
  './js/db.js',
  './js/crypto.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== MEDIA_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ніколи не кешуємо виклики Telegram Bot API — дані мають бути завжди свіжими.
  if (url.hostname === 'api.telegram.org') return;

  // App shell: cache-first, з фоновим оновленням
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request).then((res) => {
          if (res && res.ok) caches.open(SHELL_CACHE).then((c) => c.put(event.request, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Зовнішні медіафайли (файли Telegram, шрифти, CDN-скрипти для стікерів) — cache-first у окремому кеші
  event.respondWith(
    caches.open(MEDIA_CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      try {
        const res = await fetch(event.request);
        if (res && res.ok) cache.put(event.request, res.clone());
        return res;
      } catch (e) {
        return cached || Response.error();
      }
    })
  );
});

// Push-сповіщення (якщо користувач увімкнув їх у налаштуваннях застосунку)
self.addEventListener('push', (event) => {
  let data = { title: 'Bot Manager', body: 'Нове повідомлення' };
  try { data = event.data.json(); } catch (e) {}
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: './icons/icon-192.png' }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('./index.html'));
});
