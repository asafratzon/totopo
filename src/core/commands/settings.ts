#!/usr/bin/env node
// =============================================================================
// src/core/commands/settings.ts — Settings menu: switch runtime mode + tool selection
// Invoked by bin/totopo.js when action === "settings".
// =============================================================================

import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cancel, intro, isCancel, log, outro, select } from "@clack/prompts";
import { type RuntimeMode, readSettings, writeSettings } from "../lib/config.ts";
import { detectHostRuntimes } from "../lib/detect-host.ts";
import { generateDockerfile } from "../lib/generate-dockerfile.ts";
import { selectTools } from "../lib/select-tools.ts";

const packageDir = process.env.TOTOPO_PACKAGE_DIR;
const repoRoot = process.env.TOTOPO_REPO_ROOT;

if (!packageDir || !repoRoot) {
    log.error("TOTOPO_PACKAGE_DIR / TOTOPO_REPO_ROOT not set — run via npx totopo");
    process.exit(1);
}

const totopoDir = join(repoRoot, ".totopo");
const templatesDir = join(packageDir, "templates");
const current = readSettings(totopoDir);

intro("totopo — Settings");

// ─── Mode selection ──────────────────────────────────────────────────────────
const hostMirrorOption =
    current.runtimeMode === "host-mirror"
        ? { value: "host-mirror" as const, label: "Host-mirror  (match host runtimes)", hint: "current" }
        : { value: "host-mirror" as const, label: "Host-mirror  (match host runtimes)" };
const fullOption =
    current.runtimeMode === "full"
        ? { value: "full" as const, label: "Full  (latest stable — all tools)", hint: "current" }
        : { value: "full" as const, label: "Full  (latest stable — all tools)" };

const modeChoice = await select({
    message: "Runtime mode:",
    options: [hostMirrorOption, fullOption],
});

if (isCancel(modeChoice)) {
    cancel("Cancelled.");
    process.exit(0);
}

const mode = modeChoice as RuntimeMode;

if (mode === "host-mirror") {
    const hostRuntimes = detectHostRuntimes();
    const selectedTools = await selectTools(hostRuntimes);
    const dockerfile = generateDockerfile("host-mirror", templatesDir, selectedTools, hostRuntimes);
    writeFileSync(join(totopoDir, "Dockerfile"), dockerfile);
    writeSettings(totopoDir, { runtimeMode: "host-mirror", selectedTools });
} else {
    // full mode — restore the unmodified template Dockerfile
    cpSync(join(templatesDir, "Dockerfile"), join(totopoDir, "Dockerfile"));
    writeSettings(totopoDir, { runtimeMode: "full", selectedTools: [] });
}

log.info("Stop and restart your session to rebuild the container.");
outro("Settings saved.");
