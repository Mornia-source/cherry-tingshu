// 樱桃听书 手机版 · 简单离线缓存（应用外壳）
const CACHE = "cherry-tingshu-m-v1";
const ASSETS = [
  "./index.html", "./css/style.css", "./js/app.js",
  "./logo.svg", "./favicon.svg", "./manifest.webmanifest",
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // 只缓存同源的应用外壳，CDN 等走网络
  if (url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
