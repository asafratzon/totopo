// =========================================================================================================================================
// src/commands/settings.ts - Settings submenu: runtime mode, shadow paths
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { confirm, isCancel, log, multiselect, note, path, select } from "@clack/prompts";
import { type RuntimeMode, readSettings, writeSettings } from "../lib/config.js";
import { detectHostRuntimes } from "../lib/detect-host.js";
import { generateDockerfile } from "../lib/generate-dockerfile.js";
import type { ProjectContext } from "../lib/project-identity.js";
import { TOTOPO_YAML } from "../lib/project-identity.js";
import { selectTools } from "../lib/select-tools.js";
import { ensureShadowsInSync } from "../lib/shadows.js";
import { addProjectAnchor } from "./onboard.js";

// --- Runtime mode menu -------------------------------------------------------------------------------------------------------------------
async function runtimeModeMenu(packageDir: string, ctx: ProjectContext): Promise<void> {
    const templatesDir = join(packageDir, "templates");
    const current = readSettings(ctx.projectDir);

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

    if (isCancel(modeChoice) || modeChoice === "back") return;

    const mode = modeChoice as RuntimeMode;

    if (mode === "host-mirror") {
        const hostRuntimes = detectHostRuntimes();
        const selectedTools = await selectTools(hostRuntimes);
        const dockerfile = generateDockerfile("host-mirror", templatesDir, selectedTools, hostRuntimes);
        writeFileSync(join(ctx.projectDir, "Dockerfile"), dockerfile);
        writeSettings(ctx.projectDir, { ...current, runtimeMode: "host-mirror", selectedTools });
    } else {
        cpSync(join(templatesDir, "Dockerfile"), join(ctx.projectDir, "Dockerfile"));
        writeSettings(ctx.projectDir, { ...current, runtimeMode: "full", selectedTools: [] });
    }

    log.info("Stop and restart your session to rebuild the container.");
}

// --- Shadow paths menu -------------------------------------------------------------------------------------------------------------------
async function shadowPathsMenu(ctx: ProjectContext): Promise<void> {
    const settings = readSettings(ctx.projectDir);

    if (settings.shadowPaths.length > 0) {
        note(settings.shadowPaths.map((p) => `  ${p}`).join("\n"), "Current shadow paths");
    } else {
        log.info("No shadow paths configured.");
    }

    log.message(
        "Shadow paths overlay host directories with empty container-local directories.\n" +
            "Use cases:\n" +
            "  - Separate node_modules so the container installs its own dependencies\n" +
            "    (useful when host/container run different OS)\n" +
            "  - Exclude sensitive files from being visible to agents (.env, credentials, etc.)",
    );

    const options: { value: string; label: string }[] = [{ value: "add", label: "Add path" }];
    if (settings.shadowPaths.length > 0) {
        options.push({ value: "remove", label: "Remove paths" });
    }
    options.push({ value: "back", label: "← Back" });

    const action = await select({ message: "Shadow paths:", options });

    if (isCancel(action) || action === "back") return;

    if (action === "add") {
        await addShadowPaths(ctx);
    } else if (action === "remove") {
        await removeShadowPaths(ctx);
    }
}

async function addShadowPaths(ctx: ProjectContext): Promise<void> {
    const updated = readSettings(ctx.projectDir);
    const paths = [...updated.shadowPaths];

    while (true) {
        const wantMore = await confirm({ message: paths.length === updated.shadowPaths.length ? "Add a shadow path?" : "Add another?" });
        if (isCancel(wantMore) || !wantMore) break;

        const selected = await path({
            message: "Path to shadow:",
            root: ctx.meta.projectRoot,
            directory: true,
        });
        if (isCancel(selected)) break;

        const absPath = (selected as string).trim();
        const rel = relative(ctx.meta.projectRoot, absPath);

        // Validate
        if (!rel || rel.startsWith("..")) {
            log.warn("Path must be inside the project directory. Skipped.");
            continue;
        }

        if (paths.includes(rel)) {
            log.warn(`"${rel}" is already in shadow paths. Skipped.`);
            continue;
        }

        paths.push(rel);
        log.info(`Added: ${rel}`);
    }

    const newPaths = paths.filter((p) => !updated.shadowPaths.includes(p));
    if (newPaths.length > 0) {
        updated.shadowPaths = paths;
        writeSettings(ctx.projectDir, updated);
        ensureShadowsInSync(ctx.projectDir, ctx.meta.projectRoot, new Set(newPaths));
        await promptRecreateContainer(ctx);
    }
}

async function removeShadowPaths(ctx: ProjectContext): Promise<void> {
    const updated = readSettings(ctx.projectDir);

    if (updated.shadowPaths.length === 0) {
        log.info("No shadow paths to remove.");
        return;
    }

    const toRemove = await multiselect({
        message: "Select paths to remove:",
        options: updated.shadowPaths.map((p) => ({ value: p, label: p })),
    });

    if (isCancel(toRemove)) return;

    const removeSet = new Set(toRemove as string[]);
    updated.shadowPaths = updated.shadowPaths.filter((p) => !removeSet.has(p));
    writeSettings(ctx.projectDir, updated);
    ensureShadowsInSync(ctx.projectDir, ctx.meta.projectRoot);
    await promptRecreateContainer(ctx);
}

// --- Prompt to recreate container now -----------------------------------------------------------------------------------------------------
async function promptRecreateContainer(ctx: ProjectContext): Promise<void> {
    const containerName = ctx.meta.containerName;

    // Check if container is running
    const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", containerName], {
        encoding: "utf8",
        stdio: "pipe",
    });
    const containerStatus = inspect.status === 0 ? inspect.stdout.trim() : null;

    if (containerStatus !== "running") {
        log.info("Changes will apply on next session.");
        return;
    }

    const stop = await confirm({ message: "Stop the running container so changes apply on next session?" });
    if (isCancel(stop) || !stop) {
        log.warn("Container still running with old shadow paths — it will be recreated on next session.");
        return;
    }

    log.step("Stopping container...");
    spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
    spawnSync("docker", ["rm", containerName], { stdio: "pipe" });
    log.info("Container removed. Open a new session to apply the new shadow paths.");
}

// --- Settings submenu (main entry point) -------------------------------------------------------------------------------------------------
export async function run(packageDir: string, ctx: ProjectContext): Promise<"back" | undefined> {
    while (true) {
        const hasTotopoYaml = existsSync(join(ctx.meta.projectRoot, TOTOPO_YAML));
        const options: { value: string; label: string; hint?: string }[] = [
            { value: "runtime-mode", label: "Runtime mode", hint: "host-mirror / full" },
            { value: "shadow-paths", label: "Shadow paths", hint: "hide paths from the container" },
            ...(!hasTotopoYaml
                ? [{ value: "add-anchor", label: "Add project anchor", hint: "create totopo.yaml for shared onboarding" }]
                : []),
            { value: "back", label: "← Back" },
        ];

        const action = await select({ message: "Settings:", options });

        if (isCancel(action) || action === "back") {
            return "back";
        }

        switch (action) {
            case "runtime-mode":
                await runtimeModeMenu(packageDir, ctx);
                break;
            case "shadow-paths":
                await shadowPathsMenu(ctx);
                break;
            case "add-anchor":
                await addProjectAnchor(ctx);
                break;
        }
    }
}
