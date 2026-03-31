// =========================================================================================================================================
// src/commands/dev.ts - Start the dev container and connect via docker exec
// In-memory Dockerfile build, profile selection, pattern-based shadows, env_file handling.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { cancel, isCancel, log, outro, select } from "@clack/prompts";
import { buildAgentContextDocs, buildAgentMountArgs, injectAgentContext } from "../lib/agent-context.js";
import { buildDockerfile, buildImageWithTempfile } from "../lib/dockerfile-builder.js";
import type { ProjectContext } from "../lib/project-identity.js";
import { readActiveProfile, writeActiveProfile } from "../lib/project-identity.js";
import { buildShadowMountArgs, ensureShadowsInSync, expandShadowPatterns } from "../lib/shadows.js";
import { readTotopoYaml } from "../lib/totopo-yaml.js";

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

// --- Profile selection -------------------------------------------------------------------------------------------------------------------
async function selectProfile(ctx: ProjectContext, profiles: Record<string, unknown>): Promise<string> {
    const profileNames = Object.keys(profiles);
    if (profileNames.length <= 1) {
        return profileNames[0] ?? "default";
    }

    const currentProfile = readActiveProfile(ctx.projectId) ?? "default";

    const choice = await select({
        message: "Profile:",
        options: profileNames.map((name) => {
            const opt: { value: string; label: string; hint?: string } = { value: name, label: name };
            if (name === currentProfile) opt.hint = "current";
            return opt;
        }),
        initialValue: currentProfile,
    });

    if (isCancel(choice)) {
        cancel("Cancelled.");
        process.exit(0);
    }

    const selected = choice as string;
    if (selected !== currentProfile) {
        writeActiveProfile(ctx.projectId, selected);
    }
    return selected;
}

// --- Read container label ----------------------------------------------------------------------------------------------------------------
function readContainerLabel(containerName: string, label: string): string {
    const result = spawnSync("docker", ["inspect", "--format", `{{index .Config.Labels "${label}"}}`, containerName], {
        encoding: "utf8",
        stdio: "pipe",
    });
    if (result.status !== 0) return "";
    const val = result.stdout.trim();
    return val === "<no value>" ? "" : val;
}

// --- Shadow label ------------------------------------------------------------------------------------------------------------------------
function shadowLabel(paths: string[]): string {
    if (paths.length === 0) return "";
    return [...paths].sort().join(",");
}

// --- Stop and remove container -----------------------------------------------------------------------------------------------------------
function stopAndRemoveContainer(containerName: string): void {
    spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
    spawnSync("docker", ["rm", containerName], { stdio: "pipe" });
}

// --- Run post-start ----------------------------------------------------------------------------------------------------------------------
function runPostStart(containerName: string): void {
    log.step("Running post-start checks...");
    const postStart = spawnSync("docker", ["exec", containerName, "node", "/home/devuser/post-start.mjs"], {
        stdio: "inherit",
    });
    if (postStart.status !== 0) {
        outro("Post-start checks failed.");
        process.exit(postStart.status ?? 1);
    }
}

