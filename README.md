# WebHanger

> **Component-as-a-Service (CaaS)** — Bundle once. AES-256 encrypt. Deploy to edge CDN. Load anywhere with zero code.

WebHanger is a secure, edge-delivered component distribution platform. Deploy encrypted UI components to a CDN and load them into any website or framework with a single tag — no tokens in HTML, no exposed secrets, no configuration.

---

## Packages

| Package | Install | Description |
|---|---|---|
| `webhanger` | `npm install -g webhanger` | CLI + Node.js library |
| `webhanger-front` | `npm install webhanger-front` | Browser + ESM SDK |

---

## Quick Start

```bash
npm install -g webhanger
wh init
wh ship ./components ./site 1.0.0 ./dist
```

Load in any HTML — zero JS required beyond the SDK:

```html
<script src="https://unpkg.com/webhanger-front@latest/browser.min.js"></script>
<script>WebHangerFront.initialize("./wh-manifest.json");</script>

<wh-component name="navbar"></wh-component>
<wh-component name="hero"></wh-component>
<wh-component name="footer" sandbox></wh-component>
```

Load in Next.js / React / Vite using the npm package:

```tsx
import { load } from "webhanger-front";

useEffect(() => {
  fetch("/wh-manifest.json")
    .then(r => r.json())
    .then(m => {
      const c = m.components["navbar"];
      load(c.urls || c.url, m.pid, c.token, c.expires, "#nav-mount");
    });
}, []);
```

---

## CLI Reference

### `wh init`
Interactive setup. Provisions S3 bucket + CloudFront automatically. Supports Firebase, Supabase, MongoDB. Optional Cloudflare Edge Worker setup.

### `wh ship` ⭐ The main command
Deploy + build + zip in one shot.
```bash
wh ship ./components ./site 1.0.0 ./dist
```
1. Deploys all components (bundle → AES-256 encrypt → upload → HMAC sign → register)
2. Resolves dependency graph
3. Writes `wh-manifest.json` (no secrets in HTML)
4. Production builds the site (minify HTML, extract CSS/JS to hashed files)
5. Zips for upload

### `wh deploy`
Deploy a single component.
```bash
wh deploy ./components/navbar navbar 1.0.0
```

### `wh graph-deploy`
Deploy all + resolve full dependency graph.
```bash
wh graph-deploy ./components 1.0.0 ./output
```

### `wh atomize`
Split a single HTML page into CDN-powered components automatically.
```bash
wh atomize ./docs/index.html ./atomized 1.0.0
```

### `wh build`
Production build — minifies HTML, extracts embedded CSS/JS to content-hashed files.
```bash
wh build ./site ./dist
```

### `wh zip`
Zip for deployment.
```bash
wh zip ./dist ./deploy.zip
```

### `wh analyze`
Detect framework, styling approach, CDN dependencies.
```bash
wh analyze ./components/navbar
# Framework: vanilla | Styling: tailwind | CDN: gsap, tailwind
```

### `wh convert`
Convert vanilla HTML/CSS/JS to any framework.
```bash
wh convert ./components/navbar navbar react ./output
# targets: react | vue | svelte | next | angular | astro
```

### `wh breakdown`
Extract embedded `<style>` and `<script>` from a single HTML file into separate files.
```bash
wh breakdown ./components/navbar
```

### `wh access`
Role-based access control.
```bash
wh access grant          # generate API key with role
wh access revoke <key>   # revoke
wh access list           # list all
```

### `wh edge-init`
Setup Cloudflare Edge Worker for production-grade delivery.
```bash
wh edge-init
cd edge && wrangler deploy
```

---

## Component Structure

```
components/
  navbar/
    index.html
    style.css
    script.js
    webhanger.component.json
```

### `webhanger.component.json`
```json
{
  "assets": [
    { "type": "script", "url": "https://cdn.tailwindcss.com" },
    { "type": "script", "url": "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js" }
  ],
  "dependencies": ["navbar@1.0.0", "chart@2.0.0"]
}
```

CDN assets are auto-detected by `wh analyze` and merged on deploy.

---

## Security

### AES-256-GCM Encryption
Every component chunk (HTML/CSS/JS) is encrypted before upload.
```
Key     = SHA-256(projectId + salt)
Payload = iv:tag:ciphertext  (base64)
Salts   = "::html" | "::css" | "::js"
```

### HMAC-SHA256 Signed URLs
```
token = HMAC-SHA256(projectId:path:expires, secretKey)
```

### Integrity Check
SHA-256 hash of raw content stored in payload. Verified after decryption — detects tampering.

### Domain Restriction
```js
load(url, pid, token, 0, "[data-wh]", null, [], {
    allowedDomains: ["mysite.com"]
});
```

### Manifest-based Delivery
Tokens, projectId, CDN URLs never appear in HTML. Fetched at runtime from `wh-manifest.json`.

### Token Expiry
```js
// Never expires
wh.deploy("./navbar", "navbar", "1.0.0");

// Expires in 24 hours
wh.deploy("./navbar", "navbar", "1.0.0", { expiresInSeconds: 86400 });
```

