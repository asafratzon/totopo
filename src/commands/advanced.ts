// =========================================================================================================================================
// src/commands/advanced.ts - Manage totopo menu (global, all workspaces)
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cancel, confirm, isCancel, log, multiselect, outro, select, text } from "@clack/prompts";
import { listWorkspaces } from "../lib/workspace-identity.js";
import { run as runDoctor } from "./doctor.js";

// --- Helpers -----------------------------------------------------------------------------------------------------------------------------
function stopAndRemoveContainer(name: string) {
    spawnSync("docker", ["stop", name], { stdio: "pipe" });
    spawnSync("docker", ["rm", name], { stdio: "pipe" });
}

// --- Stop containers (multi-select across all workspaces) --------------------------------------------------------------------------------
async function stopContainers(): Promise<void> {
    const listResult = spawnSync("docker", ["ps", "--filter", "name=totopo-", "--format", "{{.Names}}"], {
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
    const workspaces = listWorkspaces().filter((w) => existsSync(join(w.workspaceDir, "agents")));

    if (workspaces.length === 0) {
        log.info("No agent memory found.");
        return;
    }

    let toClear: string[];
    if (workspaces.length === 1) {
        const w = workspaces[0];
        if (w === undefined) return;
        toClear = [w.workspaceId];
        log.info(`Clearing agent memory for ${w.displayName}...`);
    } else {
        const selected = await multiselect({
            message: "Select workspaces to clear agent memory for: (space to toggle, enter to confirm)",
            options: workspaces.map((w) => ({ value: w.workspaceId, label: w.displayName, hint: w.workspaceRoot })),
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
                message: `Container for ${w.displayName} is running. Stop it to clear memory?`,
            });
            if (isCancel(confirmed) || !confirmed) continue;
            log.step(`Stopping ${w.containerName}...`);
            stopAndRemoveContainer(w.containerName);
        }

        const agentsDir = join(w.workspaceDir, "agents");
        rmSync(agentsDir, { recursive: true, force: true });
        log.success(`Cleared agent memory for ${w.displayName}.`);
    }
}

// --- Remove images (multi-select across all workspaces) ----------------------------------------------------------------------------------
async function removeImages(): Promise<void> {
    const listResult = spawnSync("docker", ["images", "--filter", "label=totopo.managed=true", "--format", "{{.Repository}}\t{{.ID}}"], {
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

    const selected = await multiselect({
        message: "Select workspaces to uninstall: (space to toggle, enter to confirm)",
        options: sorted.map((w) => ({
            value: w.workspaceId,
            label: w.displayName,
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

        // Delete workspace directory
        rmSync(w.workspaceDir, { recursive: true, force: true });
        log.success(`Uninstalled workspace ${w.displayName}.`);
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
    const psResult = spawnSync("docker", ["ps", "-a", "--filter", "name=totopo-", "--format", "{{.Names}}"], {
        encoding: "utf8",
    });
    const containers = (psResult.stdout ?? "").trim().split("\n").filter(Boolean);
    for (const c of containers) {
        log.step(`Stopping and removing container ${c}...`);
        stopAndRemoveContainer(c);
    }

    // Remove all totopo images
    const imagesResult = spawnSync("docker", ["images", "--filter", "label=totopo.managed=true", "--format", "{{.Repository}}"], {
        encoding: "utf8",
    });
    const imgs = (imagesResult.stdout ?? "").trim().split("\n").filter(Boolean);
    for (const img of imgs) {
        log.step(`Removing image ${img}...`);
        spawnSync("docker", ["rmi", img], { stdio: "inherit" });
    }

    // Delete ~/.totopo/
    const globalTotopoDir = join(homedir(), ".totopo");
    if (existsSync(globalTotopoDir)) {
        log.step("Deleting ~/.totopo/...");
        rmSync(globalTotopoDir, { recursive: true, force: true });
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
                { value: "doctor", label: "Doctor", hint: "check Docker health" },
                { value: "uninstall-workspace", label: "Uninstall workspace", hint: "pick workspaces to remove" },
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
            case "doctor":
                await runDoctor(null, true);
                await sleep(500);
                break;
            case "uninstall":
                await uninstallTotopo();
                return undefined;
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
