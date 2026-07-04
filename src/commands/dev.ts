// =========================================================================================================================================
// src/commands/dev.ts - Start the dev container and connect via docker exec
// In-memory Dockerfile build, profile selection, pattern-based shadows, env_file handling, runtime env injection.
// =========================================================================================================================================

import { type StdioOptions, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { cancel, confirm, isCancel, log, outro, select } from "@clack/prompts";
import { buildAgentContextDocs, buildAgentMountArgs, injectAgentContext } from "../lib/agent-context.js";
import { ensureCookieFile, IS_MACOS, isAudioServerRunning, startServer, stopServer } from "../lib/audio-host.js";
import {
    AUDIO_COOKIE_CONTAINER_PATH,
    AUDIO_MODE,
    AUDIO_PULSE_SERVER,
    AUDIODRIVER_VALUE,
    AUTO_START,
    CONTAINER_STARTUP,
    CONTAINER_WORKSPACE,
    GIT_MODE,
    type GitMode,
    LABEL_AUDIO,
    LABEL_AUTOSTART,
    LABEL_GIT_MODE,
    LABEL_MANAGED,
    LABEL_PORTS,
    LABEL_PROFILE,
    LABEL_RUNTIME_ENV,
    LABEL_SHADOWS,
    PROFILE,
    RUNTIME_ENV,
} from "../lib/constants.js";
import { buildDockerfile, buildImageWithTempfile, computeBuildHash } from "../lib/dockerfile-builder.js";
import { readAudioMode, readAutoStartAgent } from "../lib/global-config.js";
import { isImageStale } from "../lib/migrate-to-latest.js";
import { buildPnpmStoreMountArgs } from "../lib/pnpm-store.js";
import {
    assertHostPortsAvailable,
    formatPortNotice,
    type PortMapping,
    portEnvArgs,
    portPublishArgs,
    portsLabel,
    validatePortsConfig,
} from "../lib/ports.js";
import { connectedSessionCount, containerSessionCount, loginShellExecArgs } from "../lib/sessions.js";
import { buildShadowMountArgs, ensureShadowsInSync, expandShadowPatterns } from "../lib/shadows.js";
import type { ProfileConfig } from "../lib/totopo-yaml.js";
import { readTotopoYaml } from "../lib/totopo-yaml.js";
import type { WorkspaceContext } from "../lib/workspace-identity.js";
import { readActiveProfile, readAudio, readGitMode, writeActiveProfile } from "../lib/workspace-identity.js";

// --- Working directory resolution ---------------------------------------------------------------------------------------------------------
// Always open the session where totopo was invoked. The whole workspace root is bind-mounted at
// CONTAINER_WORKSPACE regardless, so this only sets the shell's opening directory. From a sub-dir,
// `cd /workspace` reaches the root - nothing is hidden either way. Exported for testing.
export function resolveWorkdir(workspaceDir: string, cwd: string): string {
    if (cwd === workspaceDir) return CONTAINER_WORKSPACE;
    return `${CONTAINER_WORKSPACE}/${relative(workspaceDir, cwd)}`;
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
    autoStartLabel: string;
    portsLabel: string;
}

// Returns null when the container does not exist (docker inspect exits non-zero).
function inspectContainer(containerName: string): ContainerInfo | null {
    const fmt = `{{.State.Status}}|{{index .Config.Labels "${LABEL_SHADOWS}"}}|{{index .Config.Labels "${LABEL_PROFILE}"}}|{{index .Config.Labels "${LABEL_RUNTIME_ENV}"}}|{{index .Config.Labels "${LABEL_GIT_MODE}"}}|{{index .Config.Labels "${LABEL_AUDIO}"}}|{{index .Config.Labels "${LABEL_AUTOSTART}"}}|{{index .Config.Labels "${LABEL_PORTS}"}}`;
    const result = spawnSync("docker", ["inspect", "--format", fmt, containerName], { encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) return null;
    const clean = (s: string) => (s === "<no value>" ? "" : s);
    const [status = "", shadows = "", profile = "", runtimeEnv = "", gitMode = "", audio = "", autoStart = "", ports = ""] = result.stdout
        .trim()
        .split("|");
    return {
        status,
        shadowLabel: clean(shadows),
        profileLabel: clean(profile),
        runtimeEnvLabel: clean(runtimeEnv),
        gitModeLabel: clean(gitMode),
        audioLabel: clean(audio),
        autoStartLabel: clean(autoStart),
        portsLabel: clean(ports),
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

// --- Audio state label -------------------------------------------------------------------------------------------------------------------
// Captures whether the bridge is on AND the host cookie path that gets bind-mounted, so relocating the
// cookie recreates the container instead of leaving it with a dangling mount. Off keeps the old
// String(audio) value ("false") so audio-off containers are not needlessly recreated on upgrade.
export function audioStateLabel(audio: boolean, audioCookiePath: string | undefined): string {
    if (!audio) return "false";
    const fingerprint = createHash("sha256")
        .update(audioCookiePath ?? "")
        .digest("hex")
        .slice(0, 12);
    return `true:${fingerprint}`;
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
    const result = spawnSync("docker", ["exec", "-u", "root", ...ttyFlags, containerName, "node", CONTAINER_STARTUP, "--summary"], {
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
    portMappings: PortMapping[]; // Normalized host->container mappings from validatePortsConfig
    noCache?: boolean;
    quiet?: boolean; // Suppress log output and docker stdio; used by tests
}

export type ContainerStartResult = "created" | "resumed" | "connected";

export async function startContainer(opts: StartContainerOpts): Promise<ContainerStartResult> {
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
        portMappings,
        noCache,
        quiet = false,
    } = opts;
    // Used by `docker start` (resume). Echoes the container id/name to stdout on success; drop stdout to keep
    // that noise out of the session start, but keep stderr so real errors still show.
    const stdio: StdioOptions = quiet ? "pipe" : ["ignore", "ignore", "inherit"];

    // --- Published ports fingerprint (static config, no host I/O here) ----------------------------------------------------------------------
    // Ports are declared, not resolved, so the label is a pure function of the config. Host availability is
    // probed just-in-time on the create path (assertHostPortsAvailable), never on resume/connect.
    const currentPortsLabel = portsLabel(portMappings);

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

    // --- Auto-start agent (host-global) --------------------------------------------------------------------------------------------------
    // Read from the global config, not opts: the favorite agent is a person-level preference shared across
    // all workspaces (like the audio mode), so every workspace's container reflects the same value.
    const autoStartAgent = readAutoStartAgent();

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
        `${LABEL_AUDIO}=${audioStateLabel(audio, audioCookiePath)}`,
        "--label",
        `${LABEL_AUTOSTART}=${autoStartAgent}`,
    ];

    // --- Runtime env vars -----------------------------------------------------------------------------------------------------------------
    const runtimeEnvArgs = [
        ...Object.entries(RUNTIME_ENV).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        "-e",
        `TOTOPO_WORKSPACE=${workspaceName}`,
        "-e",
        `TOTOPO_GIT_MODE=${gitMode}`,
        // Only set when enabled: ~/.bashrc auto-launches the agent when TOTOPO_AUTOSTART is a non-empty command.
        ...(autoStartAgent !== AUTO_START.off ? ["-e", `TOTOPO_AUTOSTART=${autoStartAgent}`] : []),
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

    // --- Recreate if shadow, profile, runtime env, git mode, audio, auto-start, or ports changed -----------------------------------------
    if (info !== null) {
        const expectedShadowLabel = shadowLabel(expandedShadows);
        const shadowChanged = info.shadowLabel !== expectedShadowLabel;
        const profileChanged = info.profileLabel !== activeProfile;
        const runtimeEnvChanged = info.runtimeEnvLabel !== runtimeEnvLabel();
        const gitModeChanged = info.gitModeLabel !== gitMode;
        const audioChanged = info.audioLabel !== audioStateLabel(audio, audioCookiePath);
        // Treat an absent label (pre-feature container) as "off" so a still-default setting does not force a
        // spurious recreate on the first upgrade - the stale-image prompt handles the mandatory rebuild instead.
        const autoStartChanged = (info.autoStartLabel || AUTO_START.off) !== autoStartAgent;
        // Both sides are "" when a workspace declares no ports, so a container without published ports never churns on this label.
        const portsChanged = info.portsLabel !== currentPortsLabel;

        if (shadowChanged || profileChanged || runtimeEnvChanged || gitModeChanged || audioChanged || autoStartChanged || portsChanged) {
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
            } else if (portsChanged) {
                if (!quiet) log.info("Ports changed — recreating container...");
            } else if (autoStartChanged) {
                if (!quiet)
                    log.info(
                        `Auto-start changed (${info.autoStartLabel || AUTO_START.off} -> ${autoStartAgent}) — recreating container...`,
                    );
            } else {
                if (!quiet) log.info("Runtime environment updated — recreating container...");
            }
        }
    }

    // Refresh the agent context docs in the cache dir (bind-mounted into the container) once, before any
    // create / resume / connect path below. Idempotent file writes with no dependency on the image build.
    injectAgentContext(cacheDir, agentDocs);

    // Build the image (if needed) and run a fresh container. Shared by the no-container path and the
    // resume-recovery path below. Build/run failures are terminal, so they outro and exit here.
    const createAndRun = async (): Promise<void> => {
        // The interactive build spinner owns the "rebuilding" message (see buildImageWithTempfile), so no log.step here.
        const dockerfileContent = buildDockerfile(join(templatesDir, "Dockerfile"), profileHook);
        const buildResult = await buildImageWithTempfile(dockerfileContent, templatesDir, containerName, noCache, quiet);
        if (buildResult.status !== 0) {
            if (!quiet) outro("Failed to build container image.");
            process.exit(buildResult.status);
        }

        // Ports are static config, so probe host availability up front. The old container was already removed on
        // every path that reaches here, so we never probe our own live port. A taken host port fails clearly and
        // names the entry, before docker run - so no doomed `created` container is left behind on a clash.
        try {
            await assertHostPortsAvailable(portMappings);
        } catch (err) {
            if (!quiet) outro(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }

        if (!quiet) log.info("Starting dev container...");

        // portEnvArgs come after envFileArgs/runtimeEnvArgs/audioRunArgs so the published value wins any -e collision.
        const runArgs = [
            "run",
            "-d",
            "--name",
            containerName,
            ...mountArgs,
            ...envFileArgs,
            ...runtimeEnvArgs,
            ...audioRunArgs,
            ...portEnvArgs(portMappings),
            ...portPublishArgs(portMappings),
            "--security-opt",
            "no-new-privileges:true",
            ...labelArgs,
            "--label",
            `${LABEL_PORTS}=${currentPortsLabel}`,
            containerName,
            "sleep",
            "infinity",
        ];

        // Capture stderr so the real docker error is re-emitted on failure. A single run - the pre-flight probe
        // above already rejected any taken host port, so there is no port-race retry loop.
        const runStdio: StdioOptions = quiet ? "pipe" : ["ignore", "ignore", "pipe"];
        const runResult = spawnSync("docker", runArgs, { stdio: runStdio });
        if (runResult.status !== 0) {
            if (!quiet) {
                process.stderr.write(runResult.stderr?.toString() ?? "");
                outro("Failed to start dev container.");
            }
            process.exit(runResult.status ?? 1);
        }
    };

    if (containerStatus === null) {
        // --- No container - build image and run --------------------------------------------------------------------------------------------
        await createAndRun();
        return "created";
    } else if (containerStatus === "exited") {
        // --- Container stopped - resume (recreate on a dangling-mount failure) -------------------------------------------------------------
        if (!quiet) log.info("Resuming dev container...");
        const start = spawnSync("docker", ["start", containerName], { stdio });
        if (start.status !== 0) {
            // A resume reuses the bind mounts frozen at create time. When one no longer resolves on the host
            // - most often the pre-v3.10.0 audio cookie that has since moved (the container still references
            // the old path) - docker start fails. stderr is inherited, not captured, so do not parse the
            // daemon error; treat any resume failure as recreate-worthy. Recreating rebinds every mount
            // against current paths; agent memory, settings, and workspace data live in host bind mounts and
            // cache dirs outside the container fs, so they survive. Non-interactive callers keep the hard fail.
            if (quiet) process.exit(start.status ?? 1); // Non-interactive: preserve the original silent hard fail.
            log.warn(
                "This container could not start - a host path it was created against has likely moved or been removed\n" +
                    "  (for example the audio cookie relocated in v3.10.0).",
            );
            const recreate = await confirm({
                message: "Recreate it now? Your agent memory, settings, and workspace data are preserved.",
                initialValue: true,
            });
            if (isCancel(recreate) || !recreate) {
                outro("Failed to start dev container.");
                process.exit(start.status ?? 1);
            }
            stopAndRemoveContainer(containerName);
            await createAndRun();
            return "created";
        }
        return "resumed";
    } else {
        // --- Container running - connect ---------------------------------------------------------------------------------------------------
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

    // --- Validate and normalize ports config (rules the schema cannot express) -----------------------------------------------------------
    let portMappings: PortMapping[];
    try {
        portMappings = validatePortsConfig(yaml.ports ?? []);
    } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }

    // --- Resolve working directory -------------------------------------------------------------------------------------------------------
    const workdir = resolveWorkdir(workspaceDir, cwd);

    // --- Profile selection ---------------------------------------------------------------------------------------------------------------
    const profiles = yaml.profiles ?? {};
    const activeProfile = await selectProfile(ctx, profiles);
    const profileConfig = profiles[activeProfile];
    const profileHook = profileConfig?.dockerfile_hook;

    // --- Shadow path expansion -----------------------------------------------------------------------------------------------------------
    const shadowPatterns = yaml.shadow_paths ?? [];
    const { paths: expandedShadows, skippedTracked } = expandShadowPatterns(shadowPatterns, workspaceDir);

    if (expandedShadows.length > 0) {
        log.info(`Shadow paths active: ${expandedShadows.join(", ")}  (Settings > Shadow paths)`);
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
        portMappings,
        ...(options?.noCache !== undefined && { noCache: options.noCache }),
    };
    await startContainer(containerOpts);

    // --- Stale image check - prompt user to rebuild if image is outdated ------------------------------------------------------------------
    const dockerfileContent = buildDockerfile(join(templatesDir, "Dockerfile"), profileHook);
    const expectedBuildHash = computeBuildHash(dockerfileContent, templatesDir);
    let stale = isImageStale(containerName, expectedBuildHash);
    if (stale) {
        log.warn(
            "totopo's latest release includes an updated container image.\nPlease rebuild to update — this will not affect agent memory, settings, or your data.",
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
            await startContainer(containerOpts);
            stale = false;
        }
    }

    // --- Published ports notice (every session start: created / resumed / connected) -----------------------------------------------------
    // Ports are static config, so the notice derives straight from the mappings - no .lock lookup needed.
    for (const m of portMappings) {
        log.info(formatPortNotice(m));
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
    const exec = spawnSync("docker", loginShellExecArgs(workdir, containerName), {
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
            log.info("Stopping container...");
            spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
            log.info("Container stopped.");
        }
    }

    // Trailing blank line so the last log does not sit flush against the next shell prompt.
    process.stdout.write("\n");
    process.exit(exec.status ?? 0);
}
