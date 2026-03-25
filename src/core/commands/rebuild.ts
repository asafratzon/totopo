// =========================================================================================================================================
// src/core/commands/rebuild.ts — Stop this project's container and remove its image to force a fresh build
// Invoked by bin/totopo.js — do not run directly.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { log } from "@clack/prompts";
import { toDockerName } from "../lib/docker-name.js";

export async function run(projectName: string): Promise<void> {
    const dockerName = toDockerName(projectName);
    const containerName = dockerName;
    const imageName = dockerName;

    // ─── Stop container if running ────────────────────────────────────────────────
    const inspectResult = spawnSync("docker", ["inspect", "--type", "container", containerName], { encoding: "utf8" });
    if (inspectResult.status === 0) {
        log.step(`Stopping container ${containerName}...`);
        spawnSync("docker", ["stop", containerName], { stdio: "inherit" });
        spawnSync("docker", ["rm", containerName], { stdio: "inherit" });
    }

    // ─── Remove image ─────────────────────────────────────────────────────────────
    const imageResult = spawnSync("docker", ["images", "-q", imageName], { encoding: "utf8" });
    if ((imageResult.stdout ?? "").trim().length > 0) {
        log.step(`Removing image ${imageName}...`);
        spawnSync("docker", ["rmi", imageName], { stdio: "inherit" });
    }

    log.info("Image removed — starting fresh build…");
}
