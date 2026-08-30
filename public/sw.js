// Offline shell cache.
//
// Deliberately NETWORK-FIRST, not cache-first. The previous version served the
// shell from cache whenever it was present, under a cache name that never
// changed - so a phone that had opened Notflix once kept serving that exact
// copy of the HTML/CSS/JS forever, and never picked up any later change to the
// app. The only way out was clearing the site's data by hand.
//
// The server here is on the same WiFi as the phone, so going to the network
// first costs a few milliseconds and guarantees you are always running the
// current version. The cache is kept purely as an offline fallback, for when
// the PC is off and there is nothing to talk to.

const CACHE_NAME = "notflix-shell-v2";
const SHELL_FILES = [
  "/", "/css/style.css", "/js/app.js", "/js/player.js", "/manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never intercept API calls, video streaming or thumbnails - always live.
  if (url.pathname.startsWith("/api/")) return;
  // Range requests are for media; letting the cache near them breaks seeking.
  if (req.headers.has("range")) return;
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Refresh the offline copy with whatever the server just served.
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        // Offline (PC is off): fall back to the last copy we saw. For a
        // navigation with nothing cached, fall back to the app shell so the
        // app still opens rather than showing the browser's error page.
        caches.match(req).then((cached) =>
          cached || (req.mode === "navigate" ? caches.match("/") : undefined)
        )
      )
  );
});
