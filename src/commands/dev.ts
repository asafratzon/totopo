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
import { buildShadowMountArgs, ensureShadowsInSync, expandShadowPatterns } from "../lib/shadows.js";
import { readTotopoYaml } from "../lib/totopo-yaml.js";
import type { WorkspaceContext } from "../lib/workspace-identity.js";
import { readActiveProfile, writeActiveProfile } from "../lib/workspace-identity.js";

// --- Prompt: working directory selection -------------------------------------------------------------------------------------------------
async function promptWorkdir(workspaceDir: string, cwd: string): Promise<string> {
    if (cwd === workspaceDir) return "/workspace";
    const relPath = relative(workspaceDir, cwd);
    const choice = await select({
        message: "Start session:",
        options: [
            { value: "here", label: `Here  (./${relPath})` },
            { value: "root", label: "Workspace root" },
        ],
    });
    if (isCancel(choice)) {
        cancel("Cancelled.");
        process.exit(0);
    }
    return choice === "here" ? `/workspace/${relPath}` : "/workspace";
}

// --- Profile selection -------------------------------------------------------------------------------------------------------------------
async function selectProfile(ctx: WorkspaceContext, profiles: Record<string, unknown>): Promise<string> {
    const profileNames = Object.keys(profiles);
    if (profileNames.length <= 1) {
        return profileNames[0] ?? "default";
    }

    const currentProfile = readActiveProfile(ctx.workspaceId) ?? "default";

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
        writeActiveProfile(ctx.workspaceId, selected);
    }
    return selected;
}

// --- Inspect container state and labels in a single docker call --------------------------------------------------------------------------
interface ContainerInfo {
    status: string;
    shadowLabel: string;
    profileLabel: string;
}

