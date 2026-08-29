/* WEEKLY·OS PWA Service Worker
   设计原则：网络优先，绝不缓存旧版本，保证每次更新即时生效 */
const CACHE = "weekly-os-v1";
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 网络优先：在线时永远拿最新；离线时回退到缓存
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});