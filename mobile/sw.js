// 自毁版 Service Worker（kill-switch）。
// APK 内资源本就是本地文件，不需要 SW 缓存；旧 SW 会喂缓存的旧版页面导致更新不生效。
// 本 SW 一旦激活：注销自己 + 清空所有缓存 + 强制刷新页面，确保始终加载最新本地资源。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach((c) => c.navigate(c.url));
    } catch (e) {}
  })());
});
// 不拦截任何请求，直接走本地/网络
