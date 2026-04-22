import admin from "firebase-admin";
import fs from "fs-extra";
import path from "path";

// ─── Firebase ─────────────────────────────────────────────────────────────────

let firebaseDb = null;

function getFirestore(serviceAccountPath) {
    if (firebaseDb) return firebaseDb;
    // Resolve path relative to cwd first, then walk up to find it
    let resolvedPath = path.resolve(process.cwd(), serviceAccountPath);
    if (!fs.existsSync(resolvedPath)) {
        // Try resolving from parent directories
        let dir = process.cwd();
        for (let i = 0; i < 5; i++) {
            const candidate = path.join(dir, path.basename(serviceAccountPath));
            if (fs.existsSync(candidate)) { resolvedPath = candidate; break; }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    const serviceAccount = fs.readJsonSync(resolvedPath);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    firebaseDb = admin.firestore();
    return firebaseDb;
}

async function firebaseRegister(db, projectId, meta) {
    const { name, version, cdnUrl, token, expires, dependencies = [] } = meta;
    await db
        .collection("projects").doc(projectId)
        .collection("components").doc(name)
        .collection("versions").doc(version)
        .set({ name, version, cdnUrl, token, expires, dependencies, createdAt: admin.firestore.FieldValue.serverTimestamp() });
}

async function firebaseGet(db, projectId, name, version) {
    const snap = await db
        .collection("projects").doc(projectId)
        .collection("components").doc(name)
        .collection("versions").doc(version)
        .get();
    return snap.exists ? snap.data() : null;
}

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function getSupabase(url, key) {
    const { createClient } = await import("@supabase/supabase-js");
    return createClient(url, key);
}

async function supabaseRegister(client, projectId, meta) {
    const { error } = await client.from("wh_components").upsert({
        project_id: projectId,
        name: meta.name,
        version: meta.version,
        cdn_url: meta.cdnUrl,
        token: meta.token,
        expires: meta.expires,
        dependencies: meta.dependencies || [],
        created_at: new Date().toISOString()
    });
    if (error) throw new Error(`Supabase error: ${error.message}`);
}

async function supabaseGet(client, projectId, name, version) {
    const { data, error } = await client
        .from("wh_components")
        .select("*")
        .eq("project_id", projectId)
        .eq("name", name)
        .eq("version", version)
        .single();
    if (error) return null;
    return data ? { ...data, cdnUrl: data.cdn_url } : null;
}

// ─── MongoDB ──────────────────────────────────────────────────────────────────

async function getMongo(uri) {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(uri);
    await client.connect();
    return client.db("webhanger");
}

async function mongoRegister(db, projectId, meta) {
    await db.collection("components").updateOne(
        { projectId, name: meta.name, version: meta.version },
        { $set: { ...meta, projectId, createdAt: new Date() } },
        { upsert: true }
    );
}

async function mongoGet(db, projectId, name, version) {
    return await db.collection("components").findOne({ projectId, name, version });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function registerComponent(dbConfig, projectId, meta) {
    if (dbConfig.provider === "firebase") {
        const db = getFirestore(dbConfig.serviceAccountPath);
        return firebaseRegister(db, projectId, meta);
    }
    if (dbConfig.provider === "supabase") {
        const client = await getSupabase(dbConfig.url, dbConfig.key);
        return supabaseRegister(client, projectId, meta);
    }
    if (dbConfig.provider === "mongodb") {
        const db = await getMongo(dbConfig.uri);
        return mongoRegister(db, projectId, meta);
    }
    throw new Error(`Unknown DB provider: ${dbConfig.provider}`);
}

export async function getComponent(dbConfig, projectId, name, version) {
    if (dbConfig.provider === "firebase") {
        const db = getFirestore(dbConfig.serviceAccountPath);
        return firebaseGet(db, projectId, name, version);
    }
    if (dbConfig.provider === "supabase") {
        const client = await getSupabase(dbConfig.url, dbConfig.key);
        return supabaseGet(client, projectId, name, version);
    }
    if (dbConfig.provider === "mongodb") {
        const db = await getMongo(dbConfig.uri);
        return mongoGet(db, projectId, name, version);
    }
    throw new Error(`Unknown DB provider: ${dbConfig.provider}`);
}
