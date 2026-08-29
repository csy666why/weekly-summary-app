/* WEEKLY·OS PWA Service Worker
   应用壳(静态资源)缓存优先，保证离线可打开；API 始终走网络，数据实时 */
const CACHE = "weekly-os-shell-v2";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/blocks.js",
  "/mobile-save.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});
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
  // API 与 WebSocket：不缓存，直接走网络
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;
  // 静态资源：缓存优先，后台更新（stale-while-revalidate）
  const path = url.pathname;
  if (APP_SHELL.includes(path) || path.startsWith("/icons/") || path.startsWith("/vendor/") || path.startsWith("/tessdata/")) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req, { ignoreSearch: true });
        const network = fetch(req).then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }
  // 其余：网络优先，失败回退缓存
  event.respondWith(
    fetch(req).catch(() => caches.match(req, { ignoreSearch: true }))
  );
});