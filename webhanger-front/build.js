import { minify } from "terser";
import fs from "fs-extra";

const src = await fs.readFile("./browser.js", "utf-8");

const result = await minify(src, {
    compress: {
        dead_code: true,
        drop_console: false,
        passes: 3,
        unsafe: true,
        unsafe_math: true,
        pure_getters: true
    },
    mangle: {
        toplevel: true,       // mangle top-level names
        properties: false     // keep property names (needed for API surface)
    },
    format: {
        comments: false,      // strip all comments
        ascii_only: true      // ensure safe output
    }
});

await fs.writeFile("./browser.min.js", result.code, "utf-8");

const orig = (await fs.stat("./browser.js")).size;
const mini = Buffer.byteLength(result.code);
console.log(`✅ Minified: ${(orig/1024).toFixed(1)}kB → ${(mini/1024).toFixed(1)}kB (${Math.round((1-mini/orig)*100)}% reduction)`);
