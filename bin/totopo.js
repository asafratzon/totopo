#!/usr/bin/env node
// =========================================================================================================================================
// bin/totopo.js - totopo entry point
// Run this from your workspace directory (or via npx totopo).
// =========================================================================================================================================

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cancel, confirm, isCancel, log, select } from "@clack/prompts";
import { run as advancedMenu } from "../dist/commands/advanced.js";
import { run as dev } from "../dist/commands/dev.js";
import { run as doctor } from "../dist/commands/doctor.js";
import { run as menu } from "../dist/commands/menu.js";
import { run as onboard } from "../dist/commands/onboard.js";
import { resetImage, run as settingsMenu, stop } from "../dist/commands/settings.js";
import { isAudioServerRunning } from "../dist/lib/audio-host.js";
import { GITHUB_README_URL, repairTotopoYaml } from "../dist/lib/totopo-yaml.js";
import { deriveContainerName, findTotopoYamlDir, listWorkspaceIds, resolveWorkspace } from "../dist/lib/workspace-identity.js";

// --- Suppress Docker CLI hints ------------------------------------------------------------------------------------------------------------
// Docker prints a "What's next:" hint block (about `docker debug`) to stderr after commands like `docker run`. Our
// interactive docker calls inherit stderr, so the hint leaks between totopo's own log steps. totopo owns this process
// and never wants those hints, so force it off unconditionally; every docker child inherits this env.
process.env.DOCKER_CLI_HINTS = "false";

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

// --- Version -----------------------------------------------------------------------------------------------------------------------------
const { version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

// --- Guard: dist/ must exist -------------------------------------------------------------------------------------------------------------
if (!existsSync(new URL("../dist/commands/dev.js", import.meta.url))) {
    console.error("");
    console.error("  totopo: compiled output not found.");
    console.error("  This should not happen with a published package.");
    console.error("  If you are developing locally, run: pnpm build");
    console.error("");
    process.exit(1);
}

// --- migrations check --------------------------------------------------------------------------------------------------------------------
try {
    const { runMigration } = await import("../dist/lib/migrate-to-latest.js");
    await runMigration(process.cwd(), false);
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
        while (true) {
            process.stdout.write("\n");
            const choice = await select({
                message: "What would you like to do?",
                options: [
                    { value: "setup", label: "Set up totopo for this directory" },
                    { value: "advanced", label: "Advanced" },
                ],
            });
            if (isCancel(choice)) {
                cancel();
                process.exit(0);
            }
            if (choice === "advanced") {
                // "Back" returns here to re-show this chooser; a terminal action (uninstall) returns
                // undefined and exits, matching the main menu loop's handling below.
                const result = await advancedMenu();
                if (result === "back") continue;
                process.exit(0);
            }
            // "setup" - leave the chooser and fall through to onboarding.
            break;
        }
    }

    const ctx = await onboard(cwd);
    if (!ctx) process.exit(0);
    workspace = ctx;
}

// --- Doctor (pre-check; silent on success, prints failed checks otherwise) ---------------------------------------------------------------
const doctorResult = await doctor();
if (!doctorResult.ok) {
    console.error("");
    console.error("  totopo can't start:");
    for (const err of doctorResult.errors) {
        console.error(`    \x1b[2m•\x1b[0m  ${err}`);
    }
    console.error("");
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

    // Host audio server is global and totopo never stops it on its own; surface it in the status box while up.
    const audioServerRunning = isAudioServerRunning();

    const action = await menu({ ctx: workspace, activeCount, workspaceRunning, audioServerRunning, version });

    switch (action) {
        case "dev":
            await dev(packageDir, workspace);
            break;
        case "stop":
            await stop(workspace.containerName);
            break;
        case "settings": {
            const settingsResult = await settingsMenu(workspace);
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
        case "advanced": {
            const result = await advancedMenu(workspace.workspaceId);
            if (result === "back") showMenu = true;
            break;
        }
        case "help":
            log.info(`Check out the official docs at:\n  ${GITHUB_README_URL}`);
            // Trailing blank line so the docs link does not sit flush against the next shell prompt.
            process.stdout.write("\n");
            break;
        case "quit":
            // Trailing blank line so the menu does not sit flush against the next shell prompt.
            process.stdout.write("\n");
            break;
        default:
            break;
    }
}
