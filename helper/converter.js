import fs from "fs-extra";
import path from "path";

/**
 * Reads html/css/js from a component folder.
 */
async function readComponent(componentDir) {
    const files = await fs.readdir(componentDir);
    let html = "", css = "", js = "";

    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        const content = await fs.readFile(path.join(componentDir, file), "utf-8");
        if (ext === ".html") html = content.trim();
        else if (ext === ".css") css = content.trim();
        else if (ext === ".js") js = content.trim();
    }

    return { html, css, js };
}

// ─── Converters ───────────────────────────────────────────────────────────────

function toReact(name, html, css, js) {
    const componentName = name.charAt(0).toUpperCase() + name.slice(1);
    // Convert class= to className= for JSX
    const jsx = html.replace(/\bclass=/g, "className=");

    return `import React, { useEffect } from 'react';

const styles = \`
${css}
\`;

export default function ${componentName}() {
  useEffect(() => {
    // Injected from original script.js
    ${js || "// no script"}
  }, []);

  return (
    <>
      <style>{\`\${styles}\`}</style>
      <div dangerouslySetInnerHTML={{ __html: \`${jsx.replace(/`/g, "\\`")}\` }} />
    </>
  );
}
`;
}

function toVue(name, html, css, js) {
    return `<template>
  <div v-html="markup" />
</template>

<script setup>
import { onMounted } from 'vue';

const markup = \`${html.replace(/`/g, "\\`")}\`;

onMounted(() => {
  ${js || "// no script"}
});
</script>

<style scoped>
${css}
</style>
`;
}

function toSvelte(name, html, css, js) {
    return `<script>
  import { onMount } from 'svelte';

  onMount(() => {
    ${js || "// no script"}
  });
</script>

${html}

<style>
${css}
</style>
`;
}

function toNext(name, html, css, js) {
    const componentName = name.charAt(0).toUpperCase() + name.slice(1);
    const jsx = html.replace(/\bclass=/g, "className=");

    return `'use client';
import { useEffect } from 'react';

const styles = \`
${css}
\`;

export default function ${componentName}() {
  useEffect(() => {
    ${js || "// no script"}
  }, []);

  return (
    <>
      <style>{\`\${styles}\`}</style>
      <div dangerouslySetInnerHTML={{ __html: \`${jsx.replace(/`/g, "\\`")}\` }} />
    </>
  );
}
`;
}

function toAngular(name, html, css, js) {
    const componentName = name.charAt(0).toUpperCase() + name.slice(1);
    const selector = `wh-${name.toLowerCase()}`;

    return `import { Component, OnInit } from '@angular/core';

@Component({
  selector: '${selector}',
  template: \`${html.replace(/`/g, "\\`")}\`,
  styles: [\`
${css}
  \`]
})
export class ${componentName}Component implements OnInit {
  ngOnInit(): void {
    ${js || "// no script"}
  }
}
`;
}

function toAstro(name, html, css, js) {
    return `---
// ${name} component — converted by WebHanger
${js ? `
// Script logic moved to client-side
` : ""}
---

${html}

<style>
${css}
</style>

${js ? `<script>
${js}
</script>` : ""}
`;
}

// ─── Extension map ────────────────────────────────────────────────────────────

const CONVERTERS = {
    react:   { fn: toReact,   ext: ".jsx" },
    next:    { fn: toNext,    ext: ".jsx" },
    vue:     { fn: toVue,     ext: ".vue" },
    svelte:  { fn: toSvelte,  ext: ".svelte" },
    angular: { fn: toAngular, ext: ".component.ts" },
    astro:   { fn: toAstro,   ext: ".astro" },
};

/**
 * Converts a vanilla html/css/js component to a target framework component.
 *
 * @param {string} componentDir  - source folder with html/css/js
 * @param {string} name          - component name e.g. "navbar"
 * @param {string} target        - "react" | "vue" | "svelte" | "next" | "angular" | "astro"
 * @param {string} outputDir     - where to write the converted file
 */
export async function convert(componentDir, name, target, outputDir = "./converted") {
    const converter = CONVERTERS[target.toLowerCase()];
    if (!converter) {
        throw new Error(`Unknown target: "${target}". Supported: ${Object.keys(CONVERTERS).join(", ")}`);
    }

    const { html, css, js } = await readComponent(componentDir);
    const code = converter.fn(name, html, css, js);
    const fileName = `${name}${converter.ext}`;
    const outPath = path.join(outputDir, fileName);

    await fs.ensureDir(outputDir);
    await fs.writeFile(outPath, code, "utf-8");

    return { outPath, fileName, target, code };
}
