/* 拾光記帳 · 離線快取（App Shell 策略） */
const CACHE_NAME = "healing-ledger-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first：先試著連網路拿最新版本（順便更新快取），只有真的
// 離線、連不上網路時才退回用快取裡的舊版本頂著。
//
// 這裡原本是「Cache-first + 背景更新」：每次都先顯示快取裡的舊版本，
// 這次連網拿到的新版本要等「下一次」重開才會被看到——對一個還在密集
// 更新的 App 來說，會讓人一直以為「明明我請 Claude 改過了，加到主
// 畫面的那份卻沒有更新」，其實只是這次打開看到的還是上一次的快取。
// 改成 Network-first 之後，只要有網路，打開就一定是最新版本；只有
// 真的離線才會退回快取，離線可用這件事完全不受影響。
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          // 把「更新快取」這件事包進 event.waitUntil()：respondWith()
          // 這邊拿到 network 回應就會馬上回給頁面，不用等快取寫完，
          // 但沒有 waitUntil() 包住的話，瀏覽器有可能在快取真的寫進
          // Cache Storage 之前就把這個 Service Worker 事件收掉，造成
          // 「這次明明有連上網路，快取卻沒真的更新到」——下次離線時
          // 退回快取，看到的還是更舊的版本。
          event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
          );
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
