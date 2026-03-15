#!/usr/bin/env node
// =============================================================================
// scripts/dev.ts — Start the dev container and SSH in
// Called by ai.sh — do not run directly.
// =============================================================================

import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { log, outro } from "@clack/prompts";

const workspaceDir = process.env.TOTOPO_REPO_ROOT;
if (!workspaceDir) {
	log.error("TOTOPO_REPO_ROOT not set — run via ai.sh");
	process.exit(1);
}

const workspaceName = `totopo-${basename(workspaceDir)}`;

// Always run devpod up — it's idempotent (starts if stopped, no-op if running)
log.step("Starting dev container...");
const up = spawnSync(
	"devpod",
	[
		"up",
		workspaceDir,
		"--devcontainer-path",
		".totopo/devcontainer.json",
		"--ide",
		"none",
		"--id",
		workspaceName,
	],
	{ stdio: "inherit" },
);
if (up.status !== 0) {
	outro("Failed to start dev container.");
	process.exit(up.status ?? 1);
}
log.step("Connecting via SSH...");

const ssh = spawnSync(
	"devpod",
	["ssh", workspaceName, "--workdir", "/workspace"],
	{
		stdio: "inherit",
	},
);

process.exit(ssh.status ?? 0);
