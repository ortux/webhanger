#!/usr/bin/env node
import inquirer from "inquirer";
import fs from "fs-extra";
import chalk from "chalk";
import path from "path";
import { generateSecretKey } from "../helper/signer.js";
import { deploy } from "../core/registry.js";
import loadConfig from "../helper/loadConfig.js";
import { provisionBucket, provisionCloudFront } from "../helper/awsProvisioner.js";

const args = process.argv.slice(2);
const command = args[0];

const BANNER = `
 ██╗    ██╗███████╗██████╗ ██╗  ██╗ █████╗ ███╗   ██╗ ██████╗ ███████╗██████╗ 
 ██║    ██║██╔════╝██╔══██╗██║  ██║██╔══██╗████╗  ██║██╔════╝ ██╔════╝██╔══██╗
 ██║ █╗ ██║█████╗  ██████╔╝███████║███████║██╔██╗ ██║██║  ███╗█████╗  ██████╔╝
 ██║███╗██║██╔══╝  ██╔══██╗██╔══██║██╔══██║██║╚██╗██║██║   ██║██╔══╝  ██╔══██╗
 ╚███╔███╔╝███████╗██████╔╝██║  ██║██║  ██║██║ ╚████║╚██████╔╝███████╗██║  ██║
  ╚══╝╚══╝ ╚══════╝╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝
`;

