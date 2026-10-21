const CACHE = "image-pdf-tool-v1";

const LOCAL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

const CDN_FILES = [
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
];

// Install: save all files in the cache.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await cache.addAll(LOCAL_FILES);
      // Save each CDN file alone, so one failure does not stop the install.
      await Promise.all(
        CDN_FILES.map((url) =>
          cache.add(url).catch((err) => console.warn("Not cached:", url, err))
        )
      );
    })
  );
  self.skipWaiting();
});

// Activate: remove old caches.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// Fetch: use the cache first, then the network.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isLocal = url.origin === self.location.origin;
  const isCdn = url.hostname === "cdnjs.cloudflare.com";
  if (!isLocal && !isCdn) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          // If a page is asked for and we are offline, show the main page.
          if (request.mode === "navigate") return caches.match("./index.html");
          return new Response("Offline", { status: 503 });
        });
    })
  );
});