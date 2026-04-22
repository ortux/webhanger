import fs from "fs-extra";
import path from "path";

/**
 * Breakdown Engine
 * Detects a single HTML file with embedded <style> and <script> tags.
 * Extracts them into separate index.html, style.css, script.js files.
 * Works on component folders OR standalone HTML files.
 */
export async function breakdown(componentDir) {
    const files = await fs.readdir(componentDir);
    const htmlFiles = files.filter(f => f.endsWith(".html"));
    const hasCSS = files.some(f => f.endsWith(".css"));
    const hasJS  = files.some(f => f.endsWith(".js") && f !== "webhanger.component.json");

    // Only run if there's exactly one HTML file and no separate css/js yet
    if (htmlFiles.length !== 1 || (hasCSS && hasJS)) return false;

    const htmlPath = path.join(componentDir, htmlFiles[0]);
    const raw = await fs.readFile(htmlPath, "utf-8");

    // Extract all <style> blocks
    const styleMatches = [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
    const css = styleMatches.map(m => m[1].trim()).join("\n\n");

    // Extract all <script> blocks (non-src)
    const scriptMatches = [...raw.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)];
    const js = scriptMatches.map(m => m[1].trim()).join("\n\n");

    // Strip <style> and <script> from HTML, clean up blank lines
    let html = raw
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<script(?![^>]*src)[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    // Strip outer <html><head><body> wrapper if present — keep inner content only
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) html = bodyMatch[1].trim();

    const changed = css || js;
    if (!changed) return false;

    // Write extracted files
    await fs.writeFile(path.join(componentDir, "index.html"), html, "utf-8");
    if (css) await fs.writeFile(path.join(componentDir, "style.css"), css, "utf-8");
    if (js)  await fs.writeFile(path.join(componentDir, "script.js"), js, "utf-8");

    // Rename original if it wasn't index.html
    if (htmlFiles[0] !== "index.html") {
        await fs.remove(htmlPath);
    }

    return {
        extracted: {
            html: !!html,
            css: !!css,
            js: !!js
        },
        cssLines: css.split("\n").length,
        jsLines:  js.split("\n").length
    };
}