async function init() {
    console.log(chalk.cyan(BANNER));

    console.log(chalk.bold.white("\n📦 Storage Providers:"));
    console.log(chalk.gray("  r2     — Cloudflare R2 (zero egress fees, global edge)"));
    console.log(chalk.gray("  s3     — AWS S3 (industry standard, global regions)"));
    console.log(chalk.gray("  minio  — Self-hosted MinIO (full control, S3-compatible)"));
    console.log(chalk.gray("  local  — Local disk (dev/testing only, no CDN)\n"));

    console.log(chalk.bold.white("🗄️  Database Providers:"));
    console.log(chalk.gray("  firebase   — Firebase Firestore (free tier, real-time, globally distributed)"));
    console.log(chalk.gray("  supabase   — Supabase Postgres (open source, free tier, REST + realtime)"));
    console.log(chalk.gray("  mongodb    — MongoDB Atlas (flexible documents, free tier)\n"));

    const answers = await inquirer.prompt([
        {
            type: "input",
            name: "projectName",
            message: "Project name:",
            default: "my-webhanger-app"
        },

        // ── STORAGE ──────────────────────────────────────────────────────────
        {
            type: "list",
            name: "storageProvider",
            message: "Select storage provider:",
            choices: [
                { name: "r2     — Cloudflare R2", value: "r2" },
                { name: "s3     — AWS S3", value: "s3" },
                { name: "minio  — Self-hosted MinIO", value: "minio" },
                { name: "local  — Local disk (dev only)", value: "local" }
            ]
        },
        {
            type: "input",
            name: "localPath",
            message: "Local storage path:",
            default: "./storage",
            when: (a) => a.storageProvider === "local"
        },
        {
            type: "input",
            name: "endpoint",
            message: "Endpoint URL (e.g. https://<id>.r2.cloudflarestorage.com or http://localhost:9000):",
            when: (a) => a.storageProvider === "r2" || a.storageProvider === "minio"
        },
        {
            type: "input",
            name: "accessKey",
            message: "Storage Access Key:",
            when: (a) => a.storageProvider !== "local"
        },
        {
            type: "password",
            name: "storageSecret",
            message: "Storage Secret Key:",
            when: (a) => a.storageProvider !== "local"
        },
        {
            type: "input",
            name: "bucket",
            message: "Bucket name:",
            when: (a) => a.storageProvider !== "local"
        },
        {
            type: "input",
            name: "region",
            message: "Region (e.g. us-east-1):",
            default: "us-east-1",
            when: (a) => a.storageProvider === "s3"
        },

        // ── CDN ───────────────────────────────────────────────────────────────
        {
            type: "input",
            name: "cdnBase",
            message: "CDN base URL (your edge URL pointing to storage):",
            when: (a) => a.storageProvider !== "local" && a.storageProvider !== "s3"
        },

        // ── DATABASE ──────────────────────────────────────────────────────────
        {
            type: "list",
            name: "dbProvider",
            message: "Select database provider:",
            choices: [
                { name: "firebase  — Firebase Firestore", value: "firebase" },
                { name: "supabase  — Supabase Postgres", value: "supabase" },
                { name: "mongodb   — MongoDB Atlas", value: "mongodb" }
            ]
        },

        // Firebase
        {
            type: "input",
            name: "firebaseServiceAccount",
            message: "Path to Firebase service account JSON:",
            default: "./firebase-service-account.json",
            when: (a) => a.dbProvider === "firebase"
        },

        // Supabase
        {
            type: "input",
            name: "supabaseUrl",
            message: "Supabase project URL (https://xxx.supabase.co):",
            when: (a) => a.dbProvider === "supabase"
        },
        {
            type: "password",
            name: "supabaseKey",
            message: "Supabase service role key:",
            when: (a) => a.dbProvider === "supabase"
        },

        // MongoDB
        {
            type: "input",
            name: "mongoUri",
            message: "MongoDB connection URI:",
            when: (a) => a.dbProvider === "mongodb"
        }
    ]);

    const projectId = `wh_${Date.now()}`;
    const secretKey = generateSecretKey();

    // Auto-provision S3 bucket + CloudFront
    let cdnUrl = answers.storageProvider === "local" ? "http://localhost" : answers.cdnBase?.replace(/\/$/, "");
    let distributionId = null;
    const bucketName = answers.bucket || `webhanger-${projectId}`;

    if (answers.storageProvider === "s3") {
        console.log(chalk.cyan("\n⚙️  Provisioning AWS infrastructure..."));
        try {
            await provisionBucket(answers.accessKey, answers.storageSecret, answers.region, bucketName);
            const cf = await provisionCloudFront(answers.accessKey, answers.storageSecret, bucketName, answers.region);
            cdnUrl = cf.cdnUrl;
            distributionId = cf.distributionId;
        } catch (err) {
            console.log(chalk.red(`\n❌ AWS provisioning failed: ${err.message}`));
            console.log(chalk.yellow("Check your IAM permissions (S3FullAccess + CloudFrontFullAccess required)."));
            process.exit(1);
        }
    }

    // Build DB config based on provider
    const dbConfig = answers.dbProvider === "firebase"
        ? { provider: "firebase", serviceAccountPath: answers.firebaseServiceAccount }
        : answers.dbProvider === "supabase"
        ? { provider: "supabase", url: answers.supabaseUrl, key: answers.supabaseKey }
        : { provider: "mongodb", uri: answers.mongoUri };

    const config = {
        project: answers.projectName,
        projectId,
        secretKey,
        webHangerVersion: "1.0.0",
        storage: {
            provider: answers.storageProvider,
            ...(answers.storageProvider === "local"
                ? { localPath: answers.localPath }
                : {
                    accessKey: answers.accessKey,
                    secretKey: answers.storageSecret,
                    bucket: bucketName,
                    region: answers.region || "auto",
                    ...(answers.endpoint ? { endpoint: answers.endpoint } : {}),
                    ...(distributionId ? { distributionId } : {})
                })
        },
        cdn: { url: cdnUrl },
        db: dbConfig
    };

    await fs.writeJson("./webhanger.config.json", config, { spaces: 2 });
    console.log(chalk.green("\n✅ webhanger.config.json created."));
    console.log(chalk.yellow(`🔑 Project ID: ${projectId}`));
    console.log(chalk.gray("Keep your secretKey safe — it signs all your component URLs.\n"));

    // ── Optional: Edge Worker setup ───────────────────────────────────────────
    const { useEdge } = await inquirer.prompt([{
        type: "confirm",
        name: "useEdge",
        message: "Setup Cloudflare Edge Worker for token validation + geo routing? (optional, recommended for production):",
        default: false
    }]);

    if (useEdge) {
        const { workerName } = await inquirer.prompt([{
            type: "input",
            name: "workerName",
            message: "Cloudflare Worker name:",
            default: `webhanger-edge-${answers.projectName.toLowerCase().replace(/\s+/g, "-")}`
        }]);

        // Write edge/worker.js
        await fs.ensureDir("./edge");
        const workerSrc = await fs.readFile(new URL("../edge/worker.js", import.meta.url), "utf-8").catch(() => null);
        if (workerSrc) await fs.writeFile("./edge/worker.js", workerSrc, "utf-8");

        // Write wrangler.toml
        const wranglerToml = `name = "${workerName}"
main = "worker.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "WH_SECRETS"
id = "REPLACE_WITH_YOUR_KV_ID"

[[kv_namespaces]]
binding = "WH_VERSIONS"
id = "REPLACE_WITH_YOUR_KV_ID_2"

[vars]
ORIGIN_DEFAULT = "${cdnUrl}"
ORIGIN_AP      = "${cdnUrl}"
ORIGIN_EU      = "${cdnUrl}"
`;
        await fs.writeFile("./edge/wrangler.toml", wranglerToml, "utf-8");

        console.log(chalk.green("\n✅ Edge worker files created in ./edge/"));
        console.log(chalk.white("\nNext steps to activate edge delivery:"));
        console.log(chalk.gray("  1. Install wrangler:  npm install -g wrangler"));
        console.log(chalk.gray("  2. Login:             wrangler login"));
        console.log(chalk.gray("  3. Create KV stores:  wrangler kv:namespace create WH_SECRETS"));
        console.log(chalk.gray("                        wrangler kv:namespace create WH_VERSIONS"));
        console.log(chalk.gray("  4. Update KV IDs in   ./edge/wrangler.toml"));
        console.log(chalk.gray(`  5. Push secret:       wrangler kv:key put --binding=WH_SECRETS "secret:${projectId}" "${secretKey}"`));
        console.log(chalk.gray("  6. Deploy worker:     cd edge && wrangler deploy"));
        console.log(chalk.gray("  7. Update cdn.url in  webhanger.config.json to your worker URL"));
        console.log(chalk.yellow("\n⚡ Once deployed, all component requests are validated at the edge.\n"));
    }
}

