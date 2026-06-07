const CACHE = "sideclip-v1.3";
const CORE = ["/", "/index.html", "/styles.css", "/theme.js", "/app.js", "/icon.svg", "/manifest.webmanifest", "/privacy.html"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const pathname = new URL(event.request.url).pathname;
  if (event.request.method !== "GET" || pathname.startsWith("/api/") || pathname.startsWith("/media/")) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});
