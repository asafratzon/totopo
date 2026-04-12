// =========================================================================================================================================
// src/commands/global.ts - Manage totopo menu (global, all workspaces)
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cancel, confirm, isCancel, log, multiselect, outro, select, text } from "@clack/prompts";
import { AGENTS_DIR, CONTAINER_NAME_PREFIX, LABEL_MANAGED, TOTOPO_DIR, TOTOPO_YAML } from "../lib/constants.js";
import { safeRmSync } from "../lib/safe-rm.js";
import { listWorkspaces } from "../lib/workspace-identity.js";
// --- Helpers -----------------------------------------------------------------------------------------------------------------------------

/** Remove workspace cache dir and optionally totopo.yaml from the workspace root. Exported for testing. */
export function removeWorkspaceFiles(workspaceRoot: string, workspaceDir: string, removeTotopoYaml: boolean): void {
    safeRmSync(workspaceDir, { recursive: true, force: true });
    if (removeTotopoYaml) {
        const yamlPath = join(workspaceRoot, TOTOPO_YAML);
        if (existsSync(yamlPath)) {
            safeRmSync(yamlPath);
        }
    }
}

function stopAndRemoveContainer(name: string) {
    spawnSync("docker", ["stop", name], { stdio: "pipe" });
    spawnSync("docker", ["rm", name], { stdio: "pipe" });
}

// --- Stop containers (multi-select across all workspaces) --------------------------------------------------------------------------------
async function stopContainers(): Promise<void> {
    const listResult = spawnSync("docker", ["ps", "--filter", `name=${CONTAINER_NAME_PREFIX}`, "--format", "{{.Names}}"], {
        encoding: "utf8",
    });
    const running = (listResult.stdout ?? "").trim().split("\n").filter(Boolean);

    if (running.length === 0) {
        log.info("No running totopo containers.");
        return;
    }

    let toStop: string[];
    if (running.length === 1) {
        toStop = running;
        log.info(`Stopping ${running[0] ?? ""}...`);
    } else {
        const selected = await multiselect({
            message: "Select containers to stop: (space to toggle, enter to confirm)",
            options: running.map((name) => ({ value: name, label: name })),
            required: false,
        });
        if (isCancel(selected)) {
            cancel();
            return;
        }
        toStop = selected as string[];
    }

    for (const name of toStop) {
        log.step(`Stopping ${name}...`);
        stopAndRemoveContainer(name);
    }
    log.success("Done.");
}

// --- Clear agent memory (multi-select across all workspaces) -----------------------------------------------------------------------------
async function clearAgentMemory(): Promise<void> {
    const workspaces = listWorkspaces().filter((w) => existsSync(join(w.workspaceDir, AGENTS_DIR)));

    if (workspaces.length === 0) {
        log.info("No agent memory found.");
        return;
    }

    let toClear: string[];
    if (workspaces.length === 1) {
        const w = workspaces[0];
        if (w === undefined) return;
        toClear = [w.workspaceId];
        log.info(`Clearing agent memory for ${w.workspaceId}...`);
    } else {
        const selected = await multiselect({
            message: "Select workspaces to clear agent memory for: (space to toggle, enter to confirm)",
            options: workspaces.map((w) => ({ value: w.workspaceId, label: w.workspaceId, hint: w.workspaceRoot })),
            required: false,
        });
        if (isCancel(selected)) {
            cancel();
            return;
        }
        toClear = selected as string[];
    }

    for (const id of toClear) {
        const w = workspaces.find((x) => x.workspaceId === id);
        if (!w) continue;

        const inspectResult = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", w.containerName], {
            encoding: "utf8",
            stdio: "pipe",
        });
        const isRunning = inspectResult.status === 0 && inspectResult.stdout.trim() === "running";

        if (isRunning) {
            const confirmed = await confirm({
                message: `Container for ${w.workspaceId} is running. Stop it to clear memory?`,
            });
            if (isCancel(confirmed) || !confirmed) continue;
            log.step(`Stopping ${w.containerName}...`);
            stopAndRemoveContainer(w.containerName);
        }

        const agentsDir = join(w.workspaceDir, AGENTS_DIR);
        safeRmSync(agentsDir, { recursive: true, force: true });
        log.success(`Cleared agent memory for ${w.workspaceId}.`);
    }
}

