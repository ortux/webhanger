import fs from "fs-extra";
import path from "path";

/**
 * Atomizer — splits a single HTML page into section-based WebHanger components.
 * Each component gets the full CSS (encrypted on CDN) + its own HTML.
 * Global JS runs once in the host page after all components mount.
 */
export async function atomize(htmlFile, outputDir) {
    const raw = await fs.readFile(htmlFile, "utf-8");

    // ── Extract global <style> ────────────────────────────────────────────────
    const styleBlocks = [];
    let stripped = raw.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
        styleBlocks.push(css.trim());
        return "";
    });
    const globalCss = styleBlocks.join("\n");

    // ── Extract global <script> blocks ────────────────────────────────────────
    const scriptBlocks = [];
    stripped = stripped.replace(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi, (_, js) => {
        scriptBlocks.push(js.trim());
        return "";
    });
    const globalJs = scriptBlocks.join("\n");

    // ── Extract external CDN assets ───────────────────────────────────────────
    const cdnAssets = [];
    stripped = stripped.replace(/<link[^>]+href="(https?:[^"]+\.css)"[^>]*>/gi, (_, url) => {
        cdnAssets.push({ type: "style", url });
        return "";
    });
    stripped = stripped.replace(/<script[^>]+src="(https?:[^"]+)"[^>]*><\/script>/gi, (_, url) => {
        cdnAssets.push({ type: "script", url });
        return "";
    });

    // ── Extract body ──────────────────────────────────────────────────────────
    const bodyMatch = stripped.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const body = (bodyMatch ? bodyMatch[1] : stripped).trim();

    // ── Split into top-level semantic sections ────────────────────────────────
    const found = [];
    const topLevelRegex = /<(nav|header|section|footer|div)(\s[^>]*?)?>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = topLevelRegex.exec(body)) !== null) {
        const tag   = m[1];
        const attrs = m[2] || "";
        const content = m[3];

        const idMatch    = attrs.match(/id="([^"]+)"/);
        const classMatch = attrs.match(/class="([^\s"]+)/);
        const name = idMatch     ? idMatch[1]
                   : classMatch  ? classMatch[1].replace(/[^a-z0-9]/gi, "-")
                   : `${tag}-${found.length + 1}`;

        found.push({
            name: name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-"),
            tag,
            attrs,
            html: `<${tag}${attrs}>${content}</${tag}>`,
        });
    }

    if (!found.length) {
        found.push({ name: "main", tag: "div", attrs: "", html: body });
    }

    // ── Write component folders ───────────────────────────────────────────────
    await fs.ensureDir(outputDir);
    const components = [];

    for (const section of found) {
        const compDir = path.join(outputDir, section.name);
        await fs.ensureDir(compDir);

        await fs.writeFile(path.join(compDir, "index.html"), section.html.trim(), "utf-8");

        // Full CSS per component — encrypted on CDN, correct rendering guaranteed
        if (globalCss) {
            await fs.writeFile(path.join(compDir, "style.css"), globalCss, "utf-8");
        }

        // No JS per component — global JS runs once in host page after mount
        await fs.writeJson(path.join(compDir, "webhanger.component.json"), {
            assets: cdnAssets,
            dependencies: []
        }, { spaces: 2 });

        components.push({ name: section.name, dir: compDir });
    }

    return { components, cdnAssets, globalJs };
}
