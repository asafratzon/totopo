// =========================================================================================================================================
// src/core/commands/manage.ts — Manage workspaces submenu
// Invoked by bin/totopo.js — do not run directly.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { cancel, confirm, isCancel, log, multiselect, outro, select } from "@clack/prompts";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function stopAndRemoveContainer(name: string) {
    spawnSync("docker", ["stop", name], { stdio: "inherit" });
    spawnSync("docker", ["rm", name], { stdio: "inherit" });
}

export async function run(projectName: string, repoRoot: string): Promise<"back" | undefined> {
    // ─── Submenu ─────────────────────────────────────────────────────────────────
    const action = await select({
        message: "Manage workspaces:",
        options: [
            { value: "stop-containers", label: "Stop running containers" },
            { value: "remove-images", label: "Remove images" },
            { value: "uninstall", label: "Uninstall from this project" },
            { value: "back", label: "← Back" },
        ],
    });

    if (isCancel(action) || action === "back") {
        return "back";
    }

    // ─── A: Stop running containers ───────────────────────────────────────────────
    if (action === "stop-containers") {
        const listResult = spawnSync("docker", ["ps", "--filter", "name=totopo-managed-", "--format", "{{.Names}}"], { encoding: "utf8" });
        const running = (listResult.stdout ?? "").trim().split("\n").filter(Boolean);

        if (running.length === 0) {
            log.info("No running containers.");
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
        outro("Done.");
    }

    // ─── B: Remove images ─────────────────────────────────────────────────────────
    else if (action === "remove-images") {
        const listResult = spawnSync(
            "docker",
            ["images", "--filter", "label=totopo.managed=true", "--format", "{{.Repository}}\t{{.ID}}"],
            {
                encoding: "utf8",
            },
        );
        const lines = (listResult.stdout ?? "").trim().split("\n").filter(Boolean);

        if (lines.length === 0) {
            log.info("No images found.");
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

        const toRemove = selected as string[];

        for (const repo of toRemove) {
            // Stop any running container that uses this image
            const psResult = spawnSync("docker", ["ps", "--filter", `name=${repo}`, "--format", "{{.Names}}"], { encoding: "utf8" });
            const containers = (psResult.stdout ?? "").trim().split("\n").filter(Boolean);
            for (const c of containers) {
                log.step(`Stopping container ${c} before removing image...`);
                stopAndRemoveContainer(c);
            }
            log.step(`Removing image ${repo}...`);
            spawnSync("docker", ["rmi", repo], { stdio: "inherit" });
        }
        outro("Done.");
    }

    // ─── C: Uninstall from this project ───────────────────────────────────────────
    else if (action === "uninstall") {
        const containerName = `totopo-managed-${projectName}`;
        const imageName = `totopo-managed-${projectName}`;

        const confirmed = await confirm({
            message: `Remove .totopo/, stop containers, and delete the image for ${projectName}?`,
        });

        if (isCancel(confirmed) || !confirmed) {
            cancel();
            return;
        }

        // Stop container if running
        const inspectResult = spawnSync("docker", ["inspect", "--type", "container", containerName], { encoding: "utf8" });
        if (inspectResult.status === 0) {
            log.step(`Stopping container ${containerName}...`);
            stopAndRemoveContainer(containerName);
        }

        // Remove image if exists
        const imageResult = spawnSync("docker", ["images", "-q", imageName], { encoding: "utf8" });
        if ((imageResult.stdout ?? "").trim().length > 0) {
            log.step(`Removing image ${imageName}...`);
            spawnSync("docker", ["rmi", imageName], { stdio: "inherit" });
        }

        // Delete .totopo/
        log.step("Removing .totopo/...");
        rmSync(join(repoRoot, ".totopo"), { recursive: true, force: true });

        outro("Uninstalled. Re-run npx totopo to set up again.");
    }
}