// --- Remove images (multi-select across all workspaces) ----------------------------------------------------------------------------------
async function removeImages(): Promise<void> {
    const listResult = spawnSync("docker", ["images", "--filter", `label=${LABEL_MANAGED}=true`, "--format", "{{.Repository}}\t{{.ID}}"], {
        encoding: "utf8",
    });
    const lines = (listResult.stdout ?? "").trim().split("\n").filter(Boolean);

    if (lines.length === 0) {
        log.info("No totopo images found.");
        return;
    }

    const images = lines.map((line) => {
        const parts = line.split("\t");
        const repo = parts[0] ?? "";
        const id = parts[1] ?? "";
        return { repo, id };
    });

    const selected = await multiselect({
        message: "Select images to remove: (space to toggle, enter to confirm)",
        options: images.map((img) => ({ value: img.repo, label: img.repo, hint: img.id.slice(0, 12) })),
        required: false,
    });

    if (isCancel(selected)) {
        cancel();
        return;
    }

    // Stop any running container using this image first
    for (const repo of selected as string[]) {
        const psResult = spawnSync("docker", ["ps", "--filter", `name=${repo}`, "--format", "{{.Names}}"], {
            encoding: "utf8",
        });
        const containers = (psResult.stdout ?? "").trim().split("\n").filter(Boolean);
        for (const c of containers) {
            log.step(`Stopping container ${c} before removing image...`);
            stopAndRemoveContainer(c);
        }
        log.step(`Removing image ${repo}...`);
        spawnSync("docker", ["rmi", repo], { stdio: "pipe" });
    }
    log.success("Done.");
}

// --- Uninstall workspaces (multi-select, remove container + image + workspace dir) -------------------------------------------------------
async function uninstallWorkspaces(currentWorkspaceId?: string): Promise<boolean> {
    const workspaces = listWorkspaces();

    if (workspaces.length === 0) {
        log.info("No registered workspaces.");
        return false;
    }

    // Show current workspace first if known
    const sorted = currentWorkspaceId
        ? [...workspaces].sort((a, b) => (a.workspaceId === currentWorkspaceId ? -1 : b.workspaceId === currentWorkspaceId ? 1 : 0))
        : workspaces;

    log.info(
        "Uninstalling a workspace stops and removes its container and image, and deletes its data from ~/.totopo/workspaces/. Your files are untouched.",
    );

    const selected = await multiselect({
        message: "Select workspaces to uninstall: (space to toggle, enter to confirm)",
        options: sorted.map((w) => ({
            value: w.workspaceId,
            label: w.workspaceId,
            hint: w.workspaceRoot + (w.workspaceId === currentWorkspaceId ? " (current)" : ""),
        })),
        required: false,
    });

    if (isCancel(selected)) {
        cancel();
        return false;
    }

    const selectedIds = selected as string[];

    for (const id of selectedIds) {
        const w = workspaces.find((x) => x.workspaceId === id);
        if (!w) continue;

        // Stop and remove container if it exists (running or exited)
        const psResult = spawnSync("docker", ["ps", "-a", "--filter", `name=${w.containerName}`, "--format", "{{.Names}}"], {
            encoding: "utf8",
        });
        const containers = (psResult.stdout ?? "").trim().split("\n").filter(Boolean);
        for (const c of containers) {
            log.step(`Stopping and removing container ${c}...`);
            stopAndRemoveContainer(c);
        }

        log.step(`Removing image ${w.containerName}...`);
        spawnSync("docker", ["rmi", w.containerName], { stdio: "inherit" });

        // Ask whether to also remove totopo.yaml from the workspace root
        const yamlPath = join(w.workspaceRoot, TOTOPO_YAML);
        let removeTotopoYaml = false;
        if (existsSync(yamlPath)) {
            const ans = await confirm({
                message: `Also remove totopo.yaml from ${w.workspaceRoot}?`,
                initialValue: true,
            });
            removeTotopoYaml = !isCancel(ans) && (ans as boolean);
        }

        removeWorkspaceFiles(w.workspaceRoot, w.workspaceDir, removeTotopoYaml);
        log.success(`Uninstalled workspace ${w.workspaceId}.`);
    }

    return currentWorkspaceId !== undefined && selectedIds.includes(currentWorkspaceId);
}

