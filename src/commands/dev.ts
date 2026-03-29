// =========================================================================================================================================
// src/commands/dev.ts - Start the dev container and connect via docker exec
// Invoked by bin/totopo.js - do not run directly.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { cancel, isCancel, log, outro, select } from "@clack/prompts";
import { buildAgentContextDocs, buildAgentMountArgs, injectAgentContext } from "../lib/agent-context.js";
import { readSettings } from "../lib/config.js";
import type { ProjectContext } from "../lib/project-identity.js";

// The project config dir is always mounted here inside the container (read-only)
const TOTOPO_CONTAINER_PATH = "/home/devuser/.totopo";

// --- Prompt: working directory selection -------------------------------------------------------------------------------------------------
async function promptWorkdir(workspaceDir: string, cwd: string): Promise<string> {
    if (cwd === workspaceDir) return "/workspace";
    const relPath = relative(workspaceDir, cwd);
    const choice = await select({
        message: "Start session:",
        options: [
            { value: "here", label: `Here  (./${relPath})` },
            { value: "root", label: "Repo root" },
        ],
    });
    if (isCancel(choice)) {
        cancel("Cancelled.");
        process.exit(0);
    }
    return choice === "here" ? `/workspace/${relPath}` : "/workspace";
}

// --- Build shadow mount args -------------------------------------------------------------------------------------------------------------
function buildShadowMountArgs(projectDir: string): { args: string[]; shadowPaths: string[] } {
    const settings = readSettings(projectDir);
    const shadowPaths = settings.shadowPaths;
    const args: string[] = [];

    for (const relPath of shadowPaths) {
        const hostDir = join(projectDir, "shadows", relPath);
        mkdirSync(hostDir, { recursive: true });
        args.push("-v", `${hostDir}:/workspace/${relPath}`);
    }

    return { args, shadowPaths };
}

// --- Build mount args --------------------------------------------------------------------------------------------------------------------
// Project config dir is always explicitly mounted - it's never inside the workspace.
function buildMountArgs(workspaceDir: string, projectDir: string): { mountArgs: string[]; shadowPaths: string[] } {
    const agentMounts = buildAgentMountArgs(projectDir);
    const configMount = ["-v", `${projectDir}:${TOTOPO_CONTAINER_PATH}:ro`];
    const { args: shadowArgs, shadowPaths } = buildShadowMountArgs(projectDir);
    // Shadow mounts must come AFTER the workspace mount to overlay correctly
    return {
        mountArgs: ["-v", `${workspaceDir}:/workspace`, ...shadowArgs, ...configMount, ...agentMounts],
        shadowPaths,
    };
}

// --- Run post-start ----------------------------------------------------------------------------------------------------------------------
function runPostStart(containerName: string): void {
    log.step("Running post-start checks...");
    const postStart = spawnSync("docker", ["exec", containerName, "node", `${TOTOPO_CONTAINER_PATH}/post-start.mjs`], {
        stdio: "inherit",
    });
    if (postStart.status !== 0) {
        outro("Post-start checks failed.");
        process.exit(postStart.status ?? 1);
    }
}

// --- Ensure global env file exists -------------------------------------------------------------------------------------------------------
function ensureGlobalEnvFile(): string {
    const globalTotopoDir = join(homedir(), ".totopo");
    const envFile = join(globalTotopoDir, ".env");
    mkdirSync(globalTotopoDir, { recursive: true });
    if (!existsSync(envFile)) {
        writeFileSync(envFile, "");
    }
    return envFile;
}

// --- Read container shadow label ---------------------------------------------------------------------------------------------------------
function readContainerShadowLabel(containerName: string): string {
    const result = spawnSync("docker", ["inspect", "--format", '{{index .Config.Labels "totopo.shadows"}}', containerName], {
        encoding: "utf8",
        stdio: "pipe",
    });
    if (result.status !== 0) return "";
    const val = result.stdout.trim();
    // Docker returns "<no value>" when label is missing
    return val === "<no value>" ? "" : val;
}

// --- Normalize shadow label --------------------------------------------------------------------------------------------------------------
function shadowLabel(paths: string[]): string {
    if (paths.length === 0) return "";
    return [...paths].sort().join(",");
}

