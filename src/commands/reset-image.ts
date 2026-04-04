// =========================================================================================================================================
// src/commands/reset-image.ts - Stop this workspace's container and remove its image so the next session rebuilds fresh
// Invoked by bin/totopo.js - do not run directly.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { log } from "@clack/prompts";

export async function run(containerName: string): Promise<void> {
    const imageName = containerName;

    // --- Stop container if running -------------------------------------------------------------------------------------------------------
    const inspectResult = spawnSync("docker", ["inspect", "--type", "container", containerName], {
        encoding: "utf8",
        stdio: "pipe",
    });
    if (inspectResult.status === 0) {
        log.step(`Stopping container ${containerName}...`);
        spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
        spawnSync("docker", ["rm", containerName], { stdio: "pipe" });
    }

    // --- Remove image --------------------------------------------------------------------------------------------------------------------
    const imageResult = spawnSync("docker", ["images", "-q", imageName], { encoding: "utf8", stdio: "pipe" });
    if ((imageResult.stdout ?? "").trim().length > 0) {
        log.step(`Removing image ${imageName}...`);
        spawnSync("docker", ["rmi", imageName], { stdio: "pipe" });
    }

    log.info("Image removed — starting fresh build…");
}