async function deployCommand() {
    const [, , , componentDir, name, version] = process.argv;

    if (!componentDir || !name || !version) {
        console.log(chalk.red("Usage: wh deploy <component-dir> <name> <version>"));
        console.log(chalk.gray("Example: wh deploy ./components/navbar navbar 1.0.0"));
        process.exit(1);
    }

    const config = loadConfig();

    // Ask user about token + expiry
    const options = await inquirer.prompt([
        {
            type: "confirm",
            name: "useCustomToken",
            message: "Set a custom token? (No = auto-generate):",
            default: false
        },
        {
            type: "input",
            name: "customToken",
            message: "Enter your custom token:",
            when: (a) => a.useCustomToken
        },
        {
            type: "confirm",
            name: "setExpiry",
            message: "Set an expiry for this component token?",
            default: false
        },
        {
            type: "input",
            name: "expirySeconds",
            message: "Expiry in seconds (e.g. 3600 = 1hr, 86400 = 1day, 2592000 = 30days):",
            when: (a) => a.setExpiry,
            validate: (v) => !isNaN(parseInt(v)) || "Please enter a valid number"
        }
    ]);

    const expiresInSeconds = options.setExpiry ? parseInt(options.expirySeconds) : null;
    const customToken = options.useCustomToken ? options.customToken : null;

    console.log(chalk.cyan(`\n🚀 Deploying ${name}@${version}...`));

    try {
        const result = await deploy(config, componentDir, name, version, [], expiresInSeconds, customToken);
        console.log(chalk.green(`\n✅ Deployed successfully!`));
        console.log(chalk.white(`📦 CDN URL : ${result.cdnUrl}`));
        console.log(chalk.white(`🔐 Token   : ${result.token}`));
        if (result.expires === 0) {
            console.log(chalk.gray(`⏱  Expires : never`));
        } else {
            console.log(chalk.white(`⏱  Expires : ${result.expires}`));
            console.log(chalk.gray(`            (${new Date(result.expires * 1000).toISOString()})`));
        }
    } catch (err) {
        console.log(chalk.red(`\n❌ Deploy failed: ${err.message}`));
        process.exit(1);
    }
}

