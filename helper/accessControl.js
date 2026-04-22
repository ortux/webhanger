/**
 * WebHanger Access Control
 * Role-based permissions stored in DB per project.
 *
 * Roles:    owner | admin | deployer | viewer
 * Actions:  deploy | read | delete | manage_access
 *
 * Storage: projects/{projectId}/access/{apiKey}
 * {
 *   role: "deployer",
 *   permissions: ["deploy", "read"],
 *   createdAt: ...,
 *   label: "CI/CD key"
 * }
 */

import crypto from "crypto";

// ─── Permission matrix ────────────────────────────────────────────────────────

const ROLE_PERMISSIONS = {
    owner:    ["deploy", "read", "delete", "manage_access"],
    admin:    ["deploy", "read", "delete", "manage_access"],
    deployer: ["deploy", "read"],
    viewer:   ["read"]
};

// ─── Key generation ───────────────────────────────────────────────────────────

export function generateApiKey() {
    return `wh_key_${crypto.randomBytes(24).toString("hex")}`;
}

// ─── Firebase RBAC ───────────────────────────────────────────────────────────

async function getFirestore(serviceAccountPath) {
    const admin = (await import("firebase-admin")).default;
    const fs = (await import("fs-extra")).default;
    const serviceAccount = fs.readJsonSync(serviceAccountPath);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    return admin.firestore();
}

/**
 * Grant a role to an API key for a project.
 */
export async function grantAccess(dbConfig, projectId, apiKey, role, label = "") {
    if (!ROLE_PERMISSIONS[role]) throw new Error(`Unknown role: ${role}. Valid: ${Object.keys(ROLE_PERMISSIONS).join(", ")}`);

    if (dbConfig.provider === "firebase") {
        const db = await getFirestore(dbConfig.serviceAccountPath);
        await db.collection("projects").doc(projectId)
            .collection("access").doc(apiKey)
            .set({
                role,
                permissions: ROLE_PERMISSIONS[role],
                label,
                createdAt: new Date().toISOString()
            });
        return { apiKey, role, permissions: ROLE_PERMISSIONS[role] };
    }
    throw new Error(`Access control not yet supported for provider: ${dbConfig.provider}`);
}

/**
 * Revoke access for an API key.
 */
export async function revokeAccess(dbConfig, projectId, apiKey) {
    if (dbConfig.provider === "firebase") {
        const db = await getFirestore(dbConfig.serviceAccountPath);
        await db.collection("projects").doc(projectId)
            .collection("access").doc(apiKey).delete();
        return true;
    }
    throw new Error(`Access control not yet supported for provider: ${dbConfig.provider}`);
}

/**
 * Check if an API key has permission to perform an action.
 * Returns the access record or throws if unauthorized.
 */
export async function checkPermission(dbConfig, projectId, apiKey, action) {
    if (dbConfig.provider === "firebase") {
        const db = await getFirestore(dbConfig.serviceAccountPath);
        const snap = await db.collection("projects").doc(projectId)
            .collection("access").doc(apiKey).get();

        if (!snap.exists) throw new Error("Unauthorized: API key not found.");

        const access = snap.data();
        if (!access.permissions.includes(action)) {
            throw new Error(`Forbidden: role "${access.role}" cannot perform "${action}".`);
        }
        return access;
    }
    throw new Error(`Access control not yet supported for provider: ${dbConfig.provider}`);
}

/**
 * List all access entries for a project.
 */
export async function listAccess(dbConfig, projectId) {
    if (dbConfig.provider === "firebase") {
        const db = await getFirestore(dbConfig.serviceAccountPath);
        const snap = await db.collection("projects").doc(projectId)
            .collection("access").get();
        return snap.docs.map(d => ({ apiKey: d.id, ...d.data() }));
    }
    throw new Error(`Access control not yet supported for provider: ${dbConfig.provider}`);
}
