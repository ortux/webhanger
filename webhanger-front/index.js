/**
 * WebHanger Frontend SDK — ESM (for bundlers: Next.js, Vite, Webpack, Rollup)
 * Full feature parity with browser.js IIFE build.
 * Tree-shakeable named exports.
 */

const VERSION = "2.0.0";
const IDB_NAME = "webhanger_v2";
const IDB_STORE = "components";
const LS_PREFIX = "wh2_";
const SIZE_THRESHOLD = 50 * 1024;

// ─── Plugin system ────────────────────────────────────────────────────────────

const _plugins = [];
const _listeners = {};

export function use(plugin) {
    if (typeof plugin.install === "function") plugin.install({ on, emit });
    _plugins.push(plugin);
}

export function on(event, fn) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(fn);
}

export function emit(event, data) {
    (_listeners[event] || []).forEach(fn => fn(data));
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export const metrics = { loads: 0, cacheHits: 0, errors: 0, totalTime: 0 };

function recordMetric(name, value) {
    if (name in metrics) metrics[name] += value;
    emit("metric", { name, value, metrics: { ...metrics } });
}

// ─── AES-256-GCM decrypt ──────────────────────────────────────────────────────

const _keyCache = new Map();

async function deriveKey(projectId, salt) {
    const k = projectId + salt;
    if (_keyCache.has(k)) return _keyCache.get(k);
    const enc = new TextEncoder();
    const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(k));
    const key = await crypto.subtle.importKey("raw", hashBuf, { name: "AES-GCM" }, false, ["decrypt"]);
    _keyCache.set(k, key);
    return key;
}

async function decryptChunk(encoded, projectId, salt) {
    if (!encoded) return "";
    try {
        const parts = encoded.split(":");
        if (parts.length !== 3) return "";
        const [ivB64, tagB64, dataB64] = parts;
        const iv   = Uint8Array.from(atob(ivB64),   c => c.charCodeAt(0));
        const tag  = Uint8Array.from(atob(tagB64),  c => c.charCodeAt(0));
        const data = Uint8Array.from(atob(dataB64), c => c.charCodeAt(0));
        const combined = new Uint8Array(data.length + tag.length);
        combined.set(data); combined.set(tag, data.length);
        const key = await deriveKey(projectId, salt);
        const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
        return new TextDecoder().decode(dec);
    } catch (err) {
        console.warn("[WebHanger] decryptChunk failed:", salt, err.message);
        return "";
    }
}

// ─── IndexedDB ────────────────────────────────────────────────────────────────

function openIDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbGet(key) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbSet(key, value) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const req = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

// ─── Cache (stale-while-revalidate) ──────────────────────────────────────────

async function cacheGet(key) {
    try { const v = localStorage.getItem(LS_PREFIX + key); if (v) return v; } catch (_) {}
    return await idbGet(key);
}

async function cacheSet(key, value) {
    try { if (value.length < SIZE_THRESHOLD) { localStorage.setItem(LS_PREFIX + key, value); return; } } catch (_) {}
    await idbSet(key, value);
}

async function cacheGetSWR(key, fetchFn) {
    const cached = await cacheGet(key);
    if (cached) {
        recordMetric("cacheHits", 1);
        fetchFn().then(fresh => { if (fresh && fresh !== cached) cacheSet(key, fresh); }).catch(() => {});
        return { data: cached, source: "cache" };
    }
    const fresh = await fetchFn();
    if (fresh) await cacheSet(key, fresh);
    return { data: fresh, source: "cdn" };
}

// ─── Fetch with multi-CDN failover ────────────────────────────────────────────

