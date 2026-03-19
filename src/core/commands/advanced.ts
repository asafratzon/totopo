// =========================================================================================================================================
// src/core/commands/advanced.ts — Advanced submenu
// Invoked by bin/totopo.js — do not run directly.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cancel, confirm, isCancel, log, multiselect, outro, select } from "@clack/prompts";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function stopAndRemoveContainer(name: string) {
    spawnSync("docker", ["stop", name], { stdio: "inherit" });
    spawnSync("docker", ["rm", name], { stdio: "inherit" });
}

// ─── Clear agent memory ───────────────────────────────────────────────────────
async function clearAgentMemory(projectName: string, totopoDir: string): Promise<void> {
    const containerName = `totopo-managed-${projectName}`;

    // Check if the container is running
    const inspectResult = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", containerName], {
        encoding: "utf8",
        stdio: "pipe",
    });
    const isRunning = inspectResult.status === 0 && inspectResult.stdout.trim() === "running";

    if (isRunning) {
        const confirmed = await confirm({
            message: `The dev container for ${projectName} is running. It must be stopped to clear agent memory. Continue?`,
        });
        if (isCancel(confirmed) || !confirmed) {
            cancel("Cancelled.");
            return;
        }
        log.step(`Stopping ${containerName}...`);
        stopAndRemoveContainer(containerName);
    }

    const agentsDir = join(totopoDir, "agents");
    if (existsSync(agentsDir)) {
        rmSync(agentsDir, { recursive: true, force: true });
    }
    log.success("Agent memory cleared. Context will be regenerated on next session start.");
}

// ─── Stop containers ──────────────────────────────────────────────────────────
async function stopContainers(): Promise<void> {
    const listResult = spawnSync("docker", ["ps", "--filter", "name=totopo-managed-", "--format", "{{.Names}}"], {
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
        log.info(`Stopping ${running[0]}...`);
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

// ─── Remove images ────────────────────────────────────────────────────────────
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
        const [repo, id] = line.split("\t");
        const workspace = (repo ?? "").replace(/^totopo-managed-/, "");
        return { repo: repo ?? "", id: id ?? "", workspace };
    });

    const selected = await multiselect({
        message: "Select images to remove:",
        options: images.map((img) => ({
            value: img.repo,
            label: `${img.workspace}  (${img.repo})`,
        })),
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

// ─── Uninstall ────────────────────────────────────────────────────────────────
async function uninstall(projectName: string, repoRoot: string): Promise<void> {
    const containerName = `totopo-managed-${projectName}`;
    const imageName = `totopo-managed-${projectName}`;

    const confirmed = await confirm({
        message: `Remove .totopo/, stop containers, and delete the image for ${projectName}?`,
    });

    if (isCancel(confirmed) || !confirmed) {
        cancel();
        return;
    }

    const inspectResult = spawnSync("docker", ["inspect", "--type", "container", containerName], { encoding: "utf8" });
    if (inspectResult.status === 0) {
        log.step(`Stopping container ${containerName}...`);
        stopAndRemoveContainer(containerName);
    }

    const imageResult = spawnSync("docker", ["images", "-q", imageName], { encoding: "utf8" });
    if ((imageResult.stdout ?? "").trim().length > 0) {
        log.step(`Removing image ${imageName}...`);
        spawnSync("docker", ["rmi", imageName], { stdio: "inherit" });
    }

    log.step("Removing .totopo/...");
    rmSync(join(repoRoot, ".totopo"), { recursive: true, force: true });

    outro("Uninstalled. Re-run npx totopo to set up again.");
}

// ─── Advanced submenu ─────────────────────────────────────────────────────────
export async function run(packageDir: string, projectName: string, repoRoot: string): Promise<"back" | undefined> {
    // Dynamic imports to avoid circular deps — same pattern as bin/totopo.js
    const { run: runSettings } = await import("./settings.js");
    const { run: runRebuild } = await import("./rebuild.js");
    const { run: runDoctor } = await import("./doctor.js");

    const totopoDir = join(repoRoot, ".totopo");

    while (true) {
        const action = await select({
            message: "Advanced:",
            options: [
                { value: "runtime-mode", label: "Runtime mode" },
                { value: "rebuild", label: "Rebuild container" },
                { value: "clear-memory", label: "Clear agent memory" },
                { value: "uninstall", label: "Uninstall from this project" },
                { value: "doctor", label: "Doctor" },
                { value: "stop-containers", label: "Stop containers", hint: "all projects" },
                { value: "remove-images", label: "Remove images", hint: "all projects" },
                { value: "back", label: "← Back" },
            ],
        });

        if (isCancel(action) || action === "back") {
            return "back";
        }

        switch (action) {
            case "runtime-mode":
                await runSettings(packageDir, repoRoot);
                break;
            case "rebuild":
                await runRebuild(projectName);
                break;
            case "clear-memory":
                await clearAgentMemory(projectName, totopoDir);
                break;
            case "uninstall":
                await uninstall(projectName, repoRoot);
                return; // uninstall tears down .totopo — exit entirely
            case "doctor":
                await runDoctor(repoRoot, true);
                break;
            case "stop-containers":
                await stopContainers();
                break;
            case "remove-images":
                await removeImages();
                break;
        }
    }
}
