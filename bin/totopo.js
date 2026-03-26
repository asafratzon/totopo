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
import { addProjectAnchor, run as onboard } from "../dist/commands/onboard.js";
import { run as rebuild } from "../dist/commands/rebuild.js";
import { run as settings } from "../dist/commands/settings.js";
import { run as stop } from "../dist/commands/stop.js";
import { run as syncDockerfile } from "../dist/commands/sync-dockerfile.js";
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
// dirname(dirname(...)) walks up from bin/ to the package root.
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cwd = process.cwd();

// --- Guard: dist/ must exist -------------------------------------------------------------------------------------------------------------
if (!existsSync(new URL("../dist/commands/sync-dockerfile.js", import.meta.url))) {
    console.error("");
    console.error("  totopo: compiled output not found.");
    console.error("  This should not happen with a published package.");
    console.error("  If you are developing locally, run: pnpm build");
    console.error("");
    process.exit(1);
}

// --- Resolve project from CWD (walk-up through ~/.totopo/projects/) ----------------------------------------------------------------------
let project = resolveProject(cwd);

// --- Onboarding (if not in a registered project) -----------------------------------------------------------------------------------------
if (!project) {
    // Detect project context: git root or totopo.yaml present?
    let gitRoot = null;
    try {
        gitRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8", stdio: "pipe" }).trim();
    } catch {
        // Not in a git repo - that's fine
    }

    const totopoJsonPath = `${gitRoot ?? cwd}/totopo.yaml`;
    const hasTotopoYaml = existsSync(totopoJsonPath);

    if (gitRoot !== null || hasTotopoYaml) {
        // Has project context - if other projects already exist, let the user choose first
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
                await advanced(packageDir);
                process.exit(0);
            }
        }

        const ctx = await onboard(packageDir, cwd);
        if (!ctx) process.exit(0); // cancelled -> exit cleanly
        project = ctx;
    } else {
        // No project context -> show Manage totopo menu directly
        await advanced(packageDir);
        process.exit(0);
    }
}

// --- Sync Dockerfile with host runtimes --------------------------------------------------------------------------------------------------
await syncDockerfile(packageDir, project);

// --- Doctor (silent pre-check) -----------------------------------------------------------------------------------------------------------
const doctorResult = await doctor(project.projectDir, false);
if (!doctorResult.ok) {
    console.error("  Fix the issues above and re-run totopo.");
    console.error("");
    process.exit(1);
}

// --- Gather container state for menu -----------------------------------------------------------------------------------------------------
const { containerName } = project.meta;

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

    // Re-evaluated each iteration so menu options stay in sync (e.g. after "Add project anchor")
    const hasTotopoYaml = existsSync(`${project.meta.projectRoot}/totopo.yaml`);

    const action = await menu({ ctx: project, activeCount, projectRunning, hasTotopoYaml });

    switch (action) {
        case "dev":
            await dev(packageDir, project);
            break;
        case "rebuild":
            await rebuild(project.meta.containerName);
            await dev(packageDir, project);
            break;
        case "stop":
            await stop(project.meta.containerName);
            break;
        case "settings":
            await settings(packageDir, project);
            showMenu = true;
            break;
        case "add-anchor":
            await addProjectAnchor(project);
            showMenu = true;
            break;
        case "manage-totopo": {
            const result = await advanced(packageDir);
            if (result === "back") showMenu = true;
            break;
        }
        default:
            break; // quit or cancelled
    }
}
