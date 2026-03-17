#!/usr/bin/env node
// =========================================================================================================================================
// scripts/reset.ts — Full reset: delete all totopo containers and Docker images
// Called by ai.sh — do not run directly.
// Run 'npx totopo' → Start session after this to get a fresh build.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { log, outro } from "@clack/prompts";

// ─── Step 1: Find all totopo-managed-* containers ────────────────────────────
const listResult = spawnSync(
    "docker",
    ["ps", "-a", "--filter", "name=totopo-managed-", "--format", "{{.Names}}"],
    { encoding: "utf8" },
);

const containers = (listResult.stdout ?? "").trim().split("\n").filter(Boolean);

// ─── Step 2: Stop and remove all totopo containers ───────────────────────────
if (containers.length === 0) {
    log.info("No totopo containers found.");
} else {
    log.step(`Stopping and removing ${containers.length} container(s)...`);
    for (const name of containers) {
        log.step(`  Removing ${name}...`);
        spawnSync("docker", ["stop", name], { stdio: "inherit" });
        spawnSync("docker", ["rm", name], { stdio: "inherit" });
    }
}

// ─── Step 3: Remove cached Docker images ─────────────────────────────────────
// Images are identified via the LABEL totopo.managed=true baked into the
// Dockerfile template — works regardless of whether containers still exist.
log.step("Removing cached Docker images...");

const findImages = spawnSync("docker", ["images", "--filter", "label=totopo.managed=true", "--format", "{{.ID}}"], { encoding: "utf8" });
const imageIds = (findImages.stdout ?? "").trim().split("\n").filter(Boolean);

if (imageIds.length > 0) {
    log.info(`  Found ${imageIds.length} image(s) — removing...`);
    spawnSync("docker", ["rmi", "--force", ...imageIds], { stdio: "inherit" });
} else {
    log.info("  No cached images found.");
}

spawnSync("docker", ["image", "prune", "--force"], { stdio: "inherit" });

// ─── Done ────────────────────────────────────────────────────────────────────
outro("Reset complete. Run 'npx totopo' and select 'Start session' to start fresh.");
