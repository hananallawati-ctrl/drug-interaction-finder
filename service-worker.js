const CACHE = "ddi-cache-v1";
const ASSETS = ["/","/index.html","/about.html","/manifest.json",
                "/icons/icon-192.png","/icons/icon-512.png","/icons/ochs.png"];

self.addEventListener("install", e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
});

self.addEventListener("activate", e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(
      keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))
    ))
  );
});

self.addEventListener("fetch", e=>{
  const url = new URL(e.request.url);
  if (ASSETS.includes(url.pathname)) {
    e.respondWith(caches.match(e.request).then(r=>r || fetch(e.request)));
  }
  // For API calls, default network (so you always get fresh results)
});
