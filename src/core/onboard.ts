#!/usr/bin/env node
// =========================================================================================================================================
// scripts/onboard.ts — First-time setup for a project using totopo
// Called by ai.sh when no .totopo/ config is found in the project.
// =========================================================================================================================================

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { box, cancel, confirm, intro, isCancel, log, outro, select } from "@clack/prompts";
import { detectHostRuntimes } from "./detect-host.ts";
import { generateDockerfile } from "./generate-dockerfile.ts";
import { selectTools } from "./select-tools.ts";
import { type RuntimeMode, writeSettings } from "./settings.ts";

const packageDir = process.env.TOTOPO_PACKAGE_DIR;
const repoRoot = process.env.TOTOPO_REPO_ROOT;

if (!packageDir || !repoRoot) {
    log.error("TOTOPO_PACKAGE_DIR / TOTOPO_REPO_ROOT not set — run via ai.sh");
    process.exit(1);
}

const templatesDir = join(packageDir, "templates");
const totopoDir = join(repoRoot, ".totopo");
const projectName = basename(repoRoot);

// ─── Intro ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
intro("totopo — First-time setup");

box(`project  : ${projectName}\nlocation : ${totopoDir}`, "No .totopo/ config found — totopo will create it now.", {
    contentAlign: "center",
    titleAlign: "center",
    width: "auto",
    rounded: true,
});

const ok = await confirm({ message: "Continue?" });

if (isCancel(ok) || !ok) {
    cancel("Setup cancelled.");
    process.exit(0);
}

// ─── Copy templates ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
mkdirSync(totopoDir, { recursive: true });

cpSync(join(templatesDir, "Dockerfile"), join(totopoDir, "Dockerfile"));
cpSync(join(templatesDir, "post-start.mjs"), join(totopoDir, "post-start.mjs"));

// Substitute project name in devcontainer.json (plain string replace — file has // comments)
const dcTemplate = readFileSync(join(templatesDir, "devcontainer.json"), "utf8");
writeFileSync(join(totopoDir, "devcontainer.json"), dcTemplate.replace(/TOTOPO_PROJECT_NAME/g, projectName));

log.success("Copied config templates to .totopo/");

// ─── Runtime mode ────────────────────────────────────────────────────────────
const modeChoice = await select({
    message: "Runtime mode:",
    options: [
        { value: "host-mirror", label: "Host-mirror  (recommended — match your installed runtimes)" },
        { value: "full", label: "Full  (latest stable versions of every tool)" },
    ],
});

if (isCancel(modeChoice)) {
    cancel("Setup cancelled.");
    process.exit(0);
}

const mode = modeChoice as RuntimeMode;
let selectedTools: string[] = [];

if (mode === "host-mirror") {
    const hostRuntimes = detectHostRuntimes();
    selectedTools = await selectTools(hostRuntimes);
    const dockerfile = generateDockerfile("host-mirror", templatesDir, selectedTools, hostRuntimes);
    writeFileSync(join(totopoDir, "Dockerfile"), dockerfile);
}

writeSettings(totopoDir, { runtimeMode: mode, selectedTools });

// ─── Commit scope ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const scopeChoice = await select({
    message: "Commit .totopo/ config to git?",
    options: [
        { value: "shared", label: "Shared — commit config files, only .env stays private" },
        { value: "local", label: "Local only — add entire .totopo/ to .gitignore" },
    ],
});

if (isCancel(scopeChoice)) {
    cancel("Setup cancelled.");
    process.exit(0);
}

const commitScope = scopeChoice as "shared" | "local";

// ─── Create .env ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const envPath = join(totopoDir, ".env");
if (existsSync(envPath)) {
    log.info(".totopo/.env already exists — leaving it untouched");
} else {
    cpSync(join(templatesDir, "env"), envPath);
    log.success("Created .totopo/.env");
}

// ─── Gitignore ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const gitignorePath = join(repoRoot, ".gitignore");
const gitignoreContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : null;

if (commitScope === "local") {
    const entry = ".totopo/";
    const addition = "\n# totopo — config is local-only for this project\n.totopo/\n";
    if (gitignoreContent !== null && gitignoreContent.includes(entry)) {
        log.info(".totopo/ already in .gitignore");
    } else {
        const newContent = gitignoreContent !== null ? gitignoreContent + addition : addition;
        writeFileSync(gitignorePath, newContent);
        log.success("Added .totopo/ to .gitignore");
    }
} else {
    const entry = ".totopo/.env";
    const addition = "\n# totopo — API keys must never be committed\n.totopo/.env\n";
    if (gitignoreContent !== null && gitignoreContent.includes(entry)) {
        log.info(".totopo/.env already in .gitignore");
    } else {
        const newContent = gitignoreContent !== null ? gitignoreContent + addition : addition;
        writeFileSync(gitignorePath, newContent);
        log.success("Added .totopo/.env to .gitignore");
    }
}

log.warn("Add your API keys to .totopo/.env before starting the container.");
outro("Setup complete. Run totopo again to start your session.");
