// Offline use: after one visit online the page, the receiver bundle and Python (Pyodide from
// the CDN) are served from this cache, so the app works on a walk with no signal.
// The page's own files: network first (an update arrives when online), cache when offline.
// Pyodide's files carry their version in the URL, so they are cache first.
const BUILD = "2026.10.15-b20e56a4";
const CACHE = "mfc-web-" + BUILD;
const SHELL = ["./", "index.html", "app.js", "worker.js", "py/mfc.zip", "default_cal.json",
  "manifest.webmanifest", "icon.svg", "samples/index.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("mfc-web-") && k !== CACHE && k !== "mfc-web-cdn")
      .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(caches.open("mfc-web-cdn").then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const r = await fetch(e.request, { cache: "no-cache" });
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch (err) {
      const hit = await c.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
