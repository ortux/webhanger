import fs from "fs-extra";
import path from "path";
import { autoGenerateComponentMeta } from "./analyzer.js";
import { encrypt, integrityHash } from "./crypto.js";
import { breakdown } from "./breakdown.js";


/**
 * Bundles html+css+js into an encrypted JSON payload.
 * Reads webhanger.component.json for CDN asset declarations.
 * Each chunk is XOR-encoded with projectId + chunk-type salt, then base64.
 */
export async function bundle(componentDir, projectId) {
    // Auto-breakdown: extract <style>/<script> from single HTML file if needed
    const broke = await breakdown(componentDir);
    if (broke) {
        console.log(`  ✓ Breakdown: extracted CSS (${broke.cssLines} lines) + JS (${broke.jsLines} lines) from single file`);
    }

    // Auto-detect + generate webhanger.component.json before bundling
    const { analysis } = await autoGenerateComponentMeta(componentDir);
    console.log(`  ✓ Framework detected: ${analysis.framework}`);
    console.log(`  ✓ Styling: ${analysis.styling.join(", ")}`);
    if (analysis.assets.length) {
        console.log(`  ✓ CDN assets resolved: ${analysis.assets.map(a => a.url).join(", ")}`);
    }

    const files = await fs.readdir(componentDir);

    let html = "", css = "", js = "";
    let meta = { assets: [] };

    for (const file of files) {
        const filePath = path.join(componentDir, file);
        const ext = path.extname(file).toLowerCase();
        const content = await fs.readFile(filePath, "utf-8");

        if (ext === ".html") html = content.trim();
        else if (ext === ".css") css = content.trim();
        else if (ext === ".js") js = content.trim();
        else if (file === "webhanger.component.json") meta = JSON.parse(content);
    }

    if (!html && !js) {
        throw new Error("Component must have at least an .html or .js file.");
    }

    // AES-256-GCM encrypt each chunk with per-chunk salt
    const encryptChunk = (content, salt) => encrypt(content, projectId, salt);

    const payload = {
        v: 2,                                    // version 2 = AES encrypted
        h: encryptChunk(html, "::html"),
        c: encryptChunk(css,  "::css"),
        j: encryptChunk(js,   "::js"),
        assets: meta.assets || [],
        dependencies: meta.dependencies || [],
        integrity: integrityHash(html + css + js) // tamper detection
    };

    return JSON.stringify(payload);
}