// --- Main --------------------------------------------------------------------------------------------------------------------------------
export async function run(packageDir: string, ctx: ProjectContext): Promise<void> {
    const cwd = process.cwd();
    const workspaceDir = ctx.projectRoot;
    const containerName = ctx.containerName;
    const projectDir = ctx.projectDir;
    const templatesDir = join(packageDir, "templates");

    // --- Read totopo.yaml ----------------------------------------------------------------------------------------------------------------
    const yaml = readTotopoYaml(workspaceDir);
    if (!yaml) {
        log.error("totopo.yaml not found or invalid.");
        process.exit(1);
    }

    // --- Prompt for working directory ----------------------------------------------------------------------------------------------------
    const workdir = await promptWorkdir(workspaceDir, cwd);

    // --- Profile selection ---------------------------------------------------------------------------------------------------------------
    const profiles = yaml.profiles ?? {};
    const activeProfile = await selectProfile(ctx, profiles);
    const profileConfig = profiles[activeProfile];
    const profileHook = profileConfig?.dockerfile_hook;

    // --- Shadow path expansion -----------------------------------------------------------------------------------------------------------
    const shadowPatterns = yaml.shadow_paths ?? [];
    const expandedShadows = expandShadowPatterns(shadowPatterns, workspaceDir);

    if (expandedShadows.length > 0) {
        log.warn(`Shadow paths active: ${expandedShadows.join(", ")}  (Settings > Shadow paths)`);
    }

    // --- Sync shadows and build mount args ------------------------------------------------------------------------------------------------
    ensureShadowsInSync(projectDir, expandedShadows, workspaceDir);
    const shadowMountArgs = buildShadowMountArgs(projectDir, expandedShadows);

    // --- Agent context -------------------------------------------------------------------------------------------------------------------
    const hasGit = existsSync(join(workspaceDir, ".git"));
    const agentDocs = buildAgentContextDocs(hasGit, shadowPatterns);

    // --- Env file ------------------------------------------------------------------------------------------------------------------------
    const envFileArgs: string[] = [];
    if (yaml.env_file) {
        const envFilePath = join(workspaceDir, yaml.env_file);
        if (existsSync(envFilePath)) {
            envFileArgs.push("--env-file", envFilePath);
        } else {
            log.warn(`env_file "${yaml.env_file}" not found — skipping`);
        }
    }

    // --- Build mount args ----------------------------------------------------------------------------------------------------------------
    const agentMounts = buildAgentMountArgs(projectDir);
    // Shadow mounts must come AFTER the workspace mount to overlay correctly
    const mountArgs = ["-v", `${workspaceDir}:/workspace`, ...shadowMountArgs, ...agentMounts];

    // --- Container labels ----------------------------------------------------------------------------------------------------------------
    const labelArgs = [
        "--label",
        "totopo.managed=true",
        "--label",
        `totopo.shadows=${shadowLabel(expandedShadows)}`,
        "--label",
        `totopo.profile=${activeProfile}`,
    ];

    // --- Inspect container state ---------------------------------------------------------------------------------------------------------
    const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", containerName], {
        encoding: "utf8",
        stdio: "pipe",
    });

    let containerStatus = inspect.status === 0 ? inspect.stdout.trim() : null;

    // --- Check for shadow or profile mismatch --------------------------------------------------------------------------------------------
    if (containerStatus !== null) {
        const currentShadowLabel = readContainerLabel(containerName, "totopo.shadows");
        const expectedShadowLabel = shadowLabel(expandedShadows);
        const currentProfileLabel = readContainerLabel(containerName, "totopo.profile");

        const shadowChanged = currentShadowLabel !== expectedShadowLabel;
        const profileChanged = currentProfileLabel !== activeProfile;

        if (shadowChanged || profileChanged) {
            stopAndRemoveContainer(containerName);
            containerStatus = null;

            if (profileChanged) {
                // Profile change means different Dockerfile - must rebuild image
                log.info(`Profile changed (${currentProfileLabel} → ${activeProfile}) — rebuilding...`);
                spawnSync("docker", ["rmi", containerName], { stdio: "pipe" });
            } else {
                log.info("Shadow paths changed — recreating container...");
            }
        }
    }

    if (containerStatus === null) {
        // --- No container - build image and run ------------------------------------------------------------------------------------------
        log.step("Building container image...");
        const dockerfileContent = buildDockerfile(join(templatesDir, "Dockerfile"), profileHook);
        const buildResult = buildImageWithTempfile(dockerfileContent, templatesDir, containerName);
        if (buildResult.status !== 0) {
            outro("Failed to build container image.");
            process.exit(buildResult.status);
        }

        log.step("Preparing agent context...");
        injectAgentContext(projectDir, agentDocs);
        log.step("Starting dev container...");

        const run = spawnSync(
            "docker",
            [
                "run",
                "-d",
                "--name",
                containerName,
                ...mountArgs,
                ...envFileArgs,
                "--security-opt",
                "no-new-privileges:true",
                ...labelArgs,
                containerName,
                "sleep",
                "infinity",
            ],
            { stdio: "inherit" },
        );
        if (run.status !== 0) {
            outro("Failed to start dev container.");
            process.exit(run.status ?? 1);
        }
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
