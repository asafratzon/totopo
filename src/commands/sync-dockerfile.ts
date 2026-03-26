// =========================================================================================================================================
// src/commands/sync-dockerfile.ts - Silent pre-flight: re-detect host runtimes and
// regenerate ~/.totopo/projects/<id>/Dockerfile if stale (host-mirror mode only).
// Invoked by bin/totopo.js on every invocation after onboarding.
// =========================================================================================================================================

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { readSettings } from "../lib/config.js";
import { detectHostRuntimes } from "../lib/detect-host.js";
import { generateDockerfile } from "../lib/generate-dockerfile.js";
import type { ProjectContext } from "../lib/project-identity.js";

export async function run(packageDir: string, ctx: ProjectContext): Promise<void> {
    const settings = readSettings(ctx.projectDir);

    // Full mode: nothing to sync
    if (settings.runtimeMode !== "host-mirror") {
        return;
    }

    const templatesDir = join(packageDir, "templates");
    const hostRuntimes = detectHostRuntimes();
    const newContent = generateDockerfile("host-mirror", templatesDir, settings.selectedTools, hostRuntimes);

    const dockerfilePath = join(ctx.projectDir, "Dockerfile");
    const currentContent = existsSync(dockerfilePath) ? readFileSync(dockerfilePath, "utf8") : "";

    const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

    if (sha256(newContent) !== sha256(currentContent)) {
        writeFileSync(dockerfilePath, newContent);
        log.warn("Host runtimes changed — container will rebuild on next start");
    }
}