---

## Dependency Graph

```
dashboard@1.0.0
  ├── navbar@1.0.0
  └── statsbar@1.0.0
        └── chart@1.0.0
```

- Depth-first resolution
- Circular dependency detection with full chain error
- Deps load before parent component

```js
import { resolveGraph } from "webhanger";
const graph = await resolveGraph(config.db, projectId, "dashboard", "1.0.0");
// Returns: [chart, navbar, statsbar, dashboard]
```

---

## Multi-CDN Failover

```json
{
  "cdn": {
    "url": "https://primary.cloudfront.net",
    "fallbacks": ["https://fallback.r2.dev", "https://backup.b-cdn.net"]
  }
}
```

SDK tries each URL in order. Zero code changes needed on the frontend.

---

## Edge Worker (Cloudflare Workers)

- HMAC token validation at edge (~5ms overhead)
- Version resolution (`latest` → `1.2.0` from KV)
- Geo-based routing (India → ap-south-1, Europe → eu-west-1)
- Rate limiting (100 req/min per IP)

```bash
wh edge-init
cd edge && wrangler deploy
```

---

## Browser SDK

### Zero-code Custom Element
```html
<script src="https://unpkg.com/webhanger-front@latest/browser.min.js"></script>
<script>WebHangerFront.initialize("./wh-manifest.json");</script>

<wh-component name="navbar"></wh-component>
<wh-component name="footer" sandbox></wh-component>
```

### ESM (Next.js / React / Vite)
```js
import { load, use, on, registerSW, clearCache, metrics, gpu } from "webhanger-front";
```

### Manual load
```js
await load(
    cdnUrl,      // string or string[] (multi-CDN)
    projectId,   // AES decrypt key
    token,       // HMAC token
    expires,     // unix timestamp, 0 = never
    selector,    // CSS selector, default "[data-wh]"
    onSignal,    // optional signal callback
    deps,        // optional pre-resolved deps
    options      // lifecycle hooks + security options
);
```

### Lifecycle hooks
```js
await load(url, pid, token, 0, "[data-wh]", null, [], {
    beforeMount: ({ html }) => showSpinner(),
    afterMount:  ({ target }) => hideSpinner(),
    onError:     (err) => showFallback(err),
    sandbox:     true,                       // Shadow DOM isolation
    allowedDomains: ["mysite.com"]           // domain restriction
});
```

### Signal callback
```js
await load(url, pid, token, 0, "[data-wh]", ({ stage, time, source }) => {
    // stages: start → fetching → assets → deps → injecting → done | error
    console.log(stage, time, source);
});
```

### Plugin system
```js
use({
    install({ on }) {
        on("load",   ({ time, source }) => analytics.track("load", { time, source }));
        on("error",  ({ message })      => errorTracker.capture(message));
        on("metric", ({ name, value })  => dashboard.update(name, value));
        on("gpu",    ({ supported })    => console.log("WebGPU:", supported));
        on("sw",     ({ scope })        => console.log("SW registered:", scope));
    }
});
```

### Observability
```js
on("load", ({ time, source }) => console.log(time, source));
console.log(metrics); // { loads, cacheHits, errors, totalTime }
```

### WebGPU
```js
console.log(gpu.supported); // auto-detected on load
on("gpu", ({ supported }) => console.log("GPU available:", supported));
```

### Offline + Service Worker
```js
// Register SW for offline support
await registerSW("./webhanger.sw.js");

// Set custom offline page (pure inline HTML/CSS — zero external deps)
await setOfflinePage(
    "<h1>We're offline</h1><p>Back soon.</p><button onclick='location.reload()'>Retry</button>",
    "body { background: #030712; color: white; text-align: center; padding: 40px; }"
);
```

Offline behavior:
- Online first visit → loads from CDN, caches everything
- Online repeat visit → loads from SW cache instantly, badge shows
- Offline with cache → full page works from SW cache
- Offline no cache → custom offline page with "⬡ Served by WebHanger" badge

### Hard flush
```js
await clearCache();
// Clears: localStorage, IndexedDB, SW caches, sessionStorage, unregisters SW
```

---

## Caching

| Layer | Used for |
|---|---|
| `localStorage` | Components < 50KB |
| `IndexedDB` | Components ≥ 50KB |
| Service Worker | Offline + navigation cache |

**Stale-while-revalidate** — returns cached version instantly, refreshes in background.

---

## Sandboxed Execution (Shadow DOM)

```js
await load(url, pid, token, 0, "[data-wh]", null, [], { sandbox: true });
// or
<wh-component name="footer" sandbox></wh-component>
```

---

## Access Control

| Role | deploy | read | delete | manage_access |
|---|---|---|---|---|
| owner | ✅ | ✅ | ✅ | ✅ |
| admin | ✅ | ✅ | ✅ | ✅ |
| deployer | ✅ | ✅ | ❌ | ❌ |
| viewer | ❌ | ✅ | ❌ | ❌ |

