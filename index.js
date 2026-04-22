import loadConfig from "./helper/loadConfig.js";
import { getComponent, registerComponent } from "./helper/dbHandler.js";
import { verifyToken, signUrl, generateSecretKey } from "./helper/signer.js";
import { deploy as registryDeploy } from "./core/registry.js";
import { provisionBucket, provisionCloudFront } from "./helper/awsProvisioner.js";
import { upload, remove } from "./helper/bucketHandler.js";
import { bundle } from "./helper/bundler.js";

export class WebHanger {
    constructor(configPath = null) {
        this.config = loadConfig(configPath);
    }

    /**
     * Bundle + upload + sign + register a component.
     * @param {string} componentDir - path to folder with html/css/js
     * @param {string} name         - component name e.g. "navbar"
     * @param {string} version      - semver string e.g. "1.0.0"
     * @param {object} options      - { expiresInSeconds, token, dependencies }
     */
    async deploy(componentDir, name, version, options = {}) {
        const { expiresInSeconds = null, token = null, dependencies = [] } = options;
        return await registryDeploy(
            this.config,
            componentDir,
            name,
            version,
            dependencies,
            expiresInSeconds,
            token
        );
    }

    /**
     * Resolve a component — fetch metadata + verify token.
     * Returns { cdnUrl, token, expires, dependencies }
     */
    async resolve(name, version = "latest") {
        const { projectId, secretKey, db } = this.config;
        const meta = await getComponent(db, projectId, name, version);
        if (!meta) throw new Error(`Component ${name}@${version} not found.`);

        if (meta.expires !== 0) {
            const valid = verifyToken(
                `components/${name}@${version}.js`,
                projectId,
                secretKey,
                meta.token,
                meta.expires
            );
            if (!valid) throw new Error(`Token for ${name}@${version} is invalid or expired.`);
        }

        return {
            cdnUrl: meta.cdnUrl,
            token: meta.token,
            expires: meta.expires,
            dependencies: meta.dependencies
        };
    }

    /**
     * Delete a component from storage.
     */
    async remove(name, version) {
        const { storage } = this.config;
        const key = `components/${name}@${version}.js`;
        await remove(storage, key);
    }

    /**
     * Re-sign an existing component with a new token/expiry.
     * Useful for rotating tokens without redeploying.
     */
    async resign(name, version, options = {}) {
        const { expiresInSeconds = null, token = null } = options;
        const { projectId, secretKey, cdn, db } = this.config;
        const key = `components/${name}@${version}.js`;

        let newToken, expires;
        if (token) {
            expires = expiresInSeconds ? Math.floor(Date.now() / 1000) + expiresInSeconds : 0;
            newToken = token;
        } else {
            ({ token: newToken, expires } = signUrl(key, projectId, secretKey, expiresInSeconds));
        }

        const cdnUrl = `${cdn.url}/${key}`;
        const existing = await getComponent(db, projectId, name, version);

        await registerComponent(db, projectId, {
            name,
            version,
            cdnUrl,
            token: newToken,
            expires,
            dependencies: existing?.dependencies || []
        });

        return { cdnUrl, token: newToken, expires };
    }

    /**
     * List all versions of a component from DB.
     */
    async versions(name) {
        const { projectId, db } = this.config;

        if (db.provider === "firebase") {
            const admin = (await import("firebase-admin")).default;
            const { initFirebase } = await import("./helper/dbHandler.js");
            const firestore = initFirebase ? null : null; // handled inside dbHandler
            // Use raw firestore for listing subcollection
            const { getComponent: _ , ...rest } = await import("./helper/dbHandler.js");
            const dbInstance = await getFirestoreInstance(db.serviceAccountPath);
            const snap = await dbInstance
                .collection("projects").doc(projectId)
                .collection("components").doc(name)
                .collection("versions").get();
            return snap.docs.map(d => d.data());
        }

        throw new Error(`versions() not yet supported for provider: ${db.provider}`);
    }

    /**
     * Returns the config loaded for this instance.
     */
    getConfig() {
        return this.config;
    }
}

// Helper for versions() firebase path
async function getFirestoreInstance(serviceAccountPath) {
    const admin = (await import("firebase-admin")).default;
    const fs = (await import("fs-extra")).default;
    const serviceAccount = fs.readJsonSync(serviceAccountPath);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    return admin.firestore();
}

// Named exports for direct use without instantiation
export { signUrl, verifyToken, generateSecretKey } from "./helper/signer.js";
export { bundle } from "./helper/bundler.js";
export { upload, remove } from "./helper/bucketHandler.js";
export { registerComponent, getComponent } from "./helper/dbHandler.js";
export { provisionBucket, provisionCloudFront } from "./helper/awsProvisioner.js";
export { deploy } from "./core/registry.js";
export { resolve as resolveGraph } from "./core/resolver.js";
export { default as loadConfig } from "./helper/loadConfig.js";
export { analyzeComponent, autoGenerateComponentMeta } from "./helper/analyzer.js";
export { convert } from "./helper/converter.js";
export { build } from "./core/builder.js";
export { grantAccess, revokeAccess, checkPermission, listAccess, generateApiKey } from "./helper/accessControl.js";