// --- Uninstall totopo (global) -----------------------------------------------------------------------------------------------------------
async function uninstallTotopo(): Promise<void> {
    const confirmed = await text({
        message: 'Type "uninstall-totopo" to confirm full uninstall:',
        validate: (v) => ((v ?? "").trim() !== "uninstall-totopo" ? 'Type exactly "uninstall-totopo" to confirm' : undefined),
    });

    if (isCancel(confirmed) || (confirmed as string).trim() !== "uninstall-totopo") {
        cancel("Uninstall cancelled.");
        return;
    }

    // Stop and remove all totopo containers
    const psResult = spawnSync("docker", ["ps", "-a", "--filter", `name=${CONTAINER_NAME_PREFIX}`, "--format", "{{.Names}}"], {
        encoding: "utf8",
    });
    const containers = (psResult.stdout ?? "").trim().split("\n").filter(Boolean);
    for (const c of containers) {
        log.step(`Stopping and removing container ${c}...`);
        stopAndRemoveContainer(c);
    }

    // Remove all totopo images
    const imagesResult = spawnSync("docker", ["images", "--filter", `label=${LABEL_MANAGED}=true`, "--format", "{{.Repository}}"], {
        encoding: "utf8",
    });
    const imgs = (imagesResult.stdout ?? "").trim().split("\n").filter(Boolean);
    for (const img of imgs) {
        log.step(`Removing image ${img}...`);
        spawnSync("docker", ["rmi", img], { stdio: "inherit" });
    }

    // Delete ~/.totopo/
    const globalTotopoDir = join(homedir(), TOTOPO_DIR);
    if (existsSync(globalTotopoDir)) {
        log.step("Deleting ~/.totopo/...");
        safeRmSync(globalTotopoDir, { recursive: true, force: true });
    }

    outro("totopo uninstalled. Re-run npx totopo to set up again.");
}

// --- Manage totopo menu ------------------------------------------------------------------------------------------------------------------
export async function run(currentWorkspaceId?: string): Promise<"back" | undefined> {
    while (true) {
        const action = await select({
            message: "Manage totopo:",
            options: [
                { value: "stop-containers", label: "Stop containers", hint: "pick running containers" },
                { value: "clear-memory", label: "Clear agent memory", hint: "pick workspaces to clear" },
                { value: "remove-images", label: "Remove images", hint: "pick images to remove" },
                { value: "uninstall-workspace", label: "Uninstall workspaces", hint: "pick workspaces to remove" },
                { value: "uninstall", label: "Uninstall totopo", hint: "wipe ~/.totopo/ and all containers/images" },
                { value: "back", label: "← Back" },
            ],
        });

        if (isCancel(action) || action === "back") {
            return "back";
        }

        switch (action) {
            case "stop-containers":
                await stopContainers();
                break;
            case "clear-memory":
                await clearAgentMemory();
                break;
            case "remove-images":
                await removeImages();
                break;
            case "uninstall-workspace": {
                const currentDeleted = await uninstallWorkspaces(currentWorkspaceId);
                if (currentDeleted) return undefined;
                break;
            }
            case "uninstall":
                await uninstallTotopo();
                return undefined;
        }
    }
}
