#!/usr/bin/env node
// =============================================================================
// scripts/reset.ts — Full reset: delete all totopo workspaces and Docker images
// Called by ai.sh — do not run directly.
// Run 'ai.sh' → Start session after this to get a fresh build.
// =============================================================================

import { spawnSync } from "node:child_process";
import { log, outro } from "@clack/prompts";

// ─── Step 1: Find all totopo-* DevPod workspaces ───────────────────────────────
const listResult = spawnSync("devpod", ["list", "--output", "json"], {
  encoding: "utf8",
});

const workspaces: string[] = [];
if (listResult.stdout) {
  const matches = listResult.stdout.matchAll(/"id":"(totopo-[^"]+)"/g);
  for (const match of matches) {
    if (match[1]) workspaces.push(match[1]);
  }
}

// ─── Step 2: Stop and delete all totopo workspaces ─────────────────────────────
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

// ─── Step 3: Remove cached Docker images ─────────────────────────────────────
// DevPod images are named vsc-<project>-<hash> (based on the folder name, not
// the workspace --id). For each totopo-<project> workspace, strip the "totopo-"
// prefix to get the image reference filter.
log.step("Removing cached Docker images...");

const allImageIds = new Set<string>();
for (const ws of workspaces) {
  const projectName = ws.replace(/^totopo-/, "");
  const findImages = spawnSync(
    "docker",
    [
      "images",
      "--filter",
      `reference=vsc-${projectName}-*`,
      "--format",
      "{{.ID}}",
    ],
    { encoding: "utf8" },
  );
  const ids = (findImages.stdout ?? "").trim().split("\n").filter(Boolean);
  for (const id of ids) allImageIds.add(id);
}

if (allImageIds.size > 0) {
  log.info(`  Found ${allImageIds.size} image(s) — removing...`);
  spawnSync("docker", ["rmi", "--force", ...allImageIds], { stdio: "inherit" });
} else {
  log.info("  No cached images found.");
}

spawnSync("docker", ["image", "prune", "--force"], { stdio: "inherit" });

// ─── Done ─────────────────────────────────────────────────────────────────────
outro("Reset complete. Run 'ai.sh' and select 'Start session' to start fresh.");
