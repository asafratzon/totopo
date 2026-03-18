#!/usr/bin/env node
// =========================================================================================================================================
// src/core/commands/stop.ts — Stop and remove THIS project's dev container
// Invoked by bin/totopo.js — do not run directly.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { cancel, confirm, isCancel, log, outro } from "@clack/prompts";

const [projectName = "unknown"] = process.argv.slice(2);
const containerName = `totopo-managed-${projectName}`;

// ─── Check if container exists ────────────────────────────────────────────────
const inspectResult = spawnSync("docker", ["inspect", "--type", "container", containerName], { encoding: "utf8" });

if (inspectResult.status !== 0) {
    log.info(`Container ${containerName} is not running.`);
    process.exit(0);
}

// ─── Confirm ─────────────────────────────────────────────────────────────────
const confirmed = await confirm({ message: `Stop ${containerName}?` });

if (isCancel(confirmed) || !confirmed) {
    cancel();
    process.exit(0);
}

// ─── Stop and remove ─────────────────────────────────────────────────────────
log.step(`Stopping ${containerName}...`);
spawnSync("docker", ["stop", containerName], { stdio: "inherit" });
spawnSync("docker", ["rm", containerName], { stdio: "inherit" });

outro(`${containerName} stopped and removed.`);