// Router
switch (command) {
    case "init":
        init();
        break;
    case "deploy":
        deployCommand();
        break;
    case "edge-init": {
        // Pushes projectId + secretKey to Cloudflare KV so the worker can validate tokens
        const loadConfigFn = (await import("../helper/loadConfig.js")).default;
        const config = loadConfigFn();
        const { projectId, secretKey } = config;

        console.log(chalk.cyan("\n⚡ Initializing edge worker...\n"));
        console.log(chalk.white("Run these commands to push your secrets to Cloudflare KV:\n"));
        console.log(chalk.gray(`  wrangler kv:key put --binding=WH_SECRETS "secret:${projectId}" "${secretKey}"`));
        console.log(chalk.gray(`\nFor each deployed component, register its version:`));
        console.log(chalk.gray(`  wrangler kv:key put --binding=WH_VERSIONS "version:navbar" "1.0.0"`));
        console.log(chalk.yellow(`\n📁 Edge worker source: edge/worker.js`));
        console.log(chalk.yellow(`📁 Wrangler config:    edge/wrangler.toml`));
        console.log(chalk.white(`\nDeploy the worker:`));
        console.log(chalk.gray(`  cd edge && wrangler deploy`));
        console.log(chalk.white(`\nThen update your CDN URL in webhanger.config.json to point to the worker:`));
        console.log(chalk.gray(`  "cdn": { "url": "https://webhanger-edge.your-subdomain.workers.dev" }`));
        break;
    }
    case "atomize": {
        const atomFile = args[1];
        const atomOut  = args[2] || "./atomized";
        const atomVer  = args[3] || "1.0.0";

        if (!atomFile) {
            console.log(chalk.red("Usage: wh atomize <html-file> [components-dir] [version]"));
            console.log(chalk.gray("Example: wh atomize ./docs/index.html ./atomized 1.0.0"));
            process.exit(1);
        }

        const { atomize } = await import("../core/atomizer.js");
        const { deploy: registryDeploy } = await import("../core/registry.js");
        const { default: fsExtra } = await import("fs-extra");
        const { default: pathMod } = await import("path");
        const loadConfigFn = (await import("../helper/loadConfig.js")).default;
        const config = loadConfigFn();
        const { projectId } = config;

        console.log(chalk.cyan(`\n⚛️  Atomizing ${atomFile}...\n`));

        // Step 1: Split into components
        const { components, cdnAssets, globalJs } = await atomize(atomFile, atomOut);
        console.log(chalk.green(`  ✅ Split into ${components.length} components:`));
        components.forEach(c => console.log(chalk.gray(`    → ${c.name}`)));

        // Step 2: Deploy each component
        console.log(chalk.cyan(`\n🚀 Deploying components...\n`));
        const deployed = {};
        for (const comp of components) {
            process.stdout.write(`  ${comp.name}@${atomVer}... `);
            try {
                deployed[comp.name] = await registryDeploy(config, comp.dir, comp.name, atomVer);
                console.log(chalk.green("✅"));
            } catch (err) {
                console.log(chalk.red(`❌ ${err.message}`));
            }
        }

        // Step 3: Write manifest
        const manifest = {
            pid: projectId,
            components: Object.fromEntries(
                Object.entries(deployed).map(([name, d]) => [
                    name, { url: d.cdnUrl, urls: d.cdnUrls || [d.cdnUrl], token: d.token, expires: d.expires }
                ])
            )
        };
        const manifestPath = pathMod.join(pathMod.dirname(atomFile), "wh-manifest.json");
        await fsExtra.writeJson(manifestPath, manifest, { spaces: 2 });

        // Step 4: Write globalJs to separate file
        const globalJsFile = pathMod.join(pathMod.dirname(atomFile), "wh-global.js");
        if (globalJs) await fsExtra.writeFile(globalJsFile, globalJs, "utf-8");

        // Step 5: Generate production-ready CDN-powered HTML
        const mounts = components.map(c => `  <wh-component name="${c.name}"></wh-component>`).join("\n");
        const outHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WebHanger</title>
  ${cdnAssets.filter(a => a.type === "style").map(a => `<link rel="stylesheet" href="${a.url}">`).join("\n  ")}
  <script src="https://unpkg.com/webhanger-front@latest/browser.min.js"></script>
</head>
<body>
${mounts}
  ${cdnAssets.filter(a => a.type === "script").map(a => `<script src="${a.url}"></script>`).join("\n  ")}
  <script>
    var totalComponents = document.querySelectorAll("wh-component").length;
    var mountedCount = 0;
    WebHangerFront.on("afterMount", function() {
      mountedCount++;
      if (mountedCount >= totalComponents && !window.__whGlobalRan) {
        window.__whGlobalRan = true;
        ${globalJs ? `var s = document.createElement("script"); s.src = "./wh-global.js"; document.body.appendChild(s);` : ""}
      }
    });
    WebHangerFront.initialize("./wh-manifest.json");
  </script>
  ${globalJs ? "" : ""}
</body>
</html>`;

        const outHtmlPath = pathMod.join(pathMod.dirname(atomFile), "atomized.html");
        await fsExtra.writeFile(outHtmlPath, outHtml, "utf-8");

        console.log(chalk.green(`\n✅ Atomize complete!`));
        console.log(chalk.white(`  Components : ${components.length}`));
        console.log(chalk.white(`  Manifest   : ${manifestPath}`));
        console.log(chalk.white(`  Output     : ${outHtmlPath}`));
        if (globalJs) console.log(chalk.white(`  Global JS  : ${globalJsFile}`));
        console.log(chalk.gray(`\n  Open atomized.html — entire page loads from CDN.\n`));
        break;
    }
    case "breakdown": {
        const bdDir = args[1];
        if (!bdDir) {
            console.log(chalk.red("Usage: wh breakdown <component-dir>"));
            process.exit(1);
        }
        const { breakdown: runBreakdown } = await import("../helper/breakdown.js");
        console.log(chalk.cyan(`\n🔧 Breaking down ${bdDir}...\n`));
        const result = await runBreakdown(bdDir);
        if (!result) {
            console.log(chalk.gray("  Nothing to break down — files already separated or no embedded styles/scripts found."));
        } else {
            console.log(chalk.green("  ✅ Breakdown complete!"));
            if (result.extracted.html) console.log(chalk.gray("  → index.html"));
            if (result.extracted.css)  console.log(chalk.gray(`  → style.css  (${result.cssLines} lines)`));
            if (result.extracted.js)   console.log(chalk.gray(`  → script.js  (${result.jsLines} lines)`));
        }
        break;
    }
    case "access": {
        const subCmd = args[1]; // grant | revoke | list
        const loadConfigFn = (await import("../helper/loadConfig.js")).default;
        const { grantAccess, revokeAccess, listAccess, generateApiKey } = await import("../helper/accessControl.js");
        const config = loadConfigFn();
        const { projectId, db } = config;

        if (subCmd === "grant") {
            const { default: inquirerLocal } = await import("inquirer");
            const ans = await inquirerLocal.prompt([
                {
                    type: "list",
                    name: "role",
                    message: "Select role:",
                    choices: [
                        { name: "owner    — full access", value: "owner" },
                        { name: "admin    — deploy + delete + manage", value: "admin" },
                        { name: "deployer — deploy + read only", value: "deployer" },
                        { name: "viewer   — read only", value: "viewer" }
                    ]
                },
                { type: "input", name: "label", message: "Label (e.g. CI/CD, teammate name):", default: "" }
            ]);
            const apiKey = generateApiKey();
            const result = await grantAccess(db, projectId, apiKey, ans.role, ans.label);
            console.log(chalk.green(`\n✅ Access granted`));
            console.log(chalk.white(`  API Key     : ${result.apiKey}`));
            console.log(chalk.white(`  Role        : ${result.role}`));
            console.log(chalk.white(`  Permissions : ${result.permissions.join(", ")}`));
            console.log(chalk.yellow(`\n  Store this key safely — it won't be shown again.\n`));

        } else if (subCmd === "revoke") {
            const apiKey = args[2];
            if (!apiKey) { console.log(chalk.red("Usage: wh access revoke <api-key>")); process.exit(1); }
            await revokeAccess(db, projectId, apiKey);
            console.log(chalk.green(`✅ Access revoked for ${apiKey}`));

        } else if (subCmd === "list") {
            const entries = await listAccess(db, projectId);
            if (!entries.length) { console.log(chalk.gray("No access entries found.")); break; }
            console.log(chalk.cyan(`\n🔑 Access entries for project ${projectId}:\n`));
            entries.forEach(e => {
                console.log(chalk.white(`  ${e.apiKey.slice(0, 20)}...`));
                console.log(chalk.gray(`    Role: ${e.role} | Permissions: ${e.permissions.join(", ")} | Label: ${e.label || "-"}`));
            });
            console.log();

        } else {
            console.log(chalk.white("Usage:"));
            console.log(chalk.gray("  wh access grant          — generate a new API key with a role"));
            console.log(chalk.gray("  wh access revoke <key>   — revoke an API key"));
            console.log(chalk.gray("  wh access list           — list all access entries"));
        }
        break;
    }
    case "ship": {
        const shipCompDir = args[1];
        const shipSiteDir = args[2];
        const shipVersion = args[3] || "1.0.0";
        const shipOut     = args[4] || "./dist";

        if (!shipCompDir || !shipSiteDir) {
            console.log(chalk.red("Usage: wh ship <components-dir> <site-dir> [version] [out-dir]"));
            console.log(chalk.gray("Example: wh ship ./components ./docs 1.0.0 ./dist"));
            process.exit(1);
        }

        const { default: fsExtra } = await import("fs-extra");
        const { default: pathMod } = await import("path");
        const { deploy: registryDeploy } = await import("../core/registry.js");
        const { resolve: resolveGraph } = await import("../core/resolver.js");
        const { build } = await import("../core/builder.js");
        const loadConfigFn = (await import("../helper/loadConfig.js")).default;
        const { default: archiver } = await import("archiver");
        const { default: fsSync } = await import("fs");

        const config = loadConfigFn();
        const { projectId, db } = config;

        // ── Step 1: Deploy all components ─────────────────────────────────────
        console.log(chalk.cyan(`\n🚀 [1/4] Deploying components from ${shipCompDir}...\n`));

        const entries = await fsExtra.readdir(shipCompDir);
        const compDirs = [];
        for (const entry of entries) {
            const full = pathMod.resolve(shipCompDir, entry);
            const stat = await fsExtra.stat(full);
            if (stat.isDirectory()) compDirs.push({ name: entry, dir: full });
        }

        if (!compDirs.length) {
            console.log(chalk.red(`No component folders found in ${shipCompDir}`));
            process.exit(1);
        }

        const deployed = {};
        for (const comp of compDirs) {
            process.stdout.write(`  ${comp.name}@${shipVersion}... `);
            try {
                deployed[comp.name] = await registryDeploy(config, comp.dir, comp.name, shipVersion);
                console.log(chalk.green("✅"));
            } catch (err) {
                console.log(chalk.red(`❌ ${err.message}`));
            }
        }

        // ── Step 2: Resolve dependency graph ──────────────────────────────────
        console.log(chalk.cyan(`\n🔍 [2/4] Resolving dependency graph...\n`));

        const allDeps = new Set();
        for (const comp of compDirs) {
            const metaPath = pathMod.join(comp.dir, "webhanger.component.json");
            if (await fsExtra.pathExists(metaPath)) {
                const meta = await fsExtra.readJson(metaPath);
                (meta.dependencies || []).forEach(d => allDeps.add(d.split("@")[0]));
            }
        }
        const roots = compDirs.filter(c => !allDeps.has(c.name));
        console.log(chalk.gray(`  Root components: ${roots.map(r => r.name).join(", ")}`));

        // Write wh-manifest.json into site dir
        const manifest = {
            pid: projectId,
            components: Object.fromEntries(
                Object.entries(deployed).map(([name, d]) => [
                    name, { url: d.cdnUrl, urls: d.cdnUrls || [d.cdnUrl], token: d.token, expires: d.expires }
                ])
            )
        };
        await fsExtra.ensureDir(shipSiteDir);
        await fsExtra.writeJson(pathMod.join(shipSiteDir, "wh-manifest.json"), manifest, { spaces: 2 });
        console.log(chalk.gray(`  wh-manifest.json written to ${shipSiteDir}`));

        // ── Step 3: Production build ───────────────────────────────────────────
        console.log(chalk.cyan(`\n🏗️  [3/4] Building ${shipSiteDir} → ${shipOut}...\n`));

        try {
            const buildResult = await build(shipSiteDir, shipOut);
            // Copy manifest to dist too
            await fsExtra.copy(
                pathMod.join(shipSiteDir, "wh-manifest.json"),
                pathMod.join(shipOut, "wh-manifest.json")
            );
            buildResult.pages.forEach(p => {
                const kb = (p.size / 1024).toFixed(1);
                console.log(chalk.gray(`  ${p.fileName.padEnd(25)} ${kb} kB`));
                (p.assets || []).forEach(a => console.log(chalk.gray(`    ↳ ${a}`)));
            });
        } catch (err) {
            console.log(chalk.yellow(`  Build warning: ${err.message}`));
        }

        // ── Step 4: Zip ───────────────────────────────────────────────────────
        console.log(chalk.cyan(`\n📦 [4/4] Zipping ${shipOut}...\n`));

        const zipPath = pathMod.join(pathMod.dirname(shipOut), "deploy.zip");
        await new Promise((resolve, reject) => {
            const output = fsSync.createWriteStream(zipPath);
            const archive = archiver("zip", { zlib: { level: 9 } });
            output.on("close", resolve);
            archive.on("error", reject);
            archive.pipe(output);
            archive.directory(shipOut, false);
            archive.finalize();
        });

        const zipSize = ((await fsExtra.stat(zipPath)).size / 1024).toFixed(1);

        console.log(chalk.green(`\n✅ Ship complete!\n`));
        console.log(chalk.white(`  Components deployed : ${compDirs.length}`));
        console.log(chalk.white(`  Output              : ${shipOut}`));
        console.log(chalk.white(`  Deploy zip          : ${zipPath} (${zipSize} kB)`));
        console.log(chalk.gray(`\n  Upload deploy.zip to Netlify, S3, or any static host.\n`));
        break;
    }
    case "graph-deploy": {
        const graphDir = args[1];
        const graphVersion = args[2] || "1.0.0";
        const graphOut = args[3] || "./graph-output";

        if (!graphDir) {
            console.log(chalk.red("Usage: wh graph-deploy <components-dir> [version] [output-dir]"));
            console.log(chalk.gray("Example: wh graph-deploy ./components 1.0.0 ./output"));
            process.exit(1);
        }

        const { default: fsExtra } = await import("fs-extra");
        const { default: pathMod } = await import("path");
        const { deploy: registryDeploy } = await import("../core/registry.js");
        const { resolve: resolveGraph } = await import("../core/resolver.js");
        const loadConfigFn = (await import("../helper/loadConfig.js")).default;

        const config = loadConfigFn();
        const { projectId, db } = config;

        // Scan all component folders
        const entries = await fsExtra.readdir(graphDir);
        const compDirs = [];
        for (const entry of entries) {
            const full = pathMod.join(graphDir, entry);
            const stat = await fsExtra.stat(full);
            if (stat.isDirectory()) compDirs.push({ name: entry, dir: full });
        }

        if (!compDirs.length) {
            console.log(chalk.red(`No component folders found in ${graphDir}`));
            process.exit(1);
        }

        console.log(chalk.cyan(`\n🚀 Graph deploying ${compDirs.length} components...\n`));

        // Deploy all components
        const deployed = {};
        for (const comp of compDirs) {
            process.stdout.write(`  ${comp.name}@${graphVersion}... `);
            try {
                deployed[comp.name] = await registryDeploy(config, comp.dir, comp.name, graphVersion);
                console.log(chalk.green("✅"));
            } catch (err) {
                console.log(chalk.red(`❌ ${err.message}`));
            }
        }

        // Find root component (one that is depended on by none, or named "dashboard"/"app"/"root")
        const allDeps = new Set();
        for (const comp of compDirs) {
            const metaPath = pathMod.join(comp.dir, "webhanger.component.json");
            if (await fsExtra.pathExists(metaPath)) {
                const meta = await fsExtra.readJson(metaPath);
                (meta.dependencies || []).forEach(d => allDeps.add(d.split("@")[0]));
            }
        }
        const roots = compDirs.filter(c => !allDeps.has(c.name));
        const rootName = roots[0]?.name || compDirs[compDirs.length - 1].name;

        console.log(chalk.cyan(`\n🔍 Resolving graph from root: ${rootName}@${graphVersion}\n`));

        let graph;
        try {
            graph = await resolveGraph(db, projectId, rootName, graphVersion);
        } catch (err) {
            console.log(chalk.red(`❌ Graph resolution failed: ${err.message}`));
            process.exit(1);
        }

        console.log(chalk.white("Load order:"));
        graph.forEach((c, i) => console.log(chalk.gray(`  ${i + 1}. ${c.name}@${c.version}`)));

        // Generate manifest + HTML
        await fsExtra.ensureDir(graphOut);
        const selectors = graph.reduce((acc, c) => {
            acc[c.name] = `[data-wh-${c.name}]`;
            return acc;
        }, {});

        // Write wh-manifest.json — sensitive data stays out of HTML
        const manifest = {
            pid: projectId,
            components: graph.reduce((acc, c) => {
                acc[c.name] = { url: c.cdnUrl, token: c.token, expires: c.expires };
                return acc;
            }, {})
        };
        await fsExtra.writeJson(pathMod.join(graphOut, "wh-manifest.json"), manifest, { spaces: 2 });

        const mounts = graph.map(c => `  <div data-wh-${c.name}></div>`).join("\n");

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WebHanger — ${rootName}</title>
  <style>* { margin:0; padding:0; box-sizing:border-box; } body { background:#030712; }</style>
</head>
<body>
${mounts}

  <script src="https://unpkg.com/webhanger-front@latest/browser.min.js"></script>
  <script>
    const selectors = ${JSON.stringify(selectors, null, 2)};
    const rootName = "${rootName}";

    async function loadGraph() {
      const res = await fetch("./wh-manifest.json");
      const m = await res.json();
      await WebHangerFront.clearCache();

      // Inject root first so nested mount points exist in DOM
      const root = m.components[rootName];
      if (root) await WebHangerFront.load(root.url, m.pid, root.token, root.expires, selectors[rootName]);

      // Then inject deps into their mount points
      for (const [name, comp] of Object.entries(m.components)) {
        if (name === rootName) continue;
        const sel = selectors[name];
        if (sel) await WebHangerFront.load(comp.url, m.pid, comp.token, comp.expires, sel);
      }
    }

    loadGraph();
  </script>
</body>
</html>`;

        const outFile = pathMod.join(graphOut, "index.html");
        await fsExtra.writeFile(outFile, html, "utf-8");

        console.log(chalk.green(`\n✅ Done! Output: ${outFile}`));
        break;
    }
    case "zip": {
        const srcDir = args[1] || "./dist";
        const outFile = args[2] || "./deploy.zip";
        const { default: archiver } = await import("archiver");
        const { default: fsSync } = await import("fs");

        console.log(chalk.cyan(`\n📦 Zipping ${srcDir} → ${outFile}...`));

        try {
            await new Promise((resolve, reject) => {
                const output = fsSync.createWriteStream(outFile);
                const archive = archiver("zip", { zlib: { level: 9 } });
                output.on("close", resolve);
                archive.on("error", reject);
                archive.pipe(output);
                archive.directory(srcDir, false); // false = no parent folder in zip
                archive.finalize();
            });

            const { default: fsExtra } = await import("fs-extra");
            const size = ((await fsExtra.stat(outFile)).size / 1024).toFixed(1);
            console.log(chalk.green(`\n✅ ${outFile} created (${size} kB)`));
            console.log(chalk.gray("   Upload and unzip to any static host to deploy."));
        } catch (err) {
            console.log(chalk.red(`\n❌ Zip failed: ${err.message}`));
            process.exit(1);
        }
        break;
    }
    case "build": {
        const srcDir = args[1] || ".";
        const outDir = args[2] || "./dist";
        const { build } = await import("../core/builder.js");
        console.log(chalk.cyan(`\n🏗️  Building ${srcDir} → ${outDir}...\n`));
        try {
            const result = await build(srcDir, outDir);
            console.log(chalk.green(`✅ Build complete!\n`));
            result.pages.forEach(p => {
                const kb = (p.size / 1024).toFixed(1);
                console.log(chalk.white(`  ${p.fileName.padEnd(25)} ${kb} kB`));
                (p.assets || []).forEach(a => console.log(chalk.gray(`    ↳ ${a}`)));
            });
            console.log(chalk.gray(`\n  Output: ${result.outDir}`));
        } catch (err) {
            console.log(chalk.red(`\n❌ Build failed: ${err.message}`));
            process.exit(1);
        }
        break;
    }
    case "convert": {
        const [,,,convertDir, convertName, convertTarget, convertOut] = process.argv;
        if (!convertDir || !convertName || !convertTarget) {
            console.log(chalk.red("Usage: wh convert <component-dir> <name> <target> [output-dir]"));
            console.log(chalk.gray("Targets: react, next, vue, svelte, angular, astro"));
            console.log(chalk.gray("Example: wh convert ./components/navbar navbar react ./output"));
            process.exit(1);
        }
        const { convert } = await import("../helper/converter.js");
        console.log(chalk.cyan(`\n🔄 Converting "${convertName}" to ${convertTarget}...`));
        try {
            const result = await convert(convertDir, convertName, convertTarget, convertOut || "./converted");
            console.log(chalk.green(`\n✅ Converted successfully!`));
            console.log(chalk.white(`📄 Output : ${result.outPath}`));
            console.log(chalk.gray(`\n--- Preview ---\n`));
            console.log(chalk.gray(result.code.split("\n").slice(0, 20).join("\n")));
            if (result.code.split("\n").length > 20) console.log(chalk.gray("... (truncated)"));
        } catch (err) {
            console.log(chalk.red(`\n❌ Conversion failed: ${err.message}`));
            process.exit(1);
        }
        break;
    }
    case "analyze": {
        const dir = args[1];
        if (!dir) {
            console.log(chalk.red("Usage: wh analyze <component-dir>"));
            process.exit(1);
        }
        const { analyzeComponent } = await import("../helper/analyzer.js");
        const result = await analyzeComponent(dir);
        console.log(chalk.cyan("\n🔍 Component Analysis\n"));
        console.log(chalk.white(`Framework : ${result.framework}`));
        console.log(chalk.white(`Styling   : ${result.styling.join(", ")}`));
        console.log(chalk.white(`Imports   : ${result.imports.join(", ") || "none"}`));
        console.log(chalk.white(`CDN Assets resolved:`));
        if (result.assets.length) {
            result.assets.forEach(a => console.log(chalk.gray(`  [${a.type}] ${a.url}`)));
        } else {
            console.log(chalk.gray("  none"));
        }
        break;
    }
    default:
        console.log(chalk.cyan(BANNER));
        console.log(chalk.white("Commands:"));
        console.log(chalk.gray("  wh init                                              — setup your project"));
        console.log(chalk.gray("  wh ship <comp-dir> <site-dir> [version] [out-dir]    — deploy + build + zip in one shot"));
        console.log(chalk.gray("  wh deploy <dir> <name> <version>                     — deploy a single component"));
        console.log(chalk.gray("  wh graph-deploy <comp-dir> [version] [out-dir]       — deploy all + resolve dep graph"));
        console.log(chalk.gray("  wh build <src-dir> [out-dir]                         — production build"));
        console.log(chalk.gray("  wh zip <src-dir> [out-file]                          — zip for deployment"));
        console.log(chalk.gray("  wh atomize <html-file> [out-dir] [version]           — split page into CDN components"));
        console.log(chalk.gray("  wh breakdown <dir>                               — extract CSS/JS from single HTML file"));
        console.log(chalk.gray("  wh access grant|revoke|list                      — role-based access control"));
        console.log(chalk.gray("  wh convert <dir> <name> <target> [out-dir]           — convert to react/vue/svelte/next/astro"));
        break;
}
