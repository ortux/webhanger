import crypto from "crypto";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;

/**
 * Derives a 256-bit AES key from SHA-256(projectId + salt)
 * Simple, fast, consistent between Node and browser.
 */
function deriveKey(projectId, salt) {
    return crypto.createHash("sha256").update(projectId + salt).digest();
}

export function encrypt(plaintext, projectId, salt = "::wh") {
    if (!plaintext) return "";
    const key = deriveKey(projectId, salt);
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decrypt(encoded, projectId, salt = "::wh") {
    if (!encoded) return "";
    const [ivB64, tagB64, dataB64] = encoded.split(":");
    const key = deriveKey(projectId, salt);
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const data = Buffer.from(dataB64, "base64");
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
}

export function integrityHash(content) {
    return crypto.createHash("sha256").update(content).digest("hex");
}
