/**
 * WebHanger Service Worker
 * Caches component responses for offline use.
 * Register this in your app: navigator.serviceWorker.register('/webhanger.sw.js')
 */

const CACHE_NAME = "webhanger_sw_v1";

// Cache component fetch requests
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // Only intercept requests to component paths
    if (!url.pathname.includes("/components/")) return;

    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const cached = await cache.match(event.request);
            if (cached) return cached;

            try {
                const response = await fetch(event.request);
                if (response.ok) {
                    cache.put(event.request, response.clone());
                }
                return response;
            } catch (_) {
                // Offline and not cached
                return new Response("/* [WebHanger] Component unavailable offline */", {
                    headers: { "Content-Type": "application/javascript" }
                });
            }
        })
    );
});

// Clean old caches on SW update
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
});
