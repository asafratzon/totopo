#!/usr/bin/env node
// =========================================================================================================================================
// bin/totopo.js - totopo entry point
// Run this from your workspace directory (or via npx totopo).
// =========================================================================================================================================

import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cancel, confirm, isCancel, log, select } from "@clack/prompts";
import { run as dev } from "../dist/commands/dev.js";
import { run as doctor } from "../dist/commands/doctor.js";
import { run as globalMenu } from "../dist/commands/global.js";
import { run as menu } from "../dist/commands/menu.js";
import { run as onboard } from "../dist/commands/onboard.js";
import { resetImage, stop, run as workspaceMenu } from "../dist/commands/workspace.js";
import { GITHUB_README_URL, repairTotopoYaml } from "../dist/lib/totopo-yaml.js";
import { deriveContainerName, findTotopoYamlDir, listWorkspaceIds, resolveWorkspace } from "../dist/lib/workspace-identity.js";

// --- Guard: inside container -------------------------------------------------------------------------------------------------------------
try {
    if (execSync("whoami", { encoding: "utf8" }).trim() === "devuser") {
        console.error("");
        console.error("  You are running totopo from inside the dev container.");
        console.error("  Open a terminal on your host machine and run:");
        console.error("");
        console.error("    totopo  (or npx totopo from your workspace directory)");
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
    const { runMigration } = await import("../dist/lib/migrate-to-latest.js");
    runMigration(process.cwd());
} catch {
    // Non-fatal - migration failure should not block startup
}

// --- Auto-repair totopo.yaml if needed ---------------------------------------------------------------------------------------------------
const yamlDir = findTotopoYamlDir(cwd);
if (yamlDir) {
    const result = repairTotopoYaml(yamlDir);
    if (result.error) {
        console.error("");
        console.error(`  ${result.error}`);
        console.error("");
        process.exit(1);
    }
    if (result.repairedYaml) {
        log.info(result.message);

        // Prompt to stop container if running (config changed)
        const cn = deriveContainerName(result.repairedYaml.workspace_id);
        const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", cn], {
            encoding: "utf8",
            stdio: "pipe",
        });
        if (inspect.status === 0 && inspect.stdout.trim() === "running") {
            const shouldStop = await confirm({
                message: "Stop the running container so repaired config applies on next session?",
            });
            if (isCancel(shouldStop) || !shouldStop) {
                log.warn("Container still running with old config.");
            } else {
                spawnSync("docker", ["stop", cn], { stdio: "pipe" });
                spawnSync("docker", ["rm", cn], { stdio: "pipe" });
                log.info("Container stopped. Changes will apply on next session.");
            }
        }
    }
}

// --- Resolve workspace from CWD (walk-up looking for totopo.yaml) ------------------------------------------------------------------------
let workspace;
try {
    workspace = resolveWorkspace(cwd);
} catch (err) {
    console.error("");
    console.error(`  ${err instanceof Error ? err.message : err}`);
    console.error("");
    process.exit(1);
}

// --- Onboarding (if not in a registered workspace) ---------------------------------------------------------------------------------------
if (!workspace) {
    // If other workspaces already exist, let the user choose setup vs manage
    if (listWorkspaceIds().length > 0) {
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
            await globalMenu();
            process.exit(0);
        }
    }

    const ctx = await onboard(cwd);
    if (!ctx) process.exit(0);
    workspace = ctx;
}

// --- Doctor (silent pre-check) -----------------------------------------------------------------------------------------------------------
const doctorResult = await doctor(null, false);
if (!doctorResult.ok) {
    console.error("  Fix the issues above and re-run totopo.");
    console.error("");
    process.exit(1);
}

// --- Interactive menu loop ---------------------------------------------------------------------------------------------------------------
const { containerName } = workspace;
let showMenu = true;
while (showMenu) {
    showMenu = false;

    // Refresh container state on each loop iteration
    const dockerResult = spawnSync("docker", ["ps", "--filter", "name=totopo-", "--format", "{{.Names}}"], {
        encoding: "utf8",
    });
    const activeNames = dockerResult.stdout ? dockerResult.stdout.trim().split("\n").filter(Boolean) : [];
    const activeCount = activeNames.length;
    const workspaceRunning = activeNames.some((n) => n === containerName);

    const action = await menu({ ctx: workspace, activeCount, workspaceRunning });

    switch (action) {
        case "dev":
            await dev(packageDir, workspace);
            break;
        case "stop":
            await stop(workspace.containerName);
            break;
        case "settings": {
            const settingsResult = await workspaceMenu(workspace);
            if (settingsResult === "rebuild") {
                await resetImage(workspace.containerName);
                await dev(packageDir, workspace);
            } else if (settingsResult === "clean-rebuild") {
                await resetImage(workspace.containerName);
                await dev(packageDir, workspace, { noCache: true });
            } else {
                showMenu = true;
            }
            break;
        }
        case "manage-totopo": {
            const result = await globalMenu(workspace.workspaceId);
            if (result === "back") showMenu = true;
            break;
        }
        case "help":
            log.info(`Check out the official docs at:\n  ${GITHUB_README_URL}`);
            break;
        default:
            break;
    }
}
