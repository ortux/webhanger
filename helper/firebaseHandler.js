import admin from "firebase-admin";
import fs from "fs-extra";

let db = null;

export function initFirebase(serviceAccountPath) {
    if (db) return db; // already initialized

    const serviceAccount = fs.readJsonSync(serviceAccountPath);

    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }

    db = admin.firestore();
    return db;
}

/**
 * Registers a component in Firestore under:
 * projects/{projectId}/components/{name}/versions/{version}
 */
export async function registerComponent(serviceAccountPath, projectId, componentMeta) {
    const db = initFirebase(serviceAccountPath);
    const { name, version, cdnUrl, token, expires, dependencies = [] } = componentMeta;

    const ref = db
        .collection("projects").doc(projectId)
        .collection("components").doc(name)
        .collection("versions").doc(version);

    await ref.set({
        name,
        version,
        cdnUrl,
        token,
        expires,
        dependencies,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
}

/**
 * Fetches a specific component version metadata.
 */
export async function getComponent(serviceAccountPath, projectId, name, version) {
    const db = initFirebase(serviceAccountPath);

    const ref = db
        .collection("projects").doc(projectId)
        .collection("components").doc(name)
        .collection("versions").doc(version);

    const snap = await ref.get();
    if (!snap.exists) return null;
    return snap.data();
}
