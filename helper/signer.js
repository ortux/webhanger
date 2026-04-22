import crypto from "crypto";

/**
 * Signs a component URL with HMAC-SHA256.
 * expiresInSeconds is optional — if not provided, token never expires.
 */
export function signUrl(componentPath, projectId, secretKey, expiresInSeconds = null) {
    const expires = expiresInSeconds ? Math.floor(Date.now() / 1000) + expiresInSeconds : 0; // 0 = no expiry
    const payload = `${projectId}:${componentPath}:${expires}`;
    const token = crypto.createHmac("sha256", secretKey).update(payload).digest("hex");
    return { token, expires };
}

/**
 * Verifies a signed token.
 * If expires is 0, token never expires.
 */
export function verifyToken(componentPath, projectId, secretKey, token, expires) {
    if (expires !== 0 && Date.now() / 1000 > expires) return false;
    const payload = `${projectId}:${componentPath}:${expires}`;
    const expected = crypto.createHmac("sha256", secretKey).update(payload).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

/**
 * Generates a one-time project secret key on init.
 */
export function generateSecretKey() {
    return crypto.randomBytes(32).toString("hex");
}