// --- Stop and remove container -----------------------------------------------------------------------------------------------------------
function stopAndRemoveContainer(containerName: string): void {
    spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
    spawnSync("docker", ["rm", containerName], { stdio: "pipe" });
}

// --- Run container -----------------------------------------------------------------------------------------------------------------------
function runContainer(containerName: string, imageName: string, workspaceDir: string, projectDir: string): void {
    const envFile = ensureGlobalEnvFile();
    const { mountArgs, shadowPaths } = buildMountArgs(workspaceDir, projectDir);
    const labelArgs = ["--label", "totopo.managed=true", "--label", `totopo.shadows=${shadowLabel(shadowPaths)}`];
    const run = spawnSync(
        "docker",
        [
            "run",
            "-d",
            "--name",
            containerName,
            ...mountArgs,
            "--env-file",
            envFile,
            "--security-opt",
            "no-new-privileges:true",
            ...labelArgs,
            imageName,
            "sleep",
            "infinity",
        ],
        { stdio: "inherit" },
    );
    if (run.status !== 0) {
        outro("Failed to start dev container.");
        process.exit(run.status ?? 1);
    }
}

export async function run(_packageDir: string, ctx: ProjectContext): Promise<void> {
    const cwd = process.cwd();
    const workspaceDir = ctx.meta.projectRoot;
    const containerName = ctx.meta.containerName;
    const imageName = ctx.meta.containerName;
    const projectDir = ctx.projectDir;

    // --- Prompt for working directory ----------------------------------------------------------------------------------------------------
    const workdir = await promptWorkdir(workspaceDir, cwd);
    const hasGit = existsSync(join(workspaceDir, ".git"));
    const settings = readSettings(projectDir);
    const agentDocs = buildAgentContextDocs(hasGit, settings.shadowPaths);

    // --- Session start warning for shadow paths ------------------------------------------------------------------------------------------
    if (settings.shadowPaths.length > 0) {
        log.warn(`Shadow paths active: ${settings.shadowPaths.join(", ")}  (Settings > Shadow paths)`);
    }

    // --- Inspect container state ---------------------------------------------------------------------------------------------------------
    const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", containerName], {
        encoding: "utf8",
        stdio: "pipe",
    });

    let containerStatus = inspect.status === 0 ? inspect.stdout.trim() : null;

    // --- Check for shadow path mismatch --------------------------------------------------------------------------------------------------
    if (containerStatus !== null) {
        const currentLabel = readContainerShadowLabel(containerName);
        const expectedLabel = shadowLabel(settings.shadowPaths);
        if (currentLabel !== expectedLabel) {
            log.info("Shadow paths changed — recreating container...");
            stopAndRemoveContainer(containerName);
            containerStatus = null;
        }
    }

    if (containerStatus === null) {
        // --- No container - build image and run ------------------------------------------------------------------------------------------
        log.step("Building container image...");
        const build = spawnSync(
            "docker",
            ["build", "--label", "totopo.managed=true", "-f", join(projectDir, "Dockerfile"), "-t", imageName, projectDir],
            { stdio: "inherit" },
        );
        if (build.status !== 0) {
            outro("Failed to build container image.");
            process.exit(build.status ?? 1);
        }

        log.step("Preparing agent context...");
        injectAgentContext(projectDir, agentDocs);
        log.step("Starting dev container...");
        runContainer(containerName, imageName, workspaceDir, projectDir);
        runPostStart(containerName);
    } else if (containerStatus === "exited") {
        // --- Container stopped - resume --------------------------------------------------------------------------------------------------
        log.step("Preparing agent context...");
        injectAgentContext(projectDir, agentDocs);
        log.step("Resuming dev container...");
        const start = spawnSync("docker", ["start", containerName], { stdio: "inherit" });
        if (start.status !== 0) {
            outro("Failed to start dev container.");
            process.exit(start.status ?? 1);
        }
        runPostStart(containerName);
    } else {
        // --- Container running - refresh agent context and connect ------------------------------------------------------------------------
        log.step("Refreshing agent context...");
        injectAgentContext(projectDir, agentDocs);
    }

    // --- Connect -------------------------------------------------------------------------------------------------------------------------
    const exec = spawnSync("docker", ["exec", "-it", "-w", workdir, containerName, "bash", "--login"], {
        stdio: "inherit",
    });

    process.exit(exec.status ?? 0);
}
