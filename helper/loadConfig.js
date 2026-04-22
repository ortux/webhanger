import fs from "fs";
import path from "path";

export default function loadConfig(configPath = null) {
    // 1. Explicit path passed in
    // 2. WEBHANGER_CONFIG env var
    // 3. Walk up from cwd until found
    const candidates = [];

    if (configPath) candidates.push(path.resolve(configPath));
    if (process.env.WEBHANGER_CONFIG) candidates.push(path.resolve(process.env.WEBHANGER_CONFIG));

    // Walk up directory tree from cwd
    let dir = process.cwd();
    for (let i = 0; i < 5; i++) {
        candidates.push(path.join(dir, "webhanger.config.json"));
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            const raw = fs.readFileSync(candidate, "utf-8");
            const config = JSON.parse(raw);
            if (!config.projectId || !config.secretKey) {
                throw new Error(`Invalid config at ${candidate}: missing projectId or secretKey.`);
            }
            return config;
        }
    }

    throw new Error("webhanger.config.json not found. Run `wh init` first.");
}
