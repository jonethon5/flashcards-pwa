// Service worker: guarda o app no aparelho para funcionar sem internet.
// Ao mudar qualquer arquivo do app, aumente a versão para os aparelhos baixarem de novo.
const VERSION = "v1";
const CACHE = `flashcards-${VERSION}`;

const FILES = [
  "./",
  "index.html",
  "styles.css",
  "manifest.webmanifest",
  "js/app.js",
  "js/db.js",
  "js/scheduler.js",
  "js/render.js",
  "js/importer.js",
  "js/backup.js",
  "js/libs.js",
  "vendor/fflate.js",
  "vendor/fzstd.js",
  "vendor/sql-wasm.js",
  "vendor/sql-wasm.wasm",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    }),
  );
});