async function fetchComponent(cdnUrls, token, expires) {
    const urls = Array.isArray(cdnUrls) ? cdnUrls : [cdnUrls];
    let lastErr;
    for (const url of urls) {
        try {
            const u = expires ? `${url}?token=${token}&expires=${expires}` : `${url}?token=${token}`;
            const res = await fetch(u);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (err) {
            console.warn(`[WebHanger] CDN failed (${url}): ${err.message}`);
            lastErr = err;
        }
    }
    throw new Error("All CDN endpoints failed: " + lastErr?.message);
}

// ─── CDN asset loader ─────────────────────────────────────────────────────────

function loadAsset(asset) {
    return new Promise(resolve => {
        const existing = asset.type === "style"
            ? document.querySelector(`link[href="${asset.url}"]`)
            : document.querySelector(`script[src="${asset.url}"]`);
        if (existing) return resolve();
        if (asset.type === "style") {
            const el = document.createElement("link");
            el.rel = "stylesheet"; el.href = asset.url;
            el.onload = resolve; el.onerror = resolve;
            document.head.appendChild(el);
        } else {
            const el = document.createElement("script");
            el.src = asset.url;
            if (asset.defer) el.defer = true;
            if (asset.async) el.async = true;
            el.onload = resolve; el.onerror = resolve;
            document.head.appendChild(el);
        }
    });
}

async function loadAssets(assets = []) {
    for (const a of assets) await loadAsset(a);
}

// ─── Inject component ─────────────────────────────────────────────────────────

async function injectComponent(payload, projectId, selector, options = {}) {
    const { sandbox = false, allowedDomains, beforeMount, afterMount } = options;
    const target = document.querySelector(selector || "[data-wh]");
    if (!target) { console.warn("[WebHanger] No mount target found."); return; }

    let parsed;
    try { parsed = JSON.parse(payload); } catch (_) { console.error("[WebHanger] Invalid payload."); return; }

    if (allowedDomains?.length) {
        const host = window.location?.hostname || "";
        const ok = allowedDomains.some(d => host === d || host.endsWith("." + d));
        if (!ok) { emit("error", { reason: "domain_restricted" }); return; }
    }

    const css  = await decryptChunk(parsed.c, projectId, "::css");
    const html = await decryptChunk(parsed.h, projectId, "::html");
    const js   = await decryptChunk(parsed.j, projectId, "::js");

    if (parsed.integrity && (html || js)) {
        const enc = new TextEncoder();
        const buf = await crypto.subtle.digest("SHA-256", enc.encode(html + css + js));
        const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
        if (hash !== parsed.integrity) {
            console.error("[WebHanger] Integrity check failed.");
            emit("error", { reason: "integrity_failed" });
            return;
        }
    }

    if (typeof beforeMount === "function") beforeMount({ target, html, css });
    emit("beforeMount", { target, selector });

    if (sandbox) {
        const shadow = target.attachShadow({ mode: "closed" });
        if (css) { const s = document.createElement("style"); s.textContent = css; shadow.appendChild(s); }
        if (html) { const d = document.createElement("div"); d.innerHTML = html; shadow.appendChild(d); }
    } else {
        if (css) { const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); }
        if (html) target.innerHTML = html;
    }

    if (js) {
        const s = document.createElement("script");
        s.textContent = js;
        document.head.appendChild(s);
        document.head.removeChild(s);
    }

    if (typeof afterMount === "function") afterMount({ target });
    emit("afterMount", { target, selector });
}

// ─── Main load ────────────────────────────────────────────────────────────────

