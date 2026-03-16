#!/usr/bin/env node
// =============================================================================
// src/core/sync-dockerfile.ts — silent pre-flight: re-detect host runtimes and
// regenerate .totopo/Dockerfile if stale (host-mirror mode only).
// Called by ai.sh on every invocation, after onboarding.
// =============================================================================

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { detectHostRuntimes } from "./detect-host.ts";
import { generateDockerfile } from "./generate-dockerfile.ts";
import { readSettings } from "./settings.ts";

const packageDir = process.env.TOTOPO_PACKAGE_DIR;
const repoRoot = process.env.TOTOPO_REPO_ROOT;

if (!packageDir || !repoRoot) {
    // Not called via ai.sh — silently exit
    process.exit(0);
}

const totopoDir = join(repoRoot, ".totopo");
const settings = readSettings(totopoDir);

// Full mode: nothing to sync
if (settings.runtimeMode !== "host-mirror") {
    process.exit(0);
}

const templatesDir = join(packageDir, "templates");
const hostRuntimes = detectHostRuntimes();
const newContent = generateDockerfile("host-mirror", templatesDir, settings.selectedTools, hostRuntimes);

const dockerfilePath = join(totopoDir, "Dockerfile");
const currentContent = existsSync(dockerfilePath) ? readFileSync(dockerfilePath, "utf8") : "";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

if (sha256(newContent) !== sha256(currentContent)) {
    writeFileSync(dockerfilePath, newContent);
    log.warn("Host runtimes changed — container will rebuild on next start");
}
