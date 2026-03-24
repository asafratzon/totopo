#!/usr/bin/env node
// =============================================================================
// bin/totopo.js — totopo entry point
// Run this from your project directory (or via npx totopo).
// =============================================================================

import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run as advanced } from "../dist/commands/advanced.js";
import { run as dev } from "../dist/commands/dev.js";
import { run as doctor } from "../dist/commands/doctor.js";
import { run as menu } from "../dist/commands/menu.js";
import { run as onboard } from "../dist/commands/onboard.js";
import { run as stop } from "../dist/commands/stop.js";
import { run as syncDockerfile } from "../dist/commands/sync-dockerfile.js";

// ─── Guard: inside container ──────────────────────────────────────────────────
try {
    if (execSync("whoami", { encoding: "utf8" }).trim() === "devuser") {
        console.error("");
        console.error("  You are running totopo from inside the dev container.");
        console.error("  Open a terminal on your host machine and run:");
        console.error("");
        console.error("    totopo  (or npx totopo from your project directory)");
        console.error("");
        process.exit(1);
    }
} catch {
    // whoami unavailable — not blocking
}

// ─── Paths ────────────────────────────────────────────────────────────────────
// dirname(dirname(...)) walks up from bin/ to the package root.
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

let repoRoot;
try {
    repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
} catch {
    console.error("");
    console.error("  No git repository found.");
    console.error("");
    console.error("  totopo requires a git repository. Run 'git init' first, then re-run totopo.");
    console.error("");
    process.exit(1);
}

// ─── Guard: dist/ must exist ─────────────────────────────────────────────────
if (!existsSync(new URL("../dist/commands/sync-dockerfile.js", import.meta.url))) {
    console.error("");
    console.error("  totopo: compiled output not found.");
    console.error("  This should not happen with a published package.");
    console.error("  If you are developing locally, run: pnpm build");
    console.error("");
    process.exit(1);
}

// ─── Onboarding ───────────────────────────────────────────────────────────────
if (!existsSync(`${repoRoot}/.totopo/Dockerfile`)) {
    const completed = await onboard(packageDir, repoRoot);
    if (!completed) process.exit(0);
}

// ─── Sync Dockerfile with host runtimes ───────────────────────────────────────
await syncDockerfile(packageDir, repoRoot);

// ─── Doctor (silent pre-check) ────────────────────────────────────────────────
const doctorResult = await doctor(repoRoot, false);
if (!doctorResult.ok) {
    console.error("  Fix the issues above and re-run totopo.");
    console.error("");
    process.exit(1);
}

// ─── Gather state for menu ────────────────────────────────────────────────────
const projectName = basename(repoRoot);

const dockerResult = spawnSync("docker", ["ps", "--filter", "name=totopo-managed-", "--format", "{{.Names}}"], {
    encoding: "utf8",
});
const activeCount = dockerResult.stdout ? dockerResult.stdout.trim().split("\n").filter(Boolean).length : 0;

const projectContainerResult = spawnSync("docker", ["ps", "--filter", `name=totopo-managed-${projectName}`, "--format", "{{.Names}}"], {
    encoding: "utf8",
});
const projectRunning = (projectContainerResult.stdout ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .some((n) => n === `totopo-managed-${projectName}`);

// ─── Interactive menu loop ────────────────────────────────────────────────────
let showMenu = true;
while (showMenu) {
    showMenu = false;

    const action = await menu({ projectName, activeCount, projectRunning });

    switch (action) {
        case "dev":
            await dev(packageDir, repoRoot);
            break;
        case "stop":
            await stop(projectName);
            break;
        case "advanced": {
            const result = await advanced(packageDir, projectName, repoRoot);
            if (result === "back") showMenu = true;
            if (result === "rebuild") await dev(packageDir, repoRoot);
            break;
        }
        default:
            break; // quit or cancelled
    }
}
