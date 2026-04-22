import { bundle } from "../helper/bundler.js";
import { upload } from "../helper/bucketHandler.js";
import { signUrl } from "../helper/signer.js";
import { registerComponent } from "../helper/dbHandler.js";

/**
 * Full deploy flow:
 * 1. Bundle component folder → single JS
 * 2. Upload to storage
 * 3. Generate signed CDN URL
 * 4. Register metadata in Firestore
 */
export async function deploy(config, componentDir, name, version, dependencies = [], expiresInSeconds = null, customToken = null) {
    const { projectId, secretKey, storage, cdn, db } = config;

    // 1. Bundle + encode
    const bundledJs = await bundle(componentDir, projectId);

    // 2. Extract dependencies declared in webhanger.component.json
    let parsedPayload = {};
    try { parsedPayload = JSON.parse(bundledJs); } catch (_) {}
    const resolvedDeps = dependencies.length ? dependencies : (parsedPayload.dependencies || []);

    // 3. Upload
    const storageKey = `components/${name}@${version}.js`;
    await upload(storage, storageKey, bundledJs);

    // 4. Generate CDN URLs — primary + fallbacks for multi-CDN failover
    const cdnUrl = `${cdn.url}/${storageKey}`;
    const cdnUrls = [cdnUrl];
    if (cdn.fallbacks && cdn.fallbacks.length) {
        cdn.fallbacks.forEach(fb => cdnUrls.push(`${fb}/${storageKey}`));
    }

    let token, expires;
    if (customToken) {
        expires = expiresInSeconds ? Math.floor(Date.now() / 1000) + expiresInSeconds : 0;
        token = customToken;
    } else {
        ({ token, expires } = signUrl(storageKey, projectId, secretKey, expiresInSeconds));
    }

    // 5. Register with all CDN URLs
    await registerComponent(db, projectId, { name, version, cdnUrl, cdnUrls, token, expires, dependencies: resolvedDeps });

    return { cdnUrl, cdnUrls, token, expires, dependencies: resolvedDeps };
}