// Returns null when the container does not exist (docker inspect exits non-zero).
function inspectContainer(containerName: string): ContainerInfo | null {
    const fmt = `{{.State.Status}}|{{index .Config.Labels "totopo.shadows"}}|{{index .Config.Labels "totopo.profile"}}`;
    const result = spawnSync("docker", ["inspect", "--format", fmt, containerName], { encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) return null;
    const clean = (s: string) => (s === "<no value>" ? "" : s);
    const [status = "", shadows = "", profile = ""] = result.stdout.trim().split("|");
    return { status, shadowLabel: clean(shadows), profileLabel: clean(profile) };
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

// --- Update AI CLIs to latest (runs as root so npm global is writable) -------------------------------------------------------------------
function updateAiClis(containerName: string): void {
    log.step("Updating AI CLIs to latest...");
    spawnSync(
        "docker",
        [
            "exec",
            "-u",
            "root",
            containerName,
            "npm",
            "install",
            "-g",
            "opencode-ai@latest",
            "@anthropic-ai/claude-code@latest",
            "@openai/codex@latest",
        ],
        { stdio: "inherit" },
    );
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

// =========================================================================================================================================
// Non-interactive session start. Handles container state inspection, shadow/profile mismatch recovery,
// image build, container creation, and lifecycle transitions (created / resumed / connected).
// =========================================================================================================================================

export interface StartContainerOpts {
    containerName: string;
    workspaceRoot: string;
    cacheDir: string;
    templatesDir: string;
    activeProfile: string;
    profileHook: string | undefined;
    expandedShadows: string[]; // Already expanded by expandShadowPatterns()
    envFilePath: string | undefined; // Resolved absolute path, or undefined if not set/missing
    hasGit: boolean;
    shadowPatterns: string[]; // Raw patterns from totopo.yaml, used for agent context docs
    workspaceName: string;
    noCache?: boolean;
    quiet?: boolean; // Suppress log output and docker stdio; used by tests
}

export type ContainerStartResult = "created" | "resumed" | "connected";

export function startContainer(opts: StartContainerOpts): ContainerStartResult {
    const {
        containerName,
        workspaceRoot,
        cacheDir,
        templatesDir,
        activeProfile,
        profileHook,
        expandedShadows,
        envFilePath,
        hasGit,
        shadowPatterns,
        workspaceName,
        noCache,
        quiet = false,
    } = opts;
    const stdio = quiet ? ("pipe" as const) : ("inherit" as const);

    // --- Sync shadows and build mount args ------------------------------------------------------------------------------------------------
    ensureShadowsInSync(cacheDir, expandedShadows, workspaceRoot);
    const shadowMountArgs = buildShadowMountArgs(cacheDir, expandedShadows);

    // --- Agent context -------------------------------------------------------------------------------------------------------------------
    const agentDocs = buildAgentContextDocs(hasGit, shadowPatterns);

    // --- Env file args -------------------------------------------------------------------------------------------------------------------
    const envFileArgs: string[] = [];
    if (envFilePath) {
        envFileArgs.push("--env-file", envFilePath);
    }

    // --- Build mount args ----------------------------------------------------------------------------------------------------------------
    const agentMounts = buildAgentMountArgs(cacheDir);
    // Shadow mounts must come AFTER the workspace mount to overlay correctly
    const mountArgs = ["-v", `${workspaceRoot}:/workspace`, ...shadowMountArgs, ...agentMounts];

    // --- Container labels ----------------------------------------------------------------------------------------------------------------
    const labelArgs = [
        "--label",
        "totopo.managed=true",
        "--label",
        `totopo.shadows=${shadowLabel(expandedShadows)}`,
        "--label",
        `totopo.profile=${activeProfile}`,
    ];

    // --- Workspace identity env var ------------------------------------------------------------------------------------------------------
    const workspaceEnvArgs = ["-e", `TOTOPO_WORKSPACE=${workspaceName}`];

    // --- Inspect container state ---------------------------------------------------------------------------------------------------------
    const info = inspectContainer(containerName);
    let containerStatus = info?.status ?? null;

    // --- Check for shadow or profile mismatch --------------------------------------------------------------------------------------------
    if (info !== null) {
        const expectedShadowLabel = shadowLabel(expandedShadows);
        const shadowChanged = info.shadowLabel !== expectedShadowLabel;
        const profileChanged = info.profileLabel !== activeProfile;

        if (shadowChanged || profileChanged) {
            stopAndRemoveContainer(containerName);
            containerStatus = null;

            if (profileChanged) {
                // Profile change means different Dockerfile - must rebuild image
                if (!quiet) log.info(`Profile changed (${info.profileLabel} -> ${activeProfile}) — rebuilding...`);
                spawnSync("docker", ["rmi", containerName], { stdio: "pipe" });
            } else {
                if (!quiet) log.info("Shadow paths changed — recreating container...");
            }
        }
    }

    if (containerStatus === null) {
        // --- No container - build image and run ------------------------------------------------------------------------------------------
        if (!quiet) log.step("Building container image...");
        const dockerfileContent = buildDockerfile(join(templatesDir, "Dockerfile"), profileHook);
        const buildResult = buildImageWithTempfile(dockerfileContent, templatesDir, containerName, noCache, quiet);
        if (buildResult.status !== 0) {
            if (!quiet) outro("Failed to build container image.");
            process.exit(buildResult.status);
        }

        if (!quiet) log.step("Preparing agent context...");
        injectAgentContext(cacheDir, agentDocs);
        if (!quiet) log.step("Starting dev container...");

        const runResult = spawnSync(
            "docker",
            [
                "run",
                "-d",
                "--name",
                containerName,
                ...mountArgs,
                ...envFileArgs,
                ...workspaceEnvArgs,
                "--security-opt",
                "no-new-privileges:true",
                ...labelArgs,
                containerName,
                "sleep",
                "infinity",
            ],
            { stdio },
        );
        if (runResult.status !== 0) {
            if (!quiet) outro("Failed to start dev container.");
            process.exit(runResult.status ?? 1);
        }
        return "created";
    } else if (containerStatus === "exited") {
        // --- Container stopped - resume --------------------------------------------------------------------------------------------------
        if (!quiet) log.step("Preparing agent context...");
        injectAgentContext(cacheDir, agentDocs);
        if (!quiet) log.step("Resuming dev container...");
        const start = spawnSync("docker", ["start", containerName], { stdio });
        if (start.status !== 0) {
            if (!quiet) outro("Failed to start dev container.");
            process.exit(start.status ?? 1);
        }
        return "resumed";
    } else {
        // --- Container running - refresh agent context and connect ------------------------------------------------------------------------
        if (!quiet) log.step("Refreshing agent context...");
        injectAgentContext(cacheDir, agentDocs);
        return "connected";
    }
}

// --- Main --------------------------------------------------------------------------------------------------------------------------------
export async function run(packageDir: string, ctx: WorkspaceContext, options?: { noCache?: boolean }): Promise<void> {
    const cwd = process.cwd();
    const workspaceDir = ctx.workspaceRoot;
    const containerName = ctx.containerName;
    const cacheDir = ctx.workspaceDir;
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

    // --- Env file ------------------------------------------------------------------------------------------------------------------------
    let envFilePath: string | undefined;
    if (yaml.env_file) {
        const resolved = join(workspaceDir, yaml.env_file);
        if (existsSync(resolved)) {
            envFilePath = resolved;
        } else {
            log.warn(`env_file "${yaml.env_file}" not found — skipping`);
        }
    }

    const hasGit = existsSync(join(workspaceDir, ".git"));

    // --- Start container -----------------------------------------------------------------------------------------------------------------
    const sessionResult = startContainer({
        containerName,
        workspaceRoot: workspaceDir,
        cacheDir,
        templatesDir,
        activeProfile,
        profileHook,
        expandedShadows,
        envFilePath,
        hasGit,
        shadowPatterns,
        workspaceName: ctx.displayName,
        ...(options?.noCache !== undefined && { noCache: options.noCache }),
    });

    // --- Post-start setup (only on fresh start or resume) --------------------------------------------------------------------------------
    if (sessionResult === "created" || sessionResult === "resumed") {
        updateAiClis(containerName);
        runPostStart(containerName);
    }

    // --- Connect -------------------------------------------------------------------------------------------------------------------------
    const exec = spawnSync("docker", ["exec", "-it", "-w", workdir, containerName, "bash", "--login"], {
        stdio: "inherit",
    });

    process.exit(exec.status ?? 0);
}
