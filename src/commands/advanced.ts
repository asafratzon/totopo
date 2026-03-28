// =========================================================================================================================================
// src/commands/advanced.ts - Manage totopo menu (global, all projects)
// Invoked by bin/totopo.js - shown directly when outside a project, or via "Manage totopo" from the project menu.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cancel, confirm, isCancel, log, multiselect, outro, select, text } from "@clack/prompts";
import { listProjects } from "../lib/project-identity.js";
import { run as runDoctor } from "./doctor.js";

// --- Helpers -----------------------------------------------------------------------------------------------------------------------------
function stopAndRemoveContainer(name: string) {
    spawnSync("docker", ["stop", name], { stdio: "inherit" });
    spawnSync("docker", ["rm", name], { stdio: "inherit" });
}

// --- Stop containers (multi-select across all projects) ----------------------------------------------------------------------------------
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
            message: "Select containers to stop:",
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

// --- Clear agent memory (multi-select across all projects) -------------------------------------------------------------------------------
async function clearAgentMemory(): Promise<void> {
    const projects = listProjects().filter((p) => existsSync(join(p.projectDir, "agents")));

    if (projects.length === 0) {
        log.info("No agent memory found.");
        return;
    }

    let toClear: string[]; // project IDs
    if (projects.length === 1) {
        const p = projects[0];
        if (p === undefined) return;
        toClear = [p.id];
        log.info(`Clearing agent memory for ${p.meta.displayName}...`);
    } else {
        const selected = await multiselect({
            message: "Select projects to clear agent memory for:",
            options: projects.map((p) => ({ value: p.id, label: p.meta.displayName, hint: p.meta.projectRoot })),
            required: false,
        });
        if (isCancel(selected)) {
            cancel();
            return;
        }
        toClear = selected as string[];
    }

    for (const id of toClear) {
        const p = projects.find((x) => x.id === id);
        if (!p) continue;

        // Stop the container first if running
        const inspectResult = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", p.meta.containerName], {
            encoding: "utf8",
            stdio: "pipe",
        });
        const isRunning = inspectResult.status === 0 && inspectResult.stdout.trim() === "running";

        if (isRunning) {
            const confirmed = await confirm({
                message: `Container for ${p.meta.displayName} is running. Stop it to clear memory?`,
            });
            if (isCancel(confirmed) || !confirmed) continue;
            log.step(`Stopping ${p.meta.containerName}...`);
            stopAndRemoveContainer(p.meta.containerName);
        }

        const agentsDir = join(p.projectDir, "agents");
        rmSync(agentsDir, { recursive: true, force: true });
        log.success(`Cleared agent memory for ${p.meta.displayName}.`);
    }
}

// --- Remove images (multi-select across all projects) ------------------------------------------------------------------------------------
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
        message: "Select images to remove:",
        options: images.map((img) => ({ value: img.repo, label: img.repo, hint: img.id.slice(0, 12) })),
        required: false,
    });

    if (isCancel(selected)) {
        cancel();
        return;
    }

    for (const repo of selected as string[]) {
        // Stop any running container using this image first
        const psResult = spawnSync("docker", ["ps", "--filter", `name=${repo}`, "--format", "{{.Names}}"], {
            encoding: "utf8",
        });
        const containers = (psResult.stdout ?? "").trim().split("\n").filter(Boolean);
        for (const c of containers) {
            log.step(`Stopping container ${c} before removing image...`);
            stopAndRemoveContainer(c);
        }
        log.step(`Removing image ${repo}...`);
        spawnSync("docker", ["rmi", repo], { stdio: "inherit" });
    }
    log.success("Done.");
}

// --- Reset API keys ----------------------------------------------------------------------------------------------------------------------
async function resetApiKeys(packageDir: string): Promise<void> {
    const globalEnvPath = join(homedir(), ".totopo", ".env");
    const confirmed = await confirm({
        message: `Reset ${globalEnvPath}? This affects all totopo projects on this machine.`,
    });
    if (isCancel(confirmed) || !confirmed) {
        cancel("Cancelled.");
        return;
    }
    mkdirSync(join(homedir(), ".totopo"), { recursive: true });
    cpSync(join(packageDir, "templates", "env"), globalEnvPath);
    log.success(`API keys reset. Edit ${globalEnvPath} to add your keys.`);
}

// --- Uninstall projects (multi-select, remove container + image + project dir) -----------------------------------------------------------
async function uninstallProjects(currentProjectId?: string): Promise<boolean> {
    const projects = listProjects();

    if (projects.length === 0) {
        log.info("No registered projects.");
        return false;
    }

    // Show current project first if known
    const sorted = currentProjectId
        ? [...projects].sort((a, b) => (a.id === currentProjectId ? -1 : b.id === currentProjectId ? 1 : 0))
        : projects;

    const selected = await multiselect({
        message: "Select projects to uninstall:",
        options: sorted.map((p) => ({
            value: p.id,
            label: p.meta.displayName,
            hint: p.meta.projectRoot + (p.id === currentProjectId ? " (current)" : ""),
        })),
        required: false,
    });

    if (isCancel(selected)) {
        cancel();
        return false;
    }

    const selectedIds = selected as string[];

    for (const id of selectedIds) {
        const p = projects.find((x) => x.id === id);
        if (!p) continue;

        // Stop and remove container if it exists (running or exited)
        const psResult = spawnSync("docker", ["ps", "-a", "--filter", `name=${p.meta.containerName}`, "--format", "{{.Names}}"], {
            encoding: "utf8",
        });
        const containers = (psResult.stdout ?? "").trim().split("\n").filter(Boolean);
        for (const c of containers) {
            log.step(`Stopping and removing container ${c}...`);
            stopAndRemoveContainer(c);
        }

        // Remove Docker image if it exists (image name = container name)
        log.step(`Removing image ${p.meta.containerName}...`);
        spawnSync("docker", ["rmi", p.meta.containerName], { stdio: "inherit" });

        // Delete project directory
        rmSync(p.projectDir, { recursive: true, force: true });

        log.success(`Uninstalled project ${p.meta.displayName}.`);
    }

    return currentProjectId !== undefined && selectedIds.includes(currentProjectId);
}

// --- Uninstall totopo (global - wipes ~/.totopo/ and all containers/images) --------------------------------------------------------------
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
export async function run(packageDir: string, currentProjectId?: string): Promise<"back" | undefined> {
    while (true) {
        const action = await select({
            message: "Manage totopo:",
            options: [
                { value: "stop-containers", label: "Stop containers", hint: "pick running containers" },
                { value: "clear-memory", label: "Clear agent memory", hint: "pick projects to clear" },
                { value: "remove-images", label: "Remove images", hint: "pick images to remove" },
                { value: "reset-keys", label: "Reset API keys", hint: "overwrites ~/.totopo/.env" },
                { value: "doctor", label: "Doctor", hint: "check Docker health" },
                { value: "uninstall-project", label: "Uninstall project", hint: "pick projects to remove" },
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
            case "reset-keys":
                await resetApiKeys(packageDir);
                break;
            case "uninstall-project": {
                const currentDeleted = await uninstallProjects(currentProjectId);
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