---

## Node.js API

```js
import { WebHanger } from "webhanger";
const wh = new WebHanger();

// Deploy
const result = await wh.deploy("./components/navbar", "navbar", "1.0.0", {
    expiresInSeconds: 86400,
    dependencies: ["chart@1.0.0"]
});
// { cdnUrl, cdnUrls, token, expires, dependencies }

// Resolve
const comp = await wh.resolve("navbar", "1.0.0");

// Rotate token
await wh.resign("navbar", "1.0.0", { expiresInSeconds: 3600 });

// Delete
await wh.remove("navbar", "1.0.0");
```

### Named exports
```js
import {
    bundle, encrypt, decrypt, integrityHash,
    signUrl, verifyToken, generateSecretKey,
    upload, remove,
    registerComponent, getComponent,
    deploy, resolveGraph,
    convert, analyzeComponent,
    build,
    grantAccess, revokeAccess, checkPermission, listAccess, generateApiKey,
    provisionBucket, provisionCloudFront,
    loadConfig
} from "webhanger";
```

---

## Next.js Integration

```bash
npm install webhanger-front
```

```tsx
// components/WebHangerComponent.tsx
"use client";
import { useEffect, useRef } from "react";
import { load } from "webhanger-front";

export default function WebHangerComponent({ name }: { name: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/wh-manifest.json")
      .then(r => r.json())
      .then(m => {
        const c = m.components[name];
        if (!c || !ref.current) return;
        ref.current.id = `wh-${name}`;
        load(c.urls || c.url, m.pid, c.token, c.expires, `#wh-${name}`);
      });
  }, [name]);

  return <div ref={ref} />;
}
```

```tsx
// app/page.tsx
import WebHangerComponent from "@/components/WebHangerComponent";

export default function Home() {
  return (
    <main>
      <WebHangerComponent name="navbar" />
      <WebHangerComponent name="hero" />
      <WebHangerComponent name="footer" />
    </main>
  );
}
```

---

## Storage Providers

| Provider | Notes |
|---|---|
| `s3` | AWS S3 — auto-provisions bucket + CloudFront |
| `r2` | Cloudflare R2 — zero egress fees |
| `minio` | Self-hosted MinIO — S3-compatible |
| `local` | Local disk — dev/testing only |

## Database Providers

| Provider | Notes |
|---|---|
| `firebase` | Firebase Firestore — free tier, real-time |
| `supabase` | Supabase Postgres — open source |
| `mongodb` | MongoDB Atlas — flexible documents |

---

## `webhanger.config.json`

```json
{
  "project": "my-app",
  "projectId": "wh_1234567890",
  "secretKey": "64-char-hex-secret",
  "storage": {
    "provider": "s3",
    "accessKey": "...",
    "secretKey": "...",
    "bucket": "my-bucket",
    "region": "ap-south-1",
    "distributionId": "EXXXXX"
  },
  "cdn": {
    "url": "https://primary.cloudfront.net",
    "fallbacks": ["https://fallback.r2.dev"]
  },
  "db": {
    "provider": "firebase",
    "serviceAccountPath": "./firebase-service-account.json"
  }
}
```

> Keep this file private. Never commit it.

---

## Architecture

```
Developer
  └── wh ship ./components ./site
        ├── wh analyze    → detect Tailwind, GSAP, deps
        ├── wh breakdown  → extract CSS/JS from single HTML
        ├── bundle        → html + css + js → single payload
        ├── AES-256-GCM   → encrypt each chunk (SHA-256 key)
        ├── SHA-256 hash  → integrity fingerprint
        ├── S3 upload     → store encrypted payload
        ├── HMAC sign     → project-scoped signed URL
        ├── DB register   → metadata + dep graph
        ├── wh build      → minify HTML, extract CSS/JS
        └── wh zip        → deploy.zip ready for upload

Browser
  └── <wh-component name="navbar">
        ├── fetch wh-manifest.json (no hardcoded secrets)
        ├── check token expiry
        ├── stale-while-revalidate cache
        ├── fetch from CloudFront / Edge Worker
        │     └── validate token + geo route + rate limit
        ├── multi-CDN failover if primary fails
        ├── load CDN assets (Tailwind, GSAP, etc.)
        ├── resolve dependency graph (depth-first)
        ├── AES-256-GCM decrypt in memory
        ├── SHA-256 integrity verify
        ├── domain restriction check
        ├── inject CSS → HTML → JS (or Shadow DOM)
        ├── fire lifecycle hooks (beforeMount / afterMount)
        ├── emit metrics + plugin events
        ├── WebGPU detection
        └── Service Worker caches for offline use
```

---

## Real-World Use Cases

- **Enterprise micro-frontends** — shared UI across 50+ apps, update once
- **Education platforms** — push UI updates to all school sites instantly
- **Low-bandwidth regions** — cache once, serve offline via Service Worker
- **Security platforms** — inject warnings/banners dynamically across sites
- **White-label SaaS** — per-tenant component customization

---

## License

ISC
