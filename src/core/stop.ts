#!/usr/bin/env node
// =========================================================================================================================================
// scripts/stop.ts — Stop and remove all totopo dev containers
// Called by ai.sh — do not run directly.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { log, outro } from "@clack/prompts";

// ─── Find all totopo-managed-* containers ────────────────────────────────────
const listResult = spawnSync("docker", ["ps", "-a", "--filter", "name=totopo-managed-", "--format", "{{.Names}}"], { encoding: "utf8" });

const containers = (listResult.stdout ?? "").trim().split("\n").filter(Boolean);

if (containers.length === 0) {
    log.info("No totopo containers found.");
    process.exit(0);
}

// ─── Stop and remove each container ──────────────────────────────────────────
log.step("Stopping all totopo containers...");

for (const name of containers) {
    log.step(`Stopping ${name}...`);
    spawnSync("docker", ["stop", name], { stdio: "inherit" });
    spawnSync("docker", ["rm", name], { stdio: "inherit" });
}

outro("All totopo containers stopped and removed.");
