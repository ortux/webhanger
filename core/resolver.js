import { getComponent } from "../helper/dbHandler.js";

/**
 * Resolves a full dependency graph for a component.
 * Returns a flat ordered array of components to load — deps first, then the component.
 * Detects circular dependencies and throws.
 *
 * @param {object} dbConfig
 * @param {string} projectId
 * @param {string} name
 * @param {string} version
 * @returns {Array<{name, version, cdnUrl, token, expires}>}
 */
export async function resolve(dbConfig, projectId, name, version) {
    const visited = new Set();
    const order = [];

    async function walk(n, v, chain = []) {
        const key = `${n}@${v}`;

        // Circular dependency check
        if (chain.includes(key)) {
            throw new Error(`Circular dependency detected: ${[...chain, key].join(" → ")}`);
        }

        // Already resolved
        if (visited.has(key)) return;
        visited.add(key);

        const meta = await getComponent(dbConfig, projectId, n, v);
        if (!meta) throw new Error(`Component ${key} not found in registry.`);

        // Walk dependencies first (depth-first)
        if (meta.dependencies && meta.dependencies.length) {
            for (const dep of meta.dependencies) {
                const [depName, depVersion] = parseDep(dep);
                await walk(depName, depVersion, [...chain, key]);
            }
        }

        order.push({
            name: n,
            version: v,
            cdnUrl: meta.cdnUrl,
            token: meta.token,
            expires: meta.expires,
            assets: meta.assets || []
        });
    }

    await walk(name, version);
    return order;
}

/**
 * Parses "navbar@1.2.0" → ["navbar", "1.2.0"]
 * Parses "navbar" → ["navbar", "latest"]
 */
export function parseDep(dep) {
    const atIndex = dep.lastIndexOf("@");
    if (atIndex <= 0) return [dep, "latest"];
    return [dep.slice(0, atIndex), dep.slice(atIndex + 1)];
}
