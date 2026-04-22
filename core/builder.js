import fs from "fs-extra";
import path from "path";
import crypto from "crypto";

// ─── Minifiers ────────────────────────────────────────────────────────────────

function minifyHtml(html) {
    return html
        .replace(/<!--[\s\S]*?-->/g, "")           // remove comments
        .replace(/\s+/g, " ")                       // collapse whitespace
        .replace(/>\s+</g, "><")                    // remove whitespace between tags
        .replace(/\s+>/g, ">")                      // trim before >
        .replace(/<\s+/g, "<")                      // trim after <
        .trim();
}

function minifyCss(css) {
    return css
        .replace(/\/\*[\s\S]*?\*\//g, "")          // remove comments
        .replace(/\s+/g, " ")                       // collapse whitespace
        .replace(/\s*([{}:;,>~+])\s*/g, "$1")      // remove spaces around operators
        .replace(/;}/g, "}")                        // remove last semicolon
        .trim();
}

function minifyJs(js) {
    return js
        .replace(/\/\*[\s\S]*?\*\//g, "")          // remove block comments only
        .replace(/[ \t]+/g, " ")                    // collapse spaces/tabs (not newlines)
        .replace(/^\s+/gm, "")                      // trim line starts
        .trim();
}

// ─── Hash helper ──────────────────────────────────────────────────────────────

function hashContent(content) {
    return crypto.createHash("md5").update(content).digest("hex").slice(0, 8);
}

// ─── Process a single HTML file ───────────────────────────────────────────────

async function processHtml(filePath, outDir, assetMap) {
    let html = await fs.readFile(filePath, "utf-8");
    const baseName = path.basename(filePath, ".html");

    // ── Extract embedded <style> blocks → separate .css file ─────────────────
    const styleBlocks = [];
    html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
        styleBlocks.push(css.trim());
        return "";
    });

    if (styleBlocks.length) {
        const css = minifyCss(styleBlocks.join("\n"));
        const hash = hashContent(css);
        const cssFile = `${baseName}.${hash}.css`;
        await fs.writeFile(path.join(outDir, cssFile), css, "utf-8");
        // Inject <link> before </head>
        html = html.replace("</head>", `<link rel="stylesheet" href="./${cssFile}"></head>`);
        assetMap[baseName + ".css"] = cssFile;
    }

    // ── Extract embedded <script> blocks (non-src) → separate .js file ───────
    const scriptBlocks = [];
    html = html.replace(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi, (_, js) => {
        const trimmed = js.trim();
        if (trimmed) scriptBlocks.push(trimmed);
        return "";
    });

    if (scriptBlocks.length) {
        const js = minifyJs(scriptBlocks.join("\n"));
        const hash = hashContent(js);
        const jsFile = `${baseName}.${hash}.js`;
        await fs.writeFile(path.join(outDir, jsFile), js, "utf-8");
        // Inject <script> before </body>
        html = html.replace("</body>", `<script src="./${jsFile}"></script></body>`);
        assetMap[baseName + ".js"] = jsFile;
    }

    // ── Inline external local <link> CSS files ────────────────────────────────
    html = await replaceAsync(html, /<link[^>]+href="([^"]+\.css)"[^>]*>/g, async (match, href) => {
        if (href.startsWith("http") || href.startsWith("./") && href.includes(".")) {
            // Already a hashed file we just wrote — keep it
            if (Object.values(assetMap).some(v => href.includes(v))) return match;
        }
        if (href.startsWith("http")) return match;
        const cssPath = path.resolve(path.dirname(filePath), href);
        if (!await fs.pathExists(cssPath)) return match;
        const css = minifyCss(await fs.readFile(cssPath, "utf-8"));
        const hash = hashContent(css);
        const cssFile = path.basename(href, ".css") + "." + hash + ".css";
        await fs.writeFile(path.join(outDir, cssFile), css, "utf-8");
        return match.replace(href, "./" + cssFile);
    });

    // ── Minify HTML ───────────────────────────────────────────────────────────
    html = minifyHtml(html);

    const fileName = path.basename(filePath);
    const outPath = path.join(outDir, fileName);
    await fs.writeFile(outPath, html, "utf-8");

    return {
        fileName,
        size: Buffer.byteLength(html, "utf-8"),
        assets: Object.values(assetMap)
    };
}

// ─── Async replace helper ─────────────────────────────────────────────────────

async function replaceAsync(str, regex, asyncFn) {
    const promises = [];
    str.replace(regex, (match, ...args) => {
        promises.push(asyncFn(match, ...args));
        return match;
    });
    const results = await Promise.all(promises);
    return str.replace(regex, () => results.shift());
}

// ─── Main build function ──────────────────────────────────────────────────────

/**
 * Builds a WebHanger site for production.
 * @param {string} srcDir   - source directory with HTML files
 * @param {string} outDir   - output directory (default: ./dist)
 */
export async function build(srcDir, outDir = "./dist") {
    const absOut = path.resolve(outDir);
    await fs.ensureDir(absOut);
    await fs.emptyDir(absOut);

    const files = await fs.readdir(srcDir);
    const htmlFiles = files.filter(f => f.endsWith(".html"));

    if (!htmlFiles.length) throw new Error(`No HTML files found in ${srcDir}`);

    const results = [];
    const assetMap = {};

    for (const file of htmlFiles) {
        const filePath = path.join(srcDir, file);
        const result = await processHtml(filePath, absOut, assetMap);
        results.push(result);
    }

    // Copy non-HTML assets (images, fonts, etc.) preserving structure
    for (const file of files) {
        if (file.endsWith(".html")) continue;
        const src = path.join(srcDir, file);
        const stat = await fs.stat(src);
        if (stat.isFile()) {
            await fs.copy(src, path.join(absOut, file));
        }
    }

    // Write build manifest
    const manifest = {
        builtAt: new Date().toISOString(),
        srcDir,
        outDir: absOut,
        pages: results
    };
    await fs.writeJson(path.join(absOut, "build-manifest.json"), manifest, { spaces: 2 });

    return { outDir: absOut, pages: results };
}
