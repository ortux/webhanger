/**
 * WebHanger Browser SDK v2.0
 * Features:
 * - AES-256-GCM decryption (Web Crypto API)
 * - Domain restriction
 * - Integrity check (SHA-256)
 * - Observability (metrics + events)
 * - Plugin system
 * - Smart caching (stale-while-revalidate + predictive)
 * - Sandboxed execution (Shadow DOM)
 * - Component lifecycle hooks
 */
(function (global) {
    const VERSION = "2.0.0";
    const IDB_NAME = "webhanger_v2";
    const IDB_STORE = "components";
    const LS_PREFIX = "wh2_";
    const SIZE_THRESHOLD = 50 * 1024;

    // ─── Plugin system ────────────────────────────────────────────────────────

    const plugins = [];
    function use(plugin) {
        if (typeof plugin.install === "function") plugin.install({ on, emit });
        plugins.push(plugin);
    }

    // ─── Event emitter (Observability) ────────────────────────────────────────

    const listeners = {};
    function on(event, fn) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
    }
    function emit(event, data) {
        (listeners[event] || []).forEach(fn => fn(data));
    }

    // ─── Metrics ──────────────────────────────────────────────────────────────

    const metrics = { loads: 0, cacheHits: 0, errors: 0, totalTime: 0 };

    function recordMetric(name, value) {
        if (name in metrics) metrics[name] += value;
        emit("metric", { name, value, metrics: { ...metrics } });
    }

    // ─── AES-256-GCM decrypt (Web Crypto) ────────────────────────────────────
    // Key = SHA-256(projectId + salt) — matches Node helper/crypto.js exactly

    const keyCache = new Map();

    async function deriveKey(projectId, salt) {
        const cacheKey = projectId + salt;
        if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);
        const enc = new TextEncoder();
        const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(projectId + salt));
        const key = await crypto.subtle.importKey(
            "raw", hashBuf, { name: "AES-GCM" }, false, ["decrypt"]
        );
        keyCache.set(cacheKey, key);
        return key;
    }

    async function decryptChunk(encoded, projectId, salt) {
        if (!encoded) return "";
        try {
            const parts = encoded.split(":");
            if (parts.length !== 3) {
                console.warn("[WebHanger] decryptChunk: unexpected format, parts:", parts.length);
                return "";
            }
            const [ivB64, tagB64, dataB64] = parts;
            const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
            const tag = Uint8Array.from(atob(tagB64), c => c.charCodeAt(0));
            const data = Uint8Array.from(atob(dataB64), c => c.charCodeAt(0));
            const combined = new Uint8Array(data.length + tag.length);
            combined.set(data); combined.set(tag, data.length);
            const key = await deriveKey(projectId, salt);
            const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
            return new TextDecoder().decode(decrypted);
        } catch (err) {
            console.warn("[WebHanger] decryptChunk failed:", salt, err.message);
            return "";
        }
    }

    // ─── Integrity check ──────────────────────────────────────────────────────

    async function verifyIntegrity(html, css, js, expectedHash) {
        if (!expectedHash) return true; // skip if no hash (v1 payloads)
        const enc = new TextEncoder();
        const data = enc.encode(html + css + js);
        const hashBuf = await crypto.subtle.digest("SHA-256", data);
        const hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
        return hash === expectedHash;
    }

    // ─── Domain restriction ───────────────────────────────────────────────────

    function checkDomain(allowedDomains) {
        if (!allowedDomains || !allowedDomains.length) return true;
        const host = global.location?.hostname || "";
        return allowedDomains.some(d => host === d || host.endsWith("." + d));
    }

    // ─── IndexedDB ────────────────────────────────────────────────────────────

    function openIDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, 1);
            req.onupgradeneeded = (e) => e.target.result.createObjectStore(IDB_STORE);
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function idbGet(key) {
        const db = await openIDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, "readonly");
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function idbSet(key, value) {
        const db = await openIDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            const req = tx.objectStore(IDB_STORE).put(value, key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    // ─── Smart cache (stale-while-revalidate) ─────────────────────────────────

    async function cacheGet(key) {
        try {
            const ls = localStorage.getItem(LS_PREFIX + key);
            if (ls) return ls;
        } catch (_) {}
        return await idbGet(key);
    }

    async function cacheSet(key, value) {
        try {
            if (value.length < SIZE_THRESHOLD) {
                localStorage.setItem(LS_PREFIX + key, value);
                return;
            }
        } catch (_) {}
        await idbSet(key, value);
    }

    // Stale-while-revalidate: return cached immediately, refresh in background
    async function cacheGetSWR(key, fetchFn) {
        const cached = await cacheGet(key);
        if (cached) {
            recordMetric("cacheHits", 1);
            // Revalidate in background
            fetchFn().then(fresh => { if (fresh && fresh !== cached) cacheSet(key, fresh); }).catch(() => {});
            return { data: cached, source: "cache" };
        }
        const fresh = await fetchFn();
        if (fresh) await cacheSet(key, fresh);
        return { data: fresh, source: "cdn" };
    }

    // ─── Fetch with Multi-CDN failover ───────────────────────────────────────

    async function fetchComponent(cdnUrls, token, expires) {
        const urls = Array.isArray(cdnUrls) ? cdnUrls : [cdnUrls];
        let lastErr;
        for (const cdnUrl of urls) {
            try {
                const url = expires
                    ? `${cdnUrl}?token=${token}&expires=${expires}`
                    : `${cdnUrl}?token=${token}`;
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return await res.text();
            } catch (err) {
                console.warn(`[WebHanger] CDN failed (${cdnUrl}): ${err.message} — trying next...`);
                lastErr = err;
            }
        }
        throw new Error(`All CDN endpoints failed. Last error: ${lastErr?.message}`);
    }

    // ─── CDN asset loader ─────────────────────────────────────────────────────

    function loadAsset(asset) {
        return new Promise((resolve) => {
            const existing = asset.type === "style"
                ? document.querySelector(`link[href="${asset.url}"]`)
                : document.querySelector(`script[src="${asset.url}"]`);
            if (existing) return resolve();
            if (asset.type === "style") {
                const link = document.createElement("link");
                link.rel = "stylesheet"; link.href = asset.url;
                link.onload = resolve; link.onerror = resolve;
                document.head.appendChild(link);
            } else {
                const script = document.createElement("script");
                script.src = asset.url;
                if (asset.defer) script.defer = true;
                if (asset.async) script.async = true;
                script.onload = resolve; script.onerror = resolve;
                document.head.appendChild(script);
            }
        });
    }

    async function loadAssets(assets = []) {
        for (const asset of assets) await loadAsset(asset);
    }

    // ─── Sandboxed injection (Shadow DOM) ─────────────────────────────────────

    function injectSandboxed(target, html, css) {
        const shadow = target.attachShadow({ mode: "closed" });
        if (css) {
            const style = document.createElement("style");
            style.textContent = css;
            shadow.appendChild(style);
        }
        if (html) {
            const div = document.createElement("div");
            div.innerHTML = html;
            shadow.appendChild(div);
        }
        return shadow;
    }

    // ─── Inject component ─────────────────────────────────────────────────────

    async function injectComponent(payload, projectId, targetSelector, options = {}) {
        const { sandbox = false, allowedDomains, beforeMount, afterMount } = options;

        const target = document.querySelector(targetSelector || "[data-wh]");
        if (!target) { console.warn("[WebHanger] No mount target found."); return; }

        let parsed;
        try { parsed = JSON.parse(payload); }
        catch (_) { console.error("[WebHanger] Invalid payload."); return; }

        // Domain restriction
        if (!checkDomain(allowedDomains)) {
            console.error(`[WebHanger] Domain not allowed: ${global.location?.hostname}`);
            emit("error", { reason: "domain_restricted" });
            return;
        }

        // Decrypt all chunks
        const css  = await decryptChunk(parsed.c, projectId, "::css");
        const html = await decryptChunk(parsed.h, projectId, "::html");
        const js   = await decryptChunk(parsed.j, projectId, "::js");

        // Integrity check — only run if at least html or js decrypted successfully
        if (parsed.integrity && (html || js)) {
            const valid = await verifyIntegrity(html, css, js, parsed.integrity);
            if (!valid) {
                console.error("[WebHanger] Integrity check failed — bundle may be tampered or re-deploy needed.");
                emit("error", { reason: "integrity_failed" });
                return;
            }
        }

        // Lifecycle: beforeMount
        if (typeof beforeMount === "function") beforeMount({ target, html, css });
        emit("beforeMount", { target, selector: targetSelector });

        // Inject
        if (sandbox) {
            injectSandboxed(target, html, css);
        } else {
            if (css) {
                const style = document.createElement("style");
                style.textContent = css;
                document.head.appendChild(style);
            }
            if (html) target.innerHTML = html;
        }

        // Execute JS
        if (js) {
            const script = document.createElement("script");
            script.textContent = js;
            document.head.appendChild(script);
            document.head.removeChild(script);
        }

        // Lifecycle: afterMount
        if (typeof afterMount === "function") afterMount({ target });
        emit("afterMount", { target, selector: targetSelector });
    }

    // ─── Dep loader ───────────────────────────────────────────────────────────

    async function loadDependency(dep, projectId) {
        const cacheKey = `${dep.cdnUrl}@${dep.expires}`;
        const { data: payload } = await cacheGetSWR(cacheKey, () => fetchComponent(dep.cdnUrl, dep.token, dep.expires));
        if (!payload) return;

        let parsed;
        try { parsed = JSON.parse(payload); } catch (_) { return; }
        if (parsed.assets && parsed.assets.length) await loadAssets(parsed.assets);

        const css = await decryptChunk(parsed.c, projectId, "::css");
        if (css) {
            const existing = document.querySelector(`style[data-wh-dep="${dep.name}@${dep.version}"]`);
            if (!existing) {
                const style = document.createElement("style");
                style.setAttribute("data-wh-dep", `${dep.name}@${dep.version}`);
                style.textContent = css;
                document.head.appendChild(style);
            }
        }
        const html = await decryptChunk(parsed.h, projectId, "::html");
        if (html) {
            const mount = document.querySelector(`[data-wh-${dep.name}]`);
            if (mount) mount.innerHTML = html;
        }
        const js = await decryptChunk(parsed.j, projectId, "::js");
        if (js) {
            const script = document.createElement("script");
            script.textContent = js;
            document.head.appendChild(script);
            document.head.removeChild(script);
        }
    }

    // ─── Signaler + Preloader ─────────────────────────────────────────────────

    function createSignaler(onSignal) {
        return (stage, detail = {}) => {
            if (typeof onSignal === "function") onSignal({ stage, ...detail });
            emit(stage, detail);
        };
    }

    function createPreloader(selector) {
        const target = document.querySelector(selector || "[data-wh]");
        if (!target) return { show: () => {}, hide: () => {} };
        const loader = document.createElement("div");
        loader.setAttribute("data-wh-loader", "");
        loader.style.cssText = "display:flex;align-items:center;justify-content:center;padding:24px;width:100%;box-sizing:border-box;";
        loader.innerHTML = `<div style="width:28px;height:28px;border:3px solid #e5e7eb;border-top-color:#6366f1;border-radius:50%;animation:wh-spin 0.7s linear infinite;"></div><style>@keyframes wh-spin{to{transform:rotate(360deg);}}</style>`;
        return {
            show() { target.appendChild(loader); },
            hide() { if (loader.parentNode) loader.parentNode.removeChild(loader); }
        };
    }

    // ─── Main load ────────────────────────────────────────────────────────────

    /**
     * @param {string}   cdnUrl
     * @param {string}   projectId
     * @param {string}   token
     * @param {number}   expires       0 = never
     * @param {string}   [selector]
     * @param {function} [onSignal]
     * @param {Array}    [deps]
     * @param {object}   [options]     { sandbox, allowedDomains, beforeMount, afterMount, onError }
     */
    async function load(cdnUrl, projectId, token, expires, selector = "[data-wh]", onSignal = null, deps = [], options = {}) {
        if (!cdnUrl || !projectId || !token || expires === undefined || expires === null) {
            console.error("[WebHanger] Missing required params");
            return;
        }
        if (expires !== 0 && Math.floor(Date.now() / 1000) > expires) {
            console.warn("[WebHanger] Token expired.");
            return;
        }

        const signal = createSignaler(onSignal);
        const preloader = createPreloader(selector);
        const startTime = performance.now();

        signal("start", { cdnUrl, selector });
        preloader.show();
        recordMetric("loads", 1);

        const cacheKey = `${cdnUrl}@${expires}`;

        try {
            signal("fetching");
            const { data: payload, source } = await cacheGetSWR(
                cacheKey,
                () => fetchComponent(cdnUrl, token, expires)
            );

            let parsed;
            try { parsed = JSON.parse(payload); } catch (_) { parsed = {}; }

            if (parsed.assets && parsed.assets.length) {
                signal("assets", { count: parsed.assets.length });
                await loadAssets(parsed.assets);
            }

            const allDeps = [...deps, ...(parsed.dependencies || [])];
            if (allDeps.length) {
                signal("deps", { count: allDeps.length });
                for (const dep of allDeps) {
                    if (typeof dep === "object" && dep.cdnUrl) await loadDependency(dep, projectId);
                }
            }

            signal("injecting");
            preloader.hide();
            await injectComponent(payload, projectId, selector, options);

            const elapsed = Math.round(performance.now() - startTime);
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

    // ─── Hard flush ───────────────────────────────────────────────────────────

    async function clearCache() {
        Object.keys(localStorage).filter(k => k.startsWith(LS_PREFIX)).forEach(k => localStorage.removeItem(k));
        try {
            const db = await openIDB();
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).clear();
        } catch (_) {}
        if ("caches" in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
        }
        if ("serviceWorker" in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.unregister()));
        }
        Object.keys(sessionStorage).filter(k => k.startsWith(LS_PREFIX)).forEach(k => sessionStorage.removeItem(k));
    }

    // ─── Zero-code Custom Element <wh-component> ──────────────────────────────
    // Usage:
    //   WebHangerFront.initialize("./wh-manifest.json");
    //   <wh-component name="navbar"></wh-component>

    let globalManifest = null;
    let globalManifestSrc = "./wh-manifest.json";

    async function initialize(manifestSrc = "./wh-manifest.json") {
        globalManifestSrc = manifestSrc;
        const res = await fetch(manifestSrc);
        globalManifest = await res.json();
        // Auto-load any <wh-component> tags already in DOM
        document.querySelectorAll("wh-component[name]").forEach(el => el._load());
    }

    if (typeof customElements !== "undefined") {
        customElements.define("wh-component", class extends HTMLElement {
            async connectedCallback() {
                // If manifest already loaded, load immediately
                // Otherwise wait — initialize() will trigger _load()
                if (globalManifest) await this._load();
            }

            async _load() {
                const name    = this.getAttribute("name");
                const sandbox = this.hasAttribute("sandbox");

                if (!name) {
                    console.error("[WebHanger] <wh-component> missing 'name' attribute");
                    return;
                }

                // Use global manifest or fall back to per-element src
                const m = globalManifest || await fetch(
                    this.getAttribute("src") || globalManifestSrc
                ).then(r => r.json());

                const c = m.components[name];
                if (!c) {
                    console.error(`[WebHanger] <wh-component>: "${name}" not found in manifest`);
                    return;
                }

                // Use this element as the mount target
                this.setAttribute("data-wh-el", name);
                const selector = `wh-component[data-wh-el="${name}"]`;

                await load(
                    c.urls || c.url,
                    m.pid,
                    c.token,
                    c.expires,
                    selector,
                    null,
                    [],
                    { sandbox }
                );
            }
        });
    }

    // ─── WebGPU Detection ─────────────────────────────────────────────────────

    const gpu = { supported: false, adapter: null, device: null };

    async function initWebGPU() {
        if (!navigator.gpu) return false;
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) return false;
            const device = await adapter.requestDevice();
            gpu.supported = true;
            gpu.adapter = adapter;
            gpu.device = device;
            emit("gpu", { supported: true, adapter });
            return true;
        } catch (_) { return false; }
    }

    // ─── Offline page + Service Worker ───────────────────────────────────────

    async function setOfflinePage(html = "", css = "") {
        if (!("serviceWorker" in navigator)) return;
        const reg = await navigator.serviceWorker.ready;
        reg.active?.postMessage({ type: "SET_OFFLINE_PAGE", html, css });
    }

    async function registerSW(swUrl = "/webhanger.sw.js") {
        if (!("serviceWorker" in navigator)) return;
        try {
            const reg = await navigator.serviceWorker.register(swUrl);
            emit("sw", { registered: true, scope: reg.scope });
        } catch (err) {
            console.warn("[WebHanger] SW registration failed:", err.message);
        }
    }

    // Auto-init WebGPU in background
    initWebGPU();

    global.WebHangerFront = { load, clearCache, use, on, metrics, initialize, registerSW, setOfflinePage, gpu, version: VERSION };

})(window);
