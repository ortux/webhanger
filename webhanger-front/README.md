# webhanger-front

Browser SDK for WebHanger. Loads encrypted UI components from CDN and injects them into the DOM. No eval, no readable source — decrypted in memory and applied directly.

> **Note:** This package uses `fetch` to load components from your CDN. This is expected behavior and is flagged as an informational notice by npm's security scanner — not a vulnerability.

---

## Install

```bash
npm install webhanger-front
```

Or via script tag:

```html
<script src="https://unpkg.com/webhanger-front/browser.js"></script>
```

---

## Usage

### Script tag (plain HTML)

```html
<div data-wh></div>

<script src="https://unpkg.com/webhanger-front/browser.js"></script>
<script>
  WebHangerFront.load(
    "https://xxx.cloudfront.net/components/navbar@1.0.0.js",
    "wh_1234567890",   // projectId from webhanger.config.json
    "your-token",
    0                  // expires: 0 = never, or unix timestamp
  );
</script>
```

### ESM (Vite, Webpack, Rollup)

```js
import { load } from "webhanger-front";

await load(
  "https://xxx.cloudfront.net/components/navbar@1.0.0.js",
  "wh_1234567890",
  "your-token",
  0
);
```

### React

```jsx
import { useEffect } from "react";
import { load } from "webhanger-front";

export default function Navbar() {
  useEffect(() => {
    load(
      "https://xxx.cloudfront.net/components/navbar@1.0.0.js",
      "wh_1234567890",
      "your-token",
      0,
      "#navbar-mount"
    );
  }, []);

  return <div id="navbar-mount" />;
}
```

### Vue

```vue
<template>
  <div ref="mount" />
</template>

<script setup>
import { onMounted, ref } from "vue";
import { load } from "webhanger-front";

const mount = ref(null);

onMounted(() => {
  load(
    "https://xxx.cloudfront.net/components/navbar@1.0.0.js",
    "wh_1234567890",
    "your-token",
    0,
    "#navbar-mount"
  );
});
</script>
```

---

## API

### `load(cdnUrl, projectId, token, expires, selector?)`

| Param | Type | Description |
|---|---|---|
| `cdnUrl` | `string` | Full CDN URL of the component |
| `projectId` | `string` | Your WebHanger project ID — used as decrypt key |
| `token` | `string` | HMAC signed token from `wh deploy` |
| `expires` | `number` | Unix timestamp expiry. `0` = never expires |
| `selector` | `string` | CSS selector for mount target. Default: `[data-wh]` |

```js
await load(cdnUrl, projectId, token, expires, "[data-wh]");
```

---

### `clearCache()`

Clears all cached components from localStorage and IndexedDB.

```js
import { clearCache } from "webhanger-front";
await clearCache();
```

---

### `version`

```js
import { version } from "webhanger-front";
console.log(version); // "1.0.0"
```

---

## Caching

Components are automatically cached after first load:

| Size | Storage |
|---|---|
| < 50KB | `localStorage` |
| >= 50KB | `IndexedDB` |

Cache key is `cdnUrl@expires` — changing the version or expiry busts the cache automatically.

---

## Offline support

Register the service worker from the `webhanger` package for offline component delivery:

```js
navigator.serviceWorker.register("/webhanger.sw.js");
```

---

## How it works

1. Fetches encrypted JSON payload from CDN
2. Decrypts each chunk in memory using `projectId` as cipher key
3. Injects CSS into `<head>`, HTML into mount target, JS via `<script>`
4. No `eval` — browser parses JS natively
5. Payload on CDN is unreadable without the projectId
