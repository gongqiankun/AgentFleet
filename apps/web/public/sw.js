const CACHE_NAME = "agentfleet-shell-v4";
const SHELL = ["/", "/favicon.svg", "/manifest.webmanifest", "/manifest.en.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const shellAsset = SHELL.includes(url.pathname) || url.pathname.startsWith("/assets/");
  const sessionNavigation = request.mode === "navigate" && /^\/sessions\/[^/]+\/?$/.test(url.pathname);
  if (request.method !== "GET" || url.origin !== self.location.origin || (!shellAsset && !sessionNavigation)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached ?? (request.mode === "navigate" ? caches.match("/") : Response.error()))),
  );
});
