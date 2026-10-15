// Offline use: the first visit online stores the page, the receiver bundle, the sample and
// Python itself (Pyodide, numpy and lzma from the CDN, about 13 MB), so from then on the app
// works on a walk with no signal.
// The page's own files: network first (an update arrives when online), cache when offline.
// Pyodide's files carry their version in the URL, so they are cache first.
const BUILD = "2026.10.15-8aa980b4";
const CACHE = "mfc-web-" + BUILD;
const CDN_CACHE = "mfc-web-cdn-0.28.3";
const SHELL = ["./", "index.html", "app.js", "worker.js", "py/mfc.zip", "default_cal.json",
  "manifest.webmanifest", "icon.svg", "samples/index.json"];
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
const PYODIDE_FILES = ["pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip",
  "pyodide-lock.json", "numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl",
  "lzma-1.0.0-cp313-cp313-pyodide_2025_0_wasm32.whl"];

async function install() {
  const c = await caches.open(CACHE);
  await c.addAll(SHELL);
  try {                                        // the sample sessions listed in the index
    const list = await (await c.match("samples/index.json")).json();
    await c.addAll(list.flatMap((s) => ["samples/" + s.file, "samples/" + s.file + ".json"]));
  } catch (_) { /* no sample: the page says so */ }
  const cdn = await caches.open(CDN_CACHE);
  for (const f of PYODIDE_FILES) {
    if (!(await cdn.match(PYODIDE + f))) await cdn.add(PYODIDE + f);
  }
}

self.addEventListener("install", (e) => {
  e.waitUntil(install().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("mfc-web-") && k !== CACHE && k !== CDN_CACHE)
      .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(caches.open(CDN_CACHE).then(async (c) => {
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
