import fs from "fs-extra";
import path from "path";

// Known CDN mappings for popular npm packages
const CDN_MAP = {
    // CSS Frameworks
    "tailwindcss":        { type: "script", url: "https://cdn.tailwindcss.com" },
    "bootstrap":          { type: "style",  url: "https://cdn.jsdelivr.net/npm/bootstrap@5/dist/css/bootstrap.min.css" },
    "bootstrap/dist/js/bootstrap.bundle.min.js": { type: "script", url: "https://cdn.jsdelivr.net/npm/bootstrap@5/dist/js/bootstrap.bundle.min.js" },
    "@mui/material":      { type: "style",  url: "https://fonts.googleapis.com/css?family=Roboto:300,400,500,700&display=swap" },
    "bulma":              { type: "style",  url: "https://cdn.jsdelivr.net/npm/bulma@0.9.4/css/bulma.min.css" },
    "animate.css":        { type: "style",  url: "https://cdnjs.cloudflare.com/ajax/libs/animate.css/4.1.1/animate.min.css" },

    // Animation / 3D
    "gsap":               { type: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js" },
    "three":              { type: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js" },
    "animejs":            { type: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/animejs/3.2.1/anime.min.js" },
    "lottie-web":         { type: "script", url: "https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.2/lottie.min.js" },
    "framer-motion":      null, // SSR only, skip

    // Utility
    "alpinejs":           { type: "script", url: "https://unpkg.com/alpinejs@3.x.x/dist/cdn.min.js", defer: true },
    "htmx.org":           { type: "script", url: "https://unpkg.com/htmx.org@1.9.10" },
    "axios":              { type: "script", url: "https://cdn.jsdelivr.net/npm/axios/dist/axios.min.js" },
    "lodash":             { type: "script", url: "https://cdn.jsdelivr.net/npm/lodash@4/lodash.min.js" },
    "dayjs":              { type: "script", url: "https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js" },
    "chart.js":           { type: "script", url: "https://cdn.jsdelivr.net/npm/chart.js" },
    "d3":                 { type: "script", url: "https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js" },
    "swiper":             { type: "style",  url: "https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.css" },

    // Fonts
    "@fontsource":        { type: "style",  url: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" },
};

// Framework detection patterns
const FRAMEWORK_PATTERNS = {
    react:   ["import React", "from 'react'", "from \"react\"", "jsx", ".tsx", ".jsx"],
    vue:     ["defineComponent", "from 'vue'", "from \"vue\"", "<template>", ".vue"],
    svelte:  ["<script>", "<style>", ".svelte", "export let"],
    next:    ["from 'next'", "from \"next\"", "getServerSideProps", "getStaticProps"],
    nuxt:    ["defineNuxtComponent", "useNuxtApp", "from '#app'"],
    astro:   [".astro", "Astro.props"],
    angular: ["@Component", "@NgModule", "from '@angular'"],
};

/**
 * Detects framework from file contents + extensions.
 */
function detectFramework(files, contents) {
    for (const [framework, patterns] of Object.entries(FRAMEWORK_PATTERNS)) {
        for (const pattern of patterns) {
            if (files.some(f => f.includes(pattern.replace(".", "")))) return framework;
            if (contents.some(c => c.includes(pattern))) return framework;
        }
    }
    return "vanilla";
}

/**
 * Scans import statements and package.json to find used npm packages.
 */
function extractImports(contents) {
    const imports = new Set();
    const importRegex = /from\s+['"]([^'"./][^'"]*)['"]/g;
    const requireRegex = /require\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g;

    for (const content of contents) {
        let match;
        while ((match = importRegex.exec(content)) !== null) {
            imports.add(match[1].split("/")[0]); // get root package name
        }
        while ((match = requireRegex.exec(content)) !== null) {
            imports.add(match[1].split("/")[0]);
        }
    }
    return [...imports];
}

/**
 * Detects styling approach from file contents + extensions.
 */
function detectStyling(files, contents) {
    const styling = [];

    if (contents.some(c => c.includes("tailwind") || c.includes("className=\"") || c.includes("class=\""))) {
        if (contents.some(c => c.includes("tw-") || c.includes("bg-") || c.includes("text-") || c.includes("flex "))) {
            styling.push("tailwind");
        }
    }
    if (files.some(f => f.endsWith(".css") || f.endsWith(".scss"))) styling.push("css");
    if (contents.some(c => c.includes("styled-components") || c.includes("css`"))) styling.push("styled-components");
    if (contents.some(c => c.includes("@emotion"))) styling.push("emotion");
    if (contents.some(c => c.includes("module.css") || c.includes(".module."))) styling.push("css-modules");

    return styling.length ? styling : ["css"];
}

/**
 * Maps detected npm packages to CDN URLs.
 */
function resolveCdnAssets(imports, styling) {
    const assets = [];
    const seen = new Set();

    // Add styling CDN assets first
    if (styling.includes("tailwind")) {
        assets.push(CDN_MAP["tailwindcss"]);
        seen.add("tailwindcss");
    }
    if (styling.includes("bootstrap")) {
        assets.push(CDN_MAP["bootstrap"]);
        seen.add("bootstrap");
    }

    // Map imports to CDN
    for (const pkg of imports) {
        if (seen.has(pkg)) continue;
        if (CDN_MAP[pkg] && CDN_MAP[pkg] !== null) {
            assets.push(CDN_MAP[pkg]);
            seen.add(pkg);
        }
    }

    return assets;
}

/**
 * Main analyzer — scans a component directory and returns:
 * { framework, styling, imports, assets, meta }
 */
export async function analyzeComponent(componentDir) {
    const files = await fs.readdir(componentDir);
    const contents = [];

    for (const file of files) {
        if (file === "webhanger.component.json") continue;
        const filePath = path.join(componentDir, file);
        const stat = await fs.stat(filePath);
        if (stat.isFile()) {
            try {
                contents.push(await fs.readFile(filePath, "utf-8"));
            } catch (_) {}
        }
    }

    // Check if project has package.json for deeper dep scanning
    const pkgPath = path.join(process.cwd(), "package.json");
    let projectDeps = [];
    if (await fs.pathExists(pkgPath)) {
        const pkg = await fs.readJson(pkgPath);
        projectDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    }

    const framework = detectFramework(files, contents);
    const styling = detectStyling(files, contents);
    const imports = extractImports(contents);
    const allDeps = [...new Set([...imports, ...projectDeps.filter(d => imports.includes(d))])];
    const assets = resolveCdnAssets(allDeps, styling);

    return { framework, styling, imports: allDeps, assets };
}

/**
 * Auto-generates webhanger.component.json if it doesn't exist.
 * If it exists, merges new assets without overwriting manual ones.
 */
export async function autoGenerateComponentMeta(componentDir) {
    const metaPath = path.join(componentDir, "webhanger.component.json");
    const analysis = await analyzeComponent(componentDir);

    let existing = { assets: [] };
    if (await fs.pathExists(metaPath)) {
        existing = await fs.readJson(metaPath);
    }

    // Merge — don't duplicate URLs
    const existingUrls = new Set(existing.assets.map(a => a.url));
    const newAssets = analysis.assets.filter(a => !existingUrls.has(a.url));
    const merged = { ...existing, assets: [...existing.assets, ...newAssets] };

    await fs.writeJson(metaPath, merged, { spaces: 2 });

    return { analysis, meta: merged };
}
