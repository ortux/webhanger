/**
 * WebHanger Service Worker v2
 * - Caches component responses for offline use
 * - Serves custom offline page when network unavailable
 * - Shows "Served by WebHanger" badge on offline page
 * - Zero external dependencies — works fully offline
 */

const CACHE_NAME = "webhanger_sw_v2";
const OFFLINE_CACHE = "webhanger_offline_v1";
const OFFLINE_URL = "/__wh_offline__";

self.addEventListener("install", (event) => {
    event.waitUntil(
        Promise.all([
            caches.open(OFFLINE_CACHE).then(cache =>
                cache.put(OFFLINE_URL, new Response(offlinePage(), {
                    headers: { "Content-Type": "text/html" }
                }))
            ),
            caches.open(CACHE_NAME).then(cache =>
                cache.addAll(["/", "/index.html", "/wh-manifest.json", "/browser.min.js"]).catch(() => {})
            )
        ])
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME && k !== OFFLINE_CACHE)
                    .map(k => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    if (url.pathname.includes("/components/")) {
        event.respondWith(
            caches.open(CACHE_NAME).then(async cache => {
                const cached = await cache.match(event.request);
                if (cached) return cached;
                try {
                    const response = await fetch(event.request);
                    if (response.ok) cache.put(event.request, response.clone());
                    return response;
                } catch (_) {
                    return new Response("/* [WebHanger] Component unavailable offline */", {
                        headers: { "Content-Type": "application/javascript" }
                    });
                }
            })
        );
        return;
    }

    if (event.request.mode === "navigate") {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    return response;
                })
                .catch(async () => {
                    const cached = await caches.match(event.request);
                    if (cached) return cached;
                    const offlineCache = await caches.open(OFFLINE_CACHE);
                    return offlineCache.match(OFFLINE_URL);
                })
        );
        return;
    }

    if (url.pathname.endsWith("wh-manifest.json")) {
        event.respondWith(
            caches.open(CACHE_NAME).then(async cache => {
                try {
                    const response = await fetch(event.request);
                    if (response.ok) cache.put(event.request, response.clone());
                    return response;
                } catch (_) {
                    const cached = await cache.match(event.request);
                    return cached || new Response("{}", { headers: { "Content-Type": "application/json" } });
                }
            })
        );
    }
});

self.addEventListener("message", async (event) => {
    if (event.data?.type === "SET_OFFLINE_PAGE") {
        const cache = await caches.open(OFFLINE_CACHE);
        await cache.put(OFFLINE_URL, new Response(
            offlinePage(event.data.html, event.data.css),
            { headers: { "Content-Type": "text/html" } }
        ));
    }
});

// Pure inline HTML — zero external deps, works fully offline
function offlinePage(customHtml = "", customCss = "") {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Offline</title>
<style>
body{margin:0;background:#030712;color:#e8eaf0;font-family:system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px}
h1{font-size:2rem;font-weight:700;margin:16px 0 8px}
p{color:#6b7280;max-width:360px;line-height:1.7;margin:0 auto}
button{margin-top:28px;background:#4f46e5;color:#fff;border:none;padding:12px 28px;border-radius:10px;font-size:14px;cursor:pointer}
button:hover{background:#4338ca}
.badge{position:fixed;bottom:16px;right:16px;background:rgba(79,70,229,.15);border:1px solid rgba(79,70,229,.3);color:#818cf8;font-size:11px;font-family:monospace;padding:6px 12px;border-radius:999px}
${customCss}
</style>
</head>
<body>
${customHtml || `<div style="font-size:56px">📡</div><h1>You're offline</h1><p>Check your connection and try again. Cached content loads automatically when you reconnect.</p><button onclick="location.reload()">Try again</button>`}
<div class="badge">⬡ Served by WebHanger</div>
</body>
</html>`;
}
