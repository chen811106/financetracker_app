/* =========================================================
 * sw.js — Service Worker（讓 App 可以離線使用）
 *
 * 策略：Network-first（有網路就拿最新版並更新快取；
 *       沒網路或網路太慢就用快取）
 *
 * ⚠️ 新增檔案（例如新場景 data/airport.json）時：
 *    1. 把檔名加進下面的 APP_FILES
 *    2. 把 CACHE_VERSION 的數字加 1
 * ========================================================= */

const CACHE_VERSION = 'travel-english-v1';

const APP_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/storage.js',
  './js/speech.js',
  './js/score.js',
  './data/scenes.json',
  './data/ordering.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

// 安裝：先把所有檔案存進快取
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(APP_FILES)));
  self.skipWaiting();
});

// 啟用：刪掉舊版本的快取
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('travel-english-') && k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 讀取：先試網路（最多等 3 秒），失敗就用快取
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      try {
        const res = await Promise.race([
          fetch(req),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]);
        if (res && res.ok) event.waitUntil(cache.put(req, res.clone()));
        return res;
      } catch {
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        // 開啟頁面時沒網路又沒快取 → 回首頁
        if (req.mode === 'navigate') return cache.match('./index.html');
        return Response.error();
      }
    })()
  );
});
