// =========================================================================================================================================
// src/commands/dev.ts - Start the dev container and connect via docker exec
// In-memory Dockerfile build, profile selection, pattern-based shadows, env_file handling, runtime env injection.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { cancel, confirm, isCancel, log, outro, select } from "@clack/prompts";
import { buildAgentContextDocs, buildAgentMountArgs, injectAgentContext } from "../lib/agent-context.js";
import {
    connectedSessionCount,
    containerSessionCount,
    ensureCookieFile,
    IS_MACOS,
    isAudioServerRunning,
    startServer,
    stopServer,
} from "../lib/audio-host.js";
import {
    AUDIO_COOKIE_CONTAINER_PATH,
    AUDIO_MODE,
    AUDIO_PULSE_SERVER,
    AUDIODRIVER_VALUE,
    CONTAINER_STARTUP,
    CONTAINER_WORKSPACE,
    GIT_MODE,
    type GitMode,
    LABEL_AUDIO,
    LABEL_GIT_MODE,
    LABEL_MANAGED,
    LABEL_PROFILE,
    LABEL_RUNTIME_ENV,
    LABEL_SHADOWS,
    PROFILE,
    RUNTIME_ENV,
} from "../lib/constants.js";
import { buildDockerfile, buildImageWithTempfile, computeBuildHash } from "../lib/dockerfile-builder.js";
import { readAudioMode } from "../lib/global-config.js";
import { isImageStale } from "../lib/migrate-to-latest.js";
import { buildPnpmStoreMountArgs } from "../lib/pnpm-store.js";
import { buildShadowMountArgs, ensureShadowsInSync, expandShadowPatterns } from "../lib/shadows.js";
import type { ProfileConfig } from "../lib/totopo-yaml.js";
import { readTotopoYaml } from "../lib/totopo-yaml.js";
import type { WorkspaceContext } from "../lib/workspace-identity.js";
import { readActiveProfile, readAudio, readGitMode, writeActiveProfile } from "../lib/workspace-identity.js";

// --- Prompt: working directory selection -------------------------------------------------------------------------------------------------
async function promptWorkdir(workspaceDir: string, cwd: string): Promise<string> {
    if (cwd === workspaceDir) return CONTAINER_WORKSPACE;
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
    return choice === "here" ? `${CONTAINER_WORKSPACE}/${relPath}` : CONTAINER_WORKSPACE;
}