export async function load(cdnUrl, projectId, token, expires, selector = "[data-wh]", onSignal = null, deps = [], options = {}) {
    if (!cdnUrl || !projectId || !token || expires === undefined || expires === null) {
        console.error("[WebHanger] Missing required params"); return;
    }
    if (expires !== 0 && Math.floor(Date.now() / 1000) > expires) {
        console.warn("[WebHanger] Token expired."); return;
    }

    const signal = (stage, detail = {}) => {
        if (typeof onSignal === "function") onSignal({ stage, ...detail });
        emit(stage, detail);
    };

    const preloader = (() => {
        const t = document.querySelector(selector || "[data-wh]");
        if (!t) return { show: () => {}, hide: () => {} };
        const el = document.createElement("div");
        el.setAttribute("data-wh-loader", "");
        el.style.cssText = "display:flex;align-items:center;justify-content:center;padding:24px;width:100%;box-sizing:border-box;";
        el.innerHTML = '<div style="width:28px;height:28px;border:3px solid #e5e7eb;border-top-color:#6366f1;border-radius:50%;animation:wh-spin 0.7s linear infinite;"></div><style>@keyframes wh-spin{to{transform:rotate(360deg);}}</style>';
        return { show() { t.appendChild(el); }, hide() { el.parentNode?.removeChild(el); } };
    })();

    const start = performance.now();
    signal("start", { cdnUrl, selector });
    preloader.show();
    recordMetric("loads", 1);

    const cacheKey = `${cdnUrl}@${expires}`;
    try {
        signal("fetching");
        const { data: payload, source } = await cacheGetSWR(cacheKey, () => fetchComponent(cdnUrl, token, expires));

        let parsed;
        try { parsed = JSON.parse(payload); } catch (_) { parsed = {}; }

        if (parsed.assets?.length) { signal("assets", { count: parsed.assets.length }); await loadAssets(parsed.assets); }

        const allDeps = [...deps, ...(parsed.dependencies || [])];
        if (allDeps.length) signal("deps", { count: allDeps.length });

        signal("injecting");
        preloader.hide();
        await injectComponent(payload, projectId, selector, options);

        const elapsed = Math.round(performance.now() - start);
        recordMetric("totalTime", elapsed);
        signal("done", { time: elapsed, source });
        emit("load", { cdnUrl, time: elapsed, source, selector });
    } catch (err) {
        preloader.hide();
        recordMetric("errors", 1);
        signal("error", { message: err.message });
        if (typeof options.onError === "function") options.onError(err);
        console.error("[WebHanger] Load failed:", err.message);
    }
}

// ─── Initialize (manifest-based) ─────────────────────────────────────────────

let _manifest = null;
let _manifestUrl = "./wh-manifest.json";

export async function initialize(manifestUrl = "./wh-manifest.json") {
    _manifestUrl = manifestUrl;
    const res = await fetch(manifestUrl);
    _manifest = await res.json();
    document.querySelectorAll("wh-component[name]").forEach(el => el._load?.());
}

// ─── Service Worker ───────────────────────────────────────────────────────────

export async function registerSW(swUrl = "/webhanger.sw.js") {
    if (!("serviceWorker" in navigator)) return;
    try {
        const reg = await navigator.serviceWorker.register(swUrl);
        emit("sw", { registered: true, scope: reg.scope });
    } catch (err) {
        console.warn("[WebHanger] SW registration failed:", err.message);
    }
}

export async function setOfflinePage(html = "", css = "") {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    reg.active?.postMessage({ type: "SET_OFFLINE_PAGE", html, css });
}

// ─── Hard flush ───────────────────────────────────────────────────────────────

export async function clearCache() {
    Object.keys(localStorage).filter(k => k.startsWith(LS_PREFIX)).forEach(k => localStorage.removeItem(k));
    try { (await openIDB()).transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).clear(); } catch (_) {}
    if ("caches" in window) { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); }
    if ("serviceWorker" in navigator) { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r => r.unregister())); }
    Object.keys(sessionStorage).filter(k => k.startsWith(LS_PREFIX)).forEach(k => sessionStorage.removeItem(k));
}

// ─── WebGPU ───────────────────────────────────────────────────────────────────

export const gpu = { supported: false, adapter: null, device: null };

(async () => {
    if (!("gpu" in navigator)) return;
    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return;
        const device = await adapter.requestDevice();
        gpu.supported = true; gpu.adapter = adapter; gpu.device = device;
        emit("gpu", { supported: true, adapter });
    } catch (_) {}
})();

export { VERSION as version };
