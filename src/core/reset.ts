#!/usr/bin/env node
// =========================================================================================================================================
// scripts/reset.ts — Full reset: delete all totopo workspaces and Docker images
// Called by ai.sh — do not run directly.
// Run 'npx totopo' → Start session after this to get a fresh build.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { log, outro } from "@clack/prompts";

// ─── Step 1: Find all totopo-managed-* DevPod workspaces ─────────────────────────────────────────────────────────────────────────────────
const listResult = spawnSync("devpod", ["list", "--output", "json"], {
    encoding: "utf8",
});

const workspaces: string[] = [];
if (listResult.stdout) {
    const matches = listResult.stdout.matchAll(/"id":"(totopo-managed-[^"]+)"/g);
    for (const match of matches) {
        if (match[1]) workspaces.push(match[1]);
    }
}

// ─── Step 2: Stop and delete all totopo workspaces ───────────────────────────────────────────────────────────────────────────────────────
if (workspaces.length === 0) {
    log.info("No totopo workspaces found.");
} else {
    log.step(`Stopping and deleting ${workspaces.length} workspace(s)...`);
    for (const ws of workspaces) {
        log.step(`  Removing ${ws}...`);
        spawnSync("devpod", ["stop", ws], { stdio: "inherit" });
        spawnSync("devpod", ["delete", ws, "--force"], { stdio: "inherit" });
    }
}

// ─── Step 3: Remove cached Docker images ─────────────────────────────────────────────────────────────────────────────────────────────────
// Images are identified via the LABEL totopo.managed=true baked into the
// Dockerfile template — works regardless of whether workspaces still exist.
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

// ─── Done ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
outro("Reset complete. Run 'npx totopo' and select 'Start session' to start fresh.");
