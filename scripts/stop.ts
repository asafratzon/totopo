#!/usr/bin/env node
// =============================================================================
// scripts/stop.ts — Stop and remove all totopo dev container workspaces
// Called by ai.sh — do not run directly.
// =============================================================================

import { spawnSync } from "node:child_process";
import { log, outro } from "@clack/prompts";

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

if (workspaces.length === 0) {
  log.info("No totopo workspaces found.");
  process.exit(0);
}

log.step("Stopping all totopo workspaces...");

for (const ws of workspaces) {
  log.step(`Stopping ${ws}...`);
  spawnSync("devpod", ["stop", ws], { stdio: "inherit" });
  spawnSync("devpod", ["delete", ws, "--force"], { stdio: "inherit" });
}

outro("All totopo workspaces stopped and removed.");
