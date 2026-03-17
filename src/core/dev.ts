#!/usr/bin/env node
// =========================================================================================================================================
// scripts/dev.ts — Start the dev container and connect via docker exec
// Called by ai.sh — do not run directly.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { log, outro } from "@clack/prompts";

const workspaceDir = process.env.TOTOPO_REPO_ROOT;
if (!workspaceDir) {
    log.error("TOTOPO_REPO_ROOT not set — run via ai.sh");
    process.exit(1);
}

const projectName = basename(workspaceDir);
const containerName = `totopo-managed-${projectName}`;
const imageName = `totopo-managed-${projectName}`;

// ─── Inspect container state ─────────────────────────────────────────────────
const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", containerName], {
    encoding: "utf8",
    stdio: "pipe",
});

const containerStatus = inspect.status === 0 ? inspect.stdout.trim() : null;

if (containerStatus === null) {
    // ─── Container not found — build image then run ───────────────────────────
    log.step("Building container image...");
    const build = spawnSync("docker", ["build", "-f", `${workspaceDir}/.totopo/Dockerfile`, "-t", imageName, workspaceDir], {
        stdio: "inherit",
    });
    if (build.status !== 0) {
        outro("Failed to build container image.");
        process.exit(build.status ?? 1);
    }

    log.step("Starting dev container...");
    const run = spawnSync(
        "docker",
        [
            "run",
            "-d",
            "--name",
            containerName,
            "-v",
            `${workspaceDir}:/workspace`,
            "--env-file",
            `${workspaceDir}/.totopo/.env`,
            "--security-opt",
            "no-new-privileges:true",
            imageName,
        ],
        { stdio: "inherit" },
    );
    if (run.status !== 0) {
        outro("Failed to start dev container.");
        process.exit(run.status ?? 1);
    }

    // Run post-start after fresh container start
    log.step("Running post-start checks...");
    const postStart = spawnSync("docker", ["exec", containerName, "node", "/workspace/.totopo/post-start.mjs"], {
        stdio: "inherit",
    });
    if (postStart.status !== 0) {
        outro("Post-start checks failed.");
        process.exit(postStart.status ?? 1);
    }
} else if (containerStatus === "exited") {
    // ─── Container stopped — restart it ──────────────────────────────────────
    log.step("Resuming dev container...");
    const start = spawnSync("docker", ["start", containerName], { stdio: "inherit" });
    if (start.status !== 0) {
        outro("Failed to start dev container.");
        process.exit(start.status ?? 1);
    }

    // Run post-start after resume
    log.step("Running post-start checks...");
    const postStart = spawnSync("docker", ["exec", containerName, "node", "/workspace/.totopo/post-start.mjs"], {
        stdio: "inherit",
    });
    if (postStart.status !== 0) {
        outro("Post-start checks failed.");
        process.exit(postStart.status ?? 1);
    }
} else {
    // ─── Container already running — connect directly ─────────────────────────
    log.step("Connecting to running container...");
}

// ─── Connect ─────────────────────────────────────────────────────────────────
const exec = spawnSync("docker", ["exec", "-it", "-w", "/workspace", containerName, "bash", "--login"], {
    stdio: "inherit",
});

process.exit(exec.status ?? 0);