// --- Countdown helper --------------------------------------------------------------------------------------------------------------------
// Print a message, then tick down one line per second. Used so a transient warning (e.g. the host audio
// server failed to auto-start) stays on screen long enough to read before the session connects anyway.
async function countdown(seconds: number, message: string): Promise<void> {
    for (let remaining = seconds; remaining > 0; remaining--) {
        log.info(`${message} in ${remaining}...`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}

// --- Profile selection -------------------------------------------------------------------------------------------------------------------
async function selectProfile(ctx: WorkspaceContext, profiles: Record<string, ProfileConfig>): Promise<string> {
    const profileNames = Object.keys(profiles);
    if (profileNames.length <= 1) {
        return profileNames[0] ?? PROFILE.default;
    }

    const currentProfile = readActiveProfile(ctx.workspaceId) ?? PROFILE.default;

    const choice = await select({
        message: "Profile:",
        options: profileNames.map((name) => {
            const description = profiles[name]?.description;
            const isCurrent = name === currentProfile;
            const hint = description && isCurrent ? `${description} · current` : (description ?? (isCurrent ? "current" : undefined));
            const opt: { value: string; label: string; hint?: string } = { value: name, label: name };
            if (hint) opt.hint = hint;
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
    runtimeEnvLabel: string;
    gitModeLabel: string;
    audioLabel: string;
}

// Returns null when the container does not exist (docker inspect exits non-zero).
function inspectContainer(containerName: string): ContainerInfo | null {
    const fmt = `{{.State.Status}}|{{index .Config.Labels "${LABEL_SHADOWS}"}}|{{index .Config.Labels "${LABEL_PROFILE}"}}|{{index .Config.Labels "${LABEL_RUNTIME_ENV}"}}|{{index .Config.Labels "${LABEL_GIT_MODE}"}}|{{index .Config.Labels "${LABEL_AUDIO}"}}`;
    const result = spawnSync("docker", ["inspect", "--format", fmt, containerName], { encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) return null;
    const clean = (s: string) => (s === "<no value>" ? "" : s);
    const [status = "", shadows = "", profile = "", runtimeEnv = "", gitMode = "", audio = ""] = result.stdout.trim().split("|");
    return {
        status,
        shadowLabel: clean(shadows),
        profileLabel: clean(profile),
        runtimeEnvLabel: clean(runtimeEnv),
        gitModeLabel: clean(gitMode),
        audioLabel: clean(audio),
    };
}

// --- Shadow label ------------------------------------------------------------------------------------------------------------------------
function shadowLabel(paths: string[]): string {
    if (paths.length === 0) return "";
    return [...paths].sort().join(",");
}

// --- Runtime env fingerprint -------------------------------------------------------------------------------------------------------------
function runtimeEnvLabel(): string {
    const entries = Object.entries(RUNTIME_ENV);
    if (entries.length === 0) return "";
    const sorted = entries
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join(",");
    return createHash("sha256").update(sorted).digest("hex").slice(0, 12);
}

// --- Stop and remove container -----------------------------------------------------------------------------------------------------------
function stopAndRemoveContainer(containerName: string): void {
    spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
    spawnSync("docker", ["rm", containerName], { stdio: "pipe" });
}

// --- Run startup checks (AI CLI update + readiness validation) ---------------------------------------------------------------------------
function runStartup(containerName: string, quiet?: boolean): boolean {
    // The SPACE-to-skip prompt in startup.mjs needs raw-mode stdin (-i) and a PTY (-t).
    // Omitted when quiet so test output stays pipe-capturable.
    const ttyFlags = quiet ? [] : ["-i", "-t"];
    const result = spawnSync("docker", ["exec", "-u", "root", ...ttyFlags, containerName, "node", CONTAINER_STARTUP], {
        stdio: quiet ? "pipe" : "inherit",
    });
    return result.status === 0;
}

// =========================================================================================================================================
// Non-interactive session start. Handles container state inspection, shadow/profile/runtime-env mismatch recovery,
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
    gitMode: GitMode;
    audio: boolean; // Claude Code /voice bridge: inject PulseAudio env + --add-host when true
    audioCookiePath?: string; // Absolute host path to the PulseAudio cookie; mounted read-only for auth when set
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
        gitMode,
        audio,
        audioCookiePath,
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
    const agentDocs = buildAgentContextDocs(hasGit, shadowPatterns, gitMode);

    // --- Env file args -------------------------------------------------------------------------------------------------------------------
    const envFileArgs: string[] = [];
    if (envFilePath) {
        envFileArgs.push("--env-file", envFilePath);
    }

    // --- Build mount args ----------------------------------------------------------------------------------------------------------------
    const agentMounts = buildAgentMountArgs(cacheDir);
    const pnpmStoreMounts = buildPnpmStoreMountArgs(cacheDir);
    // Shadow mounts must come AFTER the workspace mount to overlay correctly
    const mountArgs = ["-v", `${workspaceRoot}:${CONTAINER_WORKSPACE}`, ...shadowMountArgs, ...agentMounts, ...pnpmStoreMounts];

    // --- Container labels ----------------------------------------------------------------------------------------------------------------
    const labelArgs = [
        "--label",
        `${LABEL_MANAGED}=true`,
        "--label",
        `${LABEL_SHADOWS}=${shadowLabel(expandedShadows)}`,
        "--label",
        `${LABEL_PROFILE}=${activeProfile}`,
        "--label",
        `${LABEL_RUNTIME_ENV}=${runtimeEnvLabel()}`,
        "--label",
        `${LABEL_GIT_MODE}=${gitMode}`,
        "--label",
        `${LABEL_AUDIO}=${audio}`,
    ];

    // --- Runtime env vars -----------------------------------------------------------------------------------------------------------------
    const runtimeEnvArgs = [
        ...Object.entries(RUNTIME_ENV).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        "-e",
        `TOTOPO_WORKSPACE=${workspaceName}`,
        "-e",
        `TOTOPO_GIT_MODE=${gitMode}`,
    ];

    // --- Audio bridge (Claude Code /voice) ------------------------------------------------------------------------------------------------
    // When enabled, point SoX 'rec' at the host PulseAudio server. --add-host makes host.docker.internal
    // resolve on native Linux (it is automatic on Docker Desktop, where the flag is harmless).
    // When the host cookie exists, mount it read-only and set PULSE_COOKIE so the container can
    // authenticate; the server requires this shared secret, so only wired containers can connect.
    const audioCookieArgs =
        audio && audioCookiePath
            ? ["-e", `PULSE_COOKIE=${AUDIO_COOKIE_CONTAINER_PATH}`, "-v", `${audioCookiePath}:${AUDIO_COOKIE_CONTAINER_PATH}:ro`]
            : [];
    const audioRunArgs = audio
        ? [
              "-e",
              `PULSE_SERVER=${AUDIO_PULSE_SERVER}`,
              "-e",
              `AUDIODRIVER=${AUDIODRIVER_VALUE}`,
              "--add-host",
              "host.docker.internal:host-gateway",
              ...audioCookieArgs,
          ]
        : [];

    // --- Inspect container state ---------------------------------------------------------------------------------------------------------
    const info = inspectContainer(containerName);
    let containerStatus = info?.status ?? null;

    // --- Check for shadow, profile, runtime env, or git mode mismatch --------------------------------------------------------------------
    if (info !== null) {
        const expectedShadowLabel = shadowLabel(expandedShadows);
        const shadowChanged = info.shadowLabel !== expectedShadowLabel;
        const profileChanged = info.profileLabel !== activeProfile;
        const runtimeEnvChanged = info.runtimeEnvLabel !== runtimeEnvLabel();
        const gitModeChanged = info.gitModeLabel !== gitMode;
        const audioChanged = info.audioLabel !== String(audio);

        if (shadowChanged || profileChanged || runtimeEnvChanged || gitModeChanged || audioChanged) {
            stopAndRemoveContainer(containerName);
            containerStatus = null;

            if (profileChanged) {
                // Profile change means different Dockerfile - must rebuild image
                if (!quiet) log.info(`Profile changed (${info.profileLabel} -> ${activeProfile}) — rebuilding...`);
                spawnSync("docker", ["rmi", containerName], { stdio: "pipe" });
            } else if (shadowChanged) {
                if (!quiet) log.info("Shadow paths changed — recreating container...");
            } else if (gitModeChanged) {
                if (!quiet) log.info(`Git mode changed (${info.gitModeLabel || "<unset>"} -> ${gitMode}) — recreating container...`);
            } else if (audioChanged) {
                if (!quiet) log.info(`Voice/audio ${audio ? "enabled" : "disabled"} — recreating container...`);
            } else {
                if (!quiet) log.info("Runtime environment updated — recreating container...");
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
                ...runtimeEnvArgs,
                ...audioRunArgs,
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
    const { paths: expandedShadows, skippedTracked } = expandShadowPatterns(shadowPatterns, workspaceDir);

    if (expandedShadows.length > 0) {
        log.warn(`Shadow paths active: ${expandedShadows.join(", ")}  (Settings > Shadow paths)`);
    }
    if (skippedTracked.length > 0) {
        log.warn(`Skipped ${skippedTracked.length} shadow path(s) tracked by git`);
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

    // --- Git mode (per-workspace, host-side .lock) ---------------------------------------------------------------------------------------
    const gitMode = readGitMode(ctx.workspaceId) ?? GIT_MODE.local;

    // --- Audio bridge opt-in (per-workspace, host-side .lock) ----------------------------------------------------------------------------
    const audio = readAudio(ctx.workspaceId);

    // --- Auto-start host audio server (automatic mode, macOS) ----------------------------------------------------------------------------
    // When wiring is on and the workspace is in automatic mode, bring the host server up before the
    // container starts so the cookie it rotates is already in place for the read-only mount below
    // (ensureCookieFile then no-ops). A failure never blocks the session - warn and count down so the
    // message is readable, then connect anyway.
    if (IS_MACOS && audio && readAudioMode() === AUDIO_MODE.automatic && !isAudioServerRunning()) {
        const res = startServer();
        if (res.ok) log.info("Host audio server started (voice input ready).");
        else {
            log.warn(res.message);
            await countdown(3, "Continuing without the audio server");
        }
    }

    // Ensure totopo's dedicated host cookie exists so the read-only mount target is always valid; the
    // host server rotates it on each cold start. Creating it here (when absent) avoids any need to
    // recreate the container after the server first starts.
    const audioCookiePath = audio ? ensureCookieFile() : undefined;

    // --- Start container -----------------------------------------------------------------------------------------------------------------
    const containerOpts: StartContainerOpts = {
        containerName,
        workspaceRoot: workspaceDir,
        cacheDir,
        templatesDir,
        activeProfile,
        profileHook,
        expandedShadows,
        envFilePath,
        hasGit,
        gitMode,
        audio,
        ...(audioCookiePath !== undefined && { audioCookiePath }),
        shadowPatterns,
        workspaceName: ctx.workspaceId,
        ...(options?.noCache !== undefined && { noCache: options.noCache }),
    };
    startContainer(containerOpts);

    // --- Stale image check - prompt user to rebuild if image is outdated ------------------------------------------------------------------
    const dockerfileContent = buildDockerfile(join(templatesDir, "Dockerfile"), profileHook);
    const expectedBuildHash = computeBuildHash(dockerfileContent, templatesDir);
    let stale = isImageStale(containerName, expectedBuildHash);
    if (stale) {
        log.warn(
            "totopo's latest release includes an updated container image.\n  Please rebuild to update — this will not affect agent memory, settings, or your data.",
        );
        const rebuild = await confirm({
            message: "Rebuild now? (Recommended)",
            initialValue: true,
        });
        if (isCancel(rebuild)) {
            cancel("Session cancelled.");
            process.exit(0);
        }
        if (rebuild) {
            stopAndRemoveContainer(containerName);
            spawnSync("docker", ["rmi", containerName], { stdio: "pipe" });
            startContainer(containerOpts);
            stale = false;
        }
    }

    // --- Startup checks (AI CLI update + readiness validation) ----------------------------------------------------------------------------
    if (!runStartup(containerName, stale)) {
        if (stale) {
            const connect = await confirm({
                message: "Startup checks failed (likely due to outdated image). Connect anyway?",
                initialValue: true,
            });
            if (!connect || isCancel(connect)) {
                cancel("Session cancelled.");
                process.exit(0);
            }
        } else {
            outro("Startup checks failed.");
            process.exit(1);
        }
    }

    // --- Connect -------------------------------------------------------------------------------------------------------------------------
    const exec = spawnSync("docker", ["exec", "-it", "-w", workdir, containerName, "bash", "--login"], {
        stdio: "inherit",
    });

    // --- Auto-stop host audio server (automatic mode, macOS) -----------------------------------------------------------------------------
    // Control returns here synchronously when the user exits the shell. In automatic mode, stop the
    // global host server only when no totopo session anywhere is still connected (the just-exited shell
    // is already reaped, so 0 is the all-clear). Conservative by design: a lingering session keeps it up.
    if (IS_MACOS && audio && readAudioMode() === AUDIO_MODE.automatic && isAudioServerRunning() && connectedSessionCount() === 0) {
        const res = stopServer();
        if (res.ok) log.info("Host audio server stopped (no active sessions).");
        else log.warn(res.message);
    }

    // --- Offer to stop this workspace's container (last shell closed) --------------------------------------------------------------------
    // The container itself keeps running (sleep infinity) after the shell exits. When this was the last
    // shell to it, offer to stop it to free memory. Stop-only (no rm) so the next session resumes fast
    // via the "exited" -> docker start path. Runs after the global audio auto-stop above; all platforms.
    if (containerSessionCount(containerName) === 0) {
        const stopNow = await confirm({
            message: "Last session to this container closed. Stop it to free memory? (resumes fast next time)",
            initialValue: true,
        });
        if (!isCancel(stopNow) && stopNow) {
            log.step("Stopping container...");
            spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
            log.info("Container stopped - memory freed; it resumes on your next session.");
        }
    }

    // Trailing blank line so the last log does not sit flush against the next shell prompt.
    process.stdout.write("\n");
    process.exit(exec.status ?? 0);
}
