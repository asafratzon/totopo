// =========================================================================================================================================
// src/commands/rebuild.ts - Stop this project's container and remove its image to force a fresh build
// Invoked by bin/totopo.js - do not run directly.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { log } from "@clack/prompts";

export async function run(containerName: string): Promise<void> {
    const imageName = containerName;

    // --- Stop container if running -------------------------------------------------------------------------------------------------------
    const inspectResult = spawnSync("docker", ["inspect", "--type", "container", containerName], { encoding: "utf8" });
    if (inspectResult.status === 0) {
        log.step(`Stopping container ${containerName}...`);
        spawnSync("docker", ["stop", containerName], { stdio: "inherit" });
        spawnSync("docker", ["rm", containerName], { stdio: "inherit" });
    }

    // --- Remove image --------------------------------------------------------------------------------------------------------------------
    const imageResult = spawnSync("docker", ["images", "-q", imageName], { encoding: "utf8" });
    if ((imageResult.stdout ?? "").trim().length > 0) {
        log.step(`Removing image ${imageName}...`);
        spawnSync("docker", ["rmi", imageName], { stdio: "inherit" });
    }

    log.info("Image removed — starting fresh build…");
}
