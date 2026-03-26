// =========================================================================================================================================
// src/commands/settings.ts - Settings menu: switch runtime mode + tool selection
// =========================================================================================================================================

import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cancel, intro, isCancel, log, outro, select } from "@clack/prompts";
import { type RuntimeMode, readSettings, writeSettings } from "../lib/config.js";
import { detectHostRuntimes } from "../lib/detect-host.js";
import { generateDockerfile } from "../lib/generate-dockerfile.js";
import type { ProjectContext } from "../lib/project-identity.js";
import { selectTools } from "../lib/select-tools.js";

export async function run(packageDir: string, ctx: ProjectContext): Promise<"back" | undefined> {
    const templatesDir = join(packageDir, "templates");
    const current = readSettings(ctx.projectDir);

    intro("totopo — Settings");

    // --- Mode selection ------------------------------------------------------------------------------------------------------------------
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
        options: [hostMirrorOption, fullOption, { value: "back" as const, label: "← Back" }],
    });

    if (isCancel(modeChoice)) {
        cancel("Cancelled.");
        return "back";
    }

    if (modeChoice === "back") {
        return "back";
    }

    const mode = modeChoice as RuntimeMode;

    if (mode === "host-mirror") {
        const hostRuntimes = detectHostRuntimes();
        const selectedTools = await selectTools(hostRuntimes);
        const dockerfile = generateDockerfile("host-mirror", templatesDir, selectedTools, hostRuntimes);
        writeFileSync(join(ctx.projectDir, "Dockerfile"), dockerfile);
        writeSettings(ctx.projectDir, { runtimeMode: "host-mirror", selectedTools });
    } else {
        // Full mode - restore the unmodified template Dockerfile
        cpSync(join(templatesDir, "Dockerfile"), join(ctx.projectDir, "Dockerfile"));
        writeSettings(ctx.projectDir, { runtimeMode: "full", selectedTools: [] });
    }

    log.info("Stop and restart your session to rebuild the container.");
    outro("Settings saved.");
}
