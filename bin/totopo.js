#!/usr/bin/env node
// =========================================================================================================================================
// bin/totopo.js - totopo entry point
// Run this from your project directory (or via npx totopo).
// =========================================================================================================================================

import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cancel, isCancel, select } from "@clack/prompts";
import { run as advanced } from "../dist/commands/advanced.js";
import { run as dev } from "../dist/commands/dev.js";
import { run as doctor } from "../dist/commands/doctor.js";
import { run as menu } from "../dist/commands/menu.js";
import { run as onboard } from "../dist/commands/onboard.js";
import { run as rebuild } from "../dist/commands/rebuild.js";
import { run as settings } from "../dist/commands/settings.js";
import { run as stop } from "../dist/commands/stop.js";
import { listProjectIds, resolveProject } from "../dist/lib/project-identity.js";

// --- Guard: inside container -------------------------------------------------------------------------------------------------------------
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
    // whoami unavailable - not blocking
}

// --- Paths -------------------------------------------------------------------------------------------------------------------------------
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cwd = process.cwd();

// --- Guard: dist/ must exist -------------------------------------------------------------------------------------------------------------
if (!existsSync(new URL("../dist/commands/dev.js", import.meta.url))) {
    console.error("");
    console.error("  totopo: compiled output not found.");
    console.error("  This should not happen with a published package.");
    console.error("  If you are developing locally, run: pnpm build");
    console.error("");
    process.exit(1);
}

// --- v2 migration check ------------------------------------------------------------------------------------------------------------------
try {
    const { runMigration } = await import("../dist/lib/migrate-v2.js");
    await runMigration();
} catch {
    // migrate-v2 module may not exist yet during development - that's fine
}

// --- Resolve project from CWD (walk-up looking for totopo.yaml) --------------------------------------------------------------------------
let project;
try {
    project = resolveProject(cwd);
} catch (err) {
    console.error("");
    console.error(`  ${err instanceof Error ? err.message : err}`);
    console.error("");
    process.exit(1);
}

// --- Onboarding (if not in a registered project) -----------------------------------------------------------------------------------------
if (!project) {
    // If other projects already exist, let the user choose setup vs manage
    if (listProjectIds().length > 0) {
        process.stdout.write("\n");
        const choice = await select({
            message: "What would you like to do?",
            options: [
                { value: "setup", label: "Set up totopo for this directory" },
                { value: "manage", label: "Manage totopo →" },
            ],
        });
        if (isCancel(choice)) {
            cancel();
            process.exit(0);
        }
        if (choice === "manage") {
            await advanced();
            process.exit(0);
        }
    }

    const ctx = await onboard(cwd);
    if (!ctx) process.exit(0);
    project = ctx;
}

// --- Doctor (silent pre-check) -----------------------------------------------------------------------------------------------------------
const doctorResult = await doctor(null, false);
if (!doctorResult.ok) {
    console.error("  Fix the issues above and re-run totopo.");
    console.error("");
    process.exit(1);
}

// --- Gather container state for menu -----------------------------------------------------------------------------------------------------
const { containerName } = project;

const dockerResult = spawnSync("docker", ["ps", "--filter", "name=totopo-", "--format", "{{.Names}}"], {
    encoding: "utf8",
});
const activeNames = dockerResult.stdout ? dockerResult.stdout.trim().split("\n").filter(Boolean) : [];
const activeCount = activeNames.length;
const projectRunning = activeNames.some((n) => n === containerName);

// --- Interactive menu loop ---------------------------------------------------------------------------------------------------------------
let showMenu = true;
while (showMenu) {
    showMenu = false;

    const action = await menu({ ctx: project, activeCount, projectRunning });

    switch (action) {
        case "dev":
            await dev(packageDir, project);
            break;
        case "rebuild":
            await rebuild(project.containerName);
            await dev(packageDir, project);
            break;
        case "stop":
            await stop(project.containerName);
            break;
        case "settings":
            await settings(project);
            showMenu = true;
            break;
        case "manage-totopo": {
            const result = await advanced(project.projectId);
            if (result === "back") showMenu = true;
            break;
        }
        default:
            break;
    }
}
