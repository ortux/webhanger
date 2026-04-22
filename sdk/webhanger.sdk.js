/**
 * WebHanger Browser SDK
 * Fetches encrypted component payload from CDN.
 * Decrypts each chunk (html/css/js) and applies directly to DOM — no eval.
 * Handles caching (localStorage / IndexedDB) and offline fallback.
 */
(function (global) {
    const VERSION = "1.0.0";
    const IDB_NAME = "webhanger_cache";
    const IDB_STORE = "components";
    const LS_PREFIX = "wh_";

    // ─── XOR decrypt (mirrors bundler) ───────────────────────────────────────

    function xorDecode(str, key) {
        let out = "";
        for (let i = 0; i < str.length; i++) {
            out += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        return out;
    }

    function decrypt(b64, projectId, salt) {
        if (!b64) return "";
        const decoded = atob(b64);
        return xorDecode(decoded, projectId + salt);
    }

    // ─── IndexedDB helpers ───────────────────────────────────────────────────

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

    // ─── Cache layer ─────────────────────────────────────────────────────────

    const SIZE_THRESHOLD = 50 * 1024;

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

    // ─── Fetch from CDN ───────────────────────────────────────────────────────

    async function fetchComponent(cdnUrl, token, expires) {
        const url = expires
            ? `${cdnUrl}?token=${token}&expires=${expires}`
            : `${cdnUrl}?token=${token}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch component: ${res.status}`);
        return await res.text();
    }

    // ─── Decrypt + inject directly into DOM (no eval) ─────────────────────────

    function injectComponent(encryptedPayload, projectId, targetSelector) {
        const target = document.querySelector(targetSelector || "[data-wh]");
        if (!target) {
            console.warn("[WebHanger] No mount target found.");
            return;
        }

        let payload;
        try {
            payload = JSON.parse(encryptedPayload);
        } catch (_) {
            console.error("[WebHanger] Invalid component payload.");
            return;
        }

        // Decrypt CSS → inject into <head>
        const css = decrypt(payload.c, projectId, "::css");
        if (css) {
            const style = document.createElement("style");
            style.textContent = css;
            document.head.appendChild(style);
        }

        // Decrypt HTML → inject into mount target
        const html = decrypt(payload.h, projectId, "::html");
        if (html) target.innerHTML = html;

        // Decrypt JS → inject as <script> (no eval, browser parses it natively)
        const js = decrypt(payload.j, projectId, "::js");
        if (js) {
            const script = document.createElement("script");
            script.textContent = js;
            document.head.appendChild(script);
            document.head.removeChild(script);
        }
    }

    // ─── Main loader ──────────────────────────────────────────────────────────

    /**
     * @param {string} cdnUrl      - Full CDN URL of the component
     * @param {string} projectId   - Your WebHanger project ID (used as decrypt key)
     * @param {string} token       - HMAC signed token
     * @param {number} expires     - Token expiry unix timestamp (0 = never)
     * @param {string} [selector]  - CSS selector of mount element (default: [data-wh])
     */
    async function load(cdnUrl, projectId, token, expires, selector = "[data-wh]") {
        if (!cdnUrl || !projectId || !token || expires === undefined || expires === null) {
            console.error("[WebHanger] Missing required params: cdnUrl, projectId, token, expires");
            return;
        }

        if (expires !== 0 && Math.floor(Date.now() / 1000) > expires) {
            console.warn("[WebHanger] Token expired.");
            return;
        }

        const cacheKey = `${cdnUrl}@${expires}`;

        try {
            let payload = await cacheGet(cacheKey);

            if (!payload) {
                payload = await fetchComponent(cdnUrl, token, expires);
                await cacheSet(cacheKey, payload);
            }

            injectComponent(payload, projectId, selector);
        } catch (err) {
            console.error("[WebHanger] Load failed:", err.message);
        }
    }

    global.WebHanger = { load, version: VERSION };

})(window);
