// =========================================================================================================================================
// src/commands/dev.ts - Start the dev container and connect via docker exec
// In-memory Dockerfile build, profile selection, pattern-based shadows, env handling, runtime env injection.
// =========================================================================================================================================

import { type StdioOptions, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { cancel, confirm, isCancel, log, outro, select } from "@clack/prompts";
import { buildAgentContextDocs, buildAgentMountArgs, injectAgentContext } from "../lib/agent-context.js";
import {
    AUTO_START,
    type AutoStartAgent,
    CONTAINER_KEEP_ALIVE,
    CONTAINER_STARTUP,
    CONTAINER_WORKSPACE,
    DEFAULT_PROFILE,
    GIT_MODE,
    type GitMode,
    LABEL_AUTOSTART,
    LABEL_ENV,
    LABEL_GIT_MODE,
    LABEL_MANAGED,
    LABEL_PORTS,
    LABEL_PROFILE,
    LABEL_RUNTIME_ENV,
    LABEL_SHADOWS,
    RUNTIME_ENV,
    WEB_CONTAINER_PORT,
} from "../lib/constants.js";
import { buildDockerfile, buildImageWithTempfile, computeBuildHash } from "../lib/dockerfile-builder.js";
import { type EnvConfig, envLabel, envRunArgs, envWarnings, validateEnvConfig } from "../lib/env.js";
import { readAutoStartAgent, readWebEnabled, readWebRange } from "../lib/global-config.js";
import { isImageStale } from "../lib/migrate-to-latest.js";
import { buildPnpmStoreMountArgs } from "../lib/pnpm-store.js";
import {
    assertHostPortsAvailable,
    formatPortNotice,
    formatWebRange,
    type PortMapping,
    portEnvArgs,
    portPublishArgs,
    portsLabel,
    validatePortsConfig,
} from "../lib/ports.js";
import { containerSessionCount, loginShellExecArgs } from "../lib/sessions.js";
import { buildShadowMountArgs, ensureShadowsInSync, expandShadowPatterns } from "../lib/shadows.js";
import type { ProfileConfig } from "../lib/totopo-yaml.js";
import { readTotopoYaml } from "../lib/totopo-yaml.js";
import {
    plantResumeMarker,
    readWebKey,
    resolveWebPort,
    resumeCommandFor,
    setWebDefaultCwd,
    startWebtermAndVerify,
    webInterfaceAnswers,
    webPortUsable,
    webSessionInfo,
} from "../lib/webterm.js";
import type { WorkspaceContext } from "../lib/workspace-identity.js";
import { readActiveProfile, readGitMode, writeActiveProfile } from "../lib/workspace-identity.js";

// --- Working directory resolution ---------------------------------------------------------------------------------------------------------
// Always open the session where totopo was invoked. The whole workspace root is bind-mounted at
// CONTAINER_WORKSPACE regardless, so this only sets the shell's opening directory. From a sub-dir,
// `cd /workspace` reaches the root - nothing is hidden either way. Exported for testing.
export function resolveWorkdir(workspaceDir: string, cwd: string): string {
    if (cwd === workspaceDir) return CONTAINER_WORKSPACE;
    return `${CONTAINER_WORKSPACE}/${relative(workspaceDir, cwd)}`;
}

// --- Profile selection -------------------------------------------------------------------------------------------------------------------
async function selectProfile(ctx: WorkspaceContext, profiles: Record<string, ProfileConfig>): Promise<string> {
    const profileNames = Object.keys(profiles);
    if (profileNames.length <= 1) {
        return profileNames[0] ?? DEFAULT_PROFILE;
    }

    const currentProfile = readActiveProfile(ctx.workspaceId) ?? DEFAULT_PROFILE;

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
    autoStartLabel: string;
    portsLabel: string;
    envLabel: string;
}

// Returns null when the container does not exist (docker inspect exits non-zero).
function inspectContainer(containerName: string): ContainerInfo | null {
    const fmt = `{{.State.Status}}|{{index .Config.Labels "${LABEL_SHADOWS}"}}|{{index .Config.Labels "${LABEL_PROFILE}"}}|{{index .Config.Labels "${LABEL_RUNTIME_ENV}"}}|{{index .Config.Labels "${LABEL_GIT_MODE}"}}|{{index .Config.Labels "${LABEL_AUTOSTART}"}}|{{index .Config.Labels "${LABEL_PORTS}"}}|{{index .Config.Labels "${LABEL_ENV}"}}`;
    const result = spawnSync("docker", ["inspect", "--format", fmt, containerName], { encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) return null;
    const clean = (s: string) => (s === "<no value>" ? "" : s);
    const [status = "", shadows = "", profile = "", runtimeEnv = "", gitMode = "", autoStart = "", ports = "", env = ""] = result.stdout
        .trim()
        .split("|");
    return {
        status,
        shadowLabel: clean(shadows),
        profileLabel: clean(profile),
        runtimeEnvLabel: clean(runtimeEnv),
        gitModeLabel: clean(gitMode),
        autoStartLabel: clean(autoStart),
        portsLabel: clean(ports),
        envLabel: clean(env),
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
    envConfig: EnvConfig; // Normalized env-file paths + inline vars from validateEnvConfig
    hasGit: boolean;
    gitMode: GitMode;
    shadowPatterns: string[]; // Raw patterns from totopo.yaml, used for agent context docs
    workspaceName: string;
    portMappings: PortMapping[]; // Normalized host->container mappings from validatePortsConfig
    webPort?: number; // Sticky host port for the web agent interface; its mapping is already in portMappings
    noCache?: boolean;
    quiet?: boolean; // Suppress log output and docker stdio; used by tests
}

export type ContainerStartStatus = "created" | "resumed" | "connected";

export interface ContainerStartResult {
    status: ContainerStartStatus;
    // The web port the container really publishes, which is not always the one that was asked for: the
    // create path re-probes it and drops the mapping when something took it in the meantime. Callers must
    // use this rather than opts.webPort - otherwise the launcher, the liveness probe and the end-of-session
    // stop prompt all end up talking to whatever now holds that port.
    webPort: number | null;
}

export async function startContainer(opts: StartContainerOpts): Promise<ContainerStartResult> {
    const {
        containerName,
        workspaceRoot,
        cacheDir,
        templatesDir,
        activeProfile,
        profileHook,
        expandedShadows,
        envConfig,
        hasGit,
        gitMode,
        shadowPatterns,
        workspaceName,
        portMappings,
        webPort,
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

    // --- Env fingerprint (inline vars + resolved file contents) -----------------------------------------------------------------------------
    // Covers inline vars and the contents of every existing env file, so editing either recreates the container.
    const currentEnvLabel = envLabel(envConfig);

    // --- Sync shadows and build mount args ------------------------------------------------------------------------------------------------
    ensureShadowsInSync(cacheDir, expandedShadows, workspaceRoot);
    const shadowMountArgs = buildShadowMountArgs(cacheDir, expandedShadows);

    // --- Agent context -------------------------------------------------------------------------------------------------------------------
    const agentDocs = buildAgentContextDocs(hasGit, shadowPatterns, gitMode);

    // --- Env args (env files + inline vars) ----------------------------------------------------------------------------------------------
    const envArgs = envRunArgs(envConfig);

    // --- Build mount args ----------------------------------------------------------------------------------------------------------------
    const agentMounts = buildAgentMountArgs(cacheDir);
    const pnpmStoreMounts = buildPnpmStoreMountArgs(cacheDir);
    // Shadow mounts must come AFTER the workspace mount to overlay correctly
    const mountArgs = ["-v", `${workspaceRoot}:${CONTAINER_WORKSPACE}`, ...shadowMountArgs, ...agentMounts, ...pnpmStoreMounts];

    // --- Auto-start agent (host-global) --------------------------------------------------------------------------------------------------
    // Read from the global config, not opts: the favorite agent is a person-level preference shared across
    // all workspaces, so every workspace's container reflects the same value.
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

    // --- Inspect container state ---------------------------------------------------------------------------------------------------------
    const info = inspectContainer(containerName);
    let containerStatus = info?.status ?? null;

    // --- Recreate if shadow, profile, runtime env, git mode, auto-start, or ports changed ------------------------------------------------
    if (info !== null) {
        const expectedShadowLabel = shadowLabel(expandedShadows);
        const shadowChanged = info.shadowLabel !== expectedShadowLabel;
        const profileChanged = info.profileLabel !== activeProfile;
        const runtimeEnvChanged = info.runtimeEnvLabel !== runtimeEnvLabel();
        const gitModeChanged = info.gitModeLabel !== gitMode;
        // Treat an absent label (pre-feature container) as "off" so a still-default setting does not force a
        // spurious recreate on the first upgrade - the stale-image prompt handles the mandatory rebuild instead.
        const autoStartChanged = (info.autoStartLabel || AUTO_START.off) !== autoStartAgent;
        // Both sides are "" when a workspace declares no ports, so a container without published ports never recreates on this label.
        const portsChanged = info.portsLabel !== currentPortsLabel;
        // Both sides are "" when a workspace declares no env, so a container without env injection never recreates on this label.
        const envChanged = info.envLabel !== currentEnvLabel;

        if (shadowChanged || profileChanged || runtimeEnvChanged || gitModeChanged || autoStartChanged || portsChanged || envChanged) {
            // Describe the change once - reused for the confirm prompt and the recreate log line below.
            let reason: string;
            if (profileChanged) reason = `Profile changed (${info.profileLabel} -> ${activeProfile})`;
            else if (shadowChanged) reason = "Shadow paths changed";
            else if (gitModeChanged) reason = `Git mode changed (${info.gitModeLabel || "<unset>"} -> ${gitMode})`;
            else if (portsChanged) reason = "Ports changed";
            else if (envChanged) reason = "Environment variables changed";
            else if (autoStartChanged) reason = `Auto-start changed (${info.autoStartLabel || AUTO_START.off} -> ${autoStartAgent})`;
            else reason = "Runtime environment updated";

            // A running container is a live session. Recreating it stops and removes the container, so confirm
            // before killing it - a config change should not surprise the user mid-session. Exited containers
            // have no live session, so skip the prompt. Non-interactive callers (quiet) keep the auto-recreate.
            const prompted = !quiet && info.status === "running";
            if (prompted) {
                log.warn(
                    `${reason} - applying this needs to recreate the running container, which stops any open sessions.\n` +
                        "Agent memory, settings, and workspace data are preserved.",
                );
                const recreate = await confirm({
                    message: "Recreate the container now?",
                    initialValue: true,
                });
                if (isCancel(recreate) || !recreate) {
                    cancel("Session cancelled - container left running.");
                    process.exit(0);
                }
            }

            stopAndRemoveContainer(containerName);
            containerStatus = null;

            // Profile change means a different Dockerfile, so drop the image to force a fresh build.
            if (profileChanged) spawnSync("docker", ["rmi", containerName], { stdio: "pipe" });

            // The confirm prompt above already stated the reason, so only print the progress line when we
            // did not prompt (an exited container recreated without confirmation).
            if (!quiet && !prompted) log.info(`${reason} - ${profileChanged ? "rebuilding" : "recreating container"}...`);
        }
    }

    // Refresh the agent context docs in the cache dir (bind-mounted into the container) once, before any
    // create / resume / connect path below. Idempotent file writes with no dependency on the image build.
    injectAgentContext(cacheDir, agentDocs);

    // What the container ends up publishing for the web interface. Only the create path can change it (by
    // dropping a mapping whose port was taken), and it is returned so the caller stops using the port it
    // asked for. Resume and connect reuse a container whose mapping is already fixed, and any change to it
    // would have recreated the container via the ports label.
    let publishedWebPort = webPort;

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

        // Minutes can pass between run() probing the web port and this create path (profile selection, a
        // recreate confirm, the image build), so re-probe it here. The interface is optional: a port taken in
        // the meantime drops the mapping and the session continues without it. Only totopo.yaml ports are
        // allowed to fail a session, which is what assertHostPortsAvailable below is for.
        let published = portMappings;
        if (webPort !== undefined && !(await webPortUsable(webPort, containerName))) {
            if (!quiet) {
                log.warn(`Web interface: host port ${webPort} was taken before the container could start - continuing without it.`);
            }
            published = portMappings.filter((m) => m.host !== webPort);
            publishedWebPort = undefined;
        }

        // Ports are static config, so probe host availability up front. The old container was already removed on
        // every path that reaches here, so we never probe our own live port. A taken host port fails clearly and
        // names the entry, before docker run - so no doomed `created` container is left behind on a clash.
        try {
            await assertHostPortsAvailable(published, publishedWebPort);
        } catch (err) {
            if (!quiet) outro(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }

        if (!quiet) log.info("Starting dev container...");

        // Only set when the web interface is enabled AND its port survived the re-probe above: this gates the
        // greeting hint, the webterm launcher, and the shell autostart handoff. Built here rather than with the
        // other runtime env so a dropped mapping cannot leave a URL behind that nothing is listening on.
        // Never stale either way: the web mapping is part of the ports label written just below, so a moved or
        // dropped port recreates the container and rebuilds this. No dedicated label needed for the same reason.
        const webEnvArgs = publishedWebPort !== undefined ? ["-e", `TOTOPO_WEB_URL=http://localhost:${publishedWebPort}`] : [];

        // portEnvArgs come after envArgs/runtimeEnvArgs/webEnvArgs so the published value wins any -e collision.
        const runArgs = [
            "run",
            "-d",
            "--name",
            containerName,
            ...mountArgs,
            ...envArgs,
            ...runtimeEnvArgs,
            ...webEnvArgs,
            ...portEnvArgs(published),
            ...portPublishArgs(published),
            "--security-opt",
            "no-new-privileges:true",
            ...labelArgs,
            "--label",
            // Labelled with what was actually published, not what was planned, so the next session compares
            // like for like: a dropped web mapping recreates once when the port comes back, not every start.
            `${LABEL_PORTS}=${portsLabel(published)}`,
            "--label",
            `${LABEL_ENV}=${currentEnvLabel}`,
            containerName,
            ...CONTAINER_KEEP_ALIVE,
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

    const result = (status: ContainerStartStatus): ContainerStartResult => ({ status, webPort: publishedWebPort ?? null });

    if (containerStatus === null) {
        // --- No container - build image and run --------------------------------------------------------------------------------------------
        await createAndRun();
        return result("created");
    } else if (containerStatus === "exited") {
        // --- Container stopped - resume (recreate on a dangling-mount failure) -------------------------------------------------------------
        if (!quiet) log.info("Resuming dev container...");
        const start = spawnSync("docker", ["start", containerName], { stdio });
        if (start.status !== 0) {
            // A resume reuses the bind mounts frozen at create time. When one no longer resolves on the host
            // - a moved or renamed workspace directory, a deleted env file, a relocated cache dir - docker
            // start fails. stderr is inherited, not captured, so do not parse the daemon error; treat any
            // resume failure as recreate-worthy. Recreating rebinds every mount against current paths; agent
            // memory, settings, and workspace data live in host bind mounts and cache dirs outside the
            // container fs, so they survive. Non-interactive callers keep the hard fail.
            if (quiet) process.exit(start.status ?? 1); // Non-interactive: preserve the original silent hard fail.
            log.warn(
                "This container could not start - a host path it was created against has likely moved or been removed\n" +
                    "  (for example the workspace directory was renamed).",
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
            return result("created");
        }
        return result("resumed");
    } else {
        // --- Container running - connect ---------------------------------------------------------------------------------------------------
        return result("connected");
    }
}

/**
 * Start the web interface and confirm it really came up. When the interface is on, the container's shell
 * hook deliberately does not launch an agent (the browser is meant to), so a launch that failed silently
 * would leave the user with an advertised URL that never answers and no agent anywhere. Nothing is started
 * in its place: the message says what to run, and the choice is the user's.
 * `workdir` is where its sessions open - the same directory the terminal session below lands in.
 */
async function launchWebInterface(
    containerName: string,
    agent: Exclude<AutoStartAgent, "off">,
    webPort: number,
    workdir: string,
): Promise<void> {
    if (await startWebtermAndVerify(containerName, agent, webPort, workdir)) return;
    log.warn(
        `Web interface: the server did not come up on port ${webPort}, so the URL in the greeting will not answer.\n` +
            `  Run \`webterm ${agent}\` in the container to see why, or just run \`${agent}\` in the terminal.`,
    );
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

    // --- Web agent interface port (host-global toggle, sticky per-workspace assignment) --------------------------------------------------
    // Pushing the mapping into portMappings is the whole wiring: publish args, the availability probe,
    // and the LABEL_PORTS recreate fingerprint all pick it up with no arg-builder changes.
    // The interface is optional, so every problem below drops it for this session and says why - it must
    // never fail a session the way a totopo.yaml port does. The sticky assignment is left alone in all
    // cases, so the next session picks the same port back up once whatever is in the way is gone.
    const webEnabled = readWebEnabled();
    let webPort: number | null = null;
    if (webEnabled) {
        const range = readWebRange();
        // What disqualifies a candidate port: this workspace already publishes it from totopo.yaml, or
        // something on the host holds it. Both move the sticky assignment rather than skipping the session -
        // the port sticks to wherever it was last put, so the workspace settles on one that works instead of
        // repeating the same conflict at every start. (A totopo.yaml entry can no longer target the
        // container-side web port at all: validatePortsConfig reserves it.)
        const declaredHosts = new Set(portMappings.map((m) => m.host));
        const usable = async (port: number) => !declaredHosts.has(port) && (await webPortUsable(port, containerName));
        const resolved = await resolveWebPort(ctx.workspaceId, range, usable);
        if (resolved.ok) {
            if (resolved.movedFrom !== undefined) {
                log.info(`Web interface: port ${resolved.movedFrom} was not available - moved to ${resolved.port} and kept there.`);
            }
            webPort = resolved.port;
            portMappings.push({ host: webPort, container: WEB_CONTAINER_PORT });
        } else if (resolved.reason === "exhausted") {
            log.warn(
                `Web interface: no free port left in ${formatWebRange(range)} - web interface skipped this session.\n` +
                    "  Widen the range in Settings > Web interface.",
            );
        } else {
            log.warn(
                "Web interface: the port assignment could not be recorded for this workspace - web interface skipped this session.\n" +
                    "  Check that the workspace cache dir is writable.",
            );
        }
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

    // --- Env (env files + inline vars) ---------------------------------------------------------------------------------------------------
    let envConfig: EnvConfig;
    try {
        envConfig = validateEnvConfig(yaml.env, workspaceDir);
    } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
    for (const warning of envWarnings(envConfig)) {
        log.warn(warning);
    }

    const hasGit = existsSync(join(workspaceDir, ".git"));

    // --- Git mode (per-workspace, host-side .lock) ---------------------------------------------------------------------------------------
    const gitMode = readGitMode(ctx.workspaceId) ?? GIT_MODE.local;

    // --- Start container -----------------------------------------------------------------------------------------------------------------
    const containerOpts: StartContainerOpts = {
        containerName,
        workspaceRoot: workspaceDir,
        cacheDir,
        templatesDir,
        activeProfile,
        profileHook,
        expandedShadows,
        envConfig,
        hasGit,
        gitMode,
        shadowPatterns,
        workspaceName: ctx.workspaceId,
        portMappings,
        ...(webPort !== null && { webPort }),
        ...(options?.noCache !== undefined && { noCache: options.noCache }),
    };
    let startResult = await startContainer(containerOpts);
    // The create path re-probes the web port and drops it when something took it while the image built, so
    // from here on the published port is the only one worth talking to.
    webPort = startResult.webPort;

    // --- Stale image check - prompt user to rebuild if image is outdated ------------------------------------------------------------------
    const dockerfileContent = buildDockerfile(join(templatesDir, "Dockerfile"), profileHook);
    const expectedBuildHash = computeBuildHash(dockerfileContent, templatesDir);
    let stale = isImageStale(containerName, expectedBuildHash);
    if (stale) {
        log.warn(
            "This container's image is out of date.\nPlease rebuild to update - this will not affect agent memory, settings, or your data.",
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
            startResult = await startContainer(containerOpts);
            webPort = startResult.webPort;
            stale = false;
        }
    }

    // --- Published ports notice (every session start: created / resumed / connected) -----------------------------------------------------
    // Ports are static config, so the notice derives straight from the mappings - no .lock lookup needed.
    // The web mapping is skipped here: its URL is announced by the container greeting, where it is actionable.
    // Matched on the container port, which validatePortsConfig reserves - so it can only ever be totopo's own
    // web mapping, and it is skipped whether or not the port survived the create path's re-probe.
    for (const m of portMappings) {
        if (m.container === WEB_CONTAINER_PORT) continue;
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

    // --- Once-per-container-start hooks (auto-resume marker + webterm auto-start) --------------------------------------------------------
    // Deliberately after the startup checks above: those update the AI CLIs inside the container, and the
    // interface spawns its agent the moment it comes up. Started any earlier, the browser would get a session
    // running the version the image was built with - a claude too old to know the current models - and the only
    // way out would be to wait for the update and start another session. The terminal never had this problem:
    // the login shell attaches below, after the update.
    //
    // Runs on the created AND resumed (docker start) paths, never on connect to an already-running container -
    // that is what makes the resume once-per-start. The marker is planted before the user's shell attaches, so
    // whichever session launches first (webterm PTY or the .bashrc hook) consumes a fresh marker and resumes
    // the most recent conversation; later sessions start fresh.
    if (startResult.status !== "connected") {
        const autoStartAgent = readAutoStartAgent();
        if (autoStartAgent !== AUTO_START.off) {
            plantResumeMarker(containerName, resumeCommandFor(autoStartAgent, cacheDir, workdir));
            if (webPort !== null) await launchWebInterface(containerName, autoStartAgent, webPort, workdir);
        }
    } else if (webPort !== null) {
        // Connecting to a container that is already up: the interface it started with should still be
        // serving. When it is not (crashed, or stopped by hand) the greeting would advertise a URL that
        // does not answer, so start it again. No resume marker here - this is not a container start, so
        // the relaunched interface opens a fresh conversation rather than re-resuming an old one.
        const autoStartAgent = readAutoStartAgent();
        if (autoStartAgent !== AUTO_START.off && !(await webInterfaceAnswers(webPort))) {
            await launchWebInterface(containerName, autoStartAgent, webPort, workdir);
        } else {
            // The interface has been serving since an earlier session, so the directory it was started with
            // is that session's, not this one's. Move it, so the browser opens new sessions where this
            // session was started from - the same promise the terminal below keeps.
            await setWebDefaultCwd(webPort, readWebKey(containerName), workdir);
        }
    }

    // --- Connect -------------------------------------------------------------------------------------------------------------------------
    const exec = spawnSync("docker", loginShellExecArgs(workdir, containerName), {
        stdio: "inherit",
    });

    // --- Offer to stop this workspace's container (last shell closed) --------------------------------------------------------------------
    // The container itself keeps running (CONTAINER_KEEP_ALIVE is PID 1) after the shell exits. When this was the last
    // shell to it, offer to stop it to free memory. Stop-only (no rm) so the next session resumes fast
    // via the "exited" -> docker start path; all platforms.
    // Agent sessions in the web interface are live conversations the shell scan cannot see - they run
    // inside the container, with no host client process - and they end with the container. So when the
    // interface reports any, the prompt says how many and defaults to keeping the container; stopping it
    // is still offered, because those sessions may be finished ones nobody has closed yet.
    if (containerSessionCount(containerName) === 0) {
        // The counts are behind the interface's key, so it is read from the container first - fresh, because
        // a new one is minted at every server start and nothing on the host keeps one.
        const webSessions = (webPort === null ? null : await webSessionInfo(webPort, readWebKey(containerName)))?.sessions ?? 0;
        if (webSessions > 0) {
            const count = webSessions === 1 ? "1 agent session is" : `${webSessions} agent sessions are`;
            const them = webSessions === 1 ? "it" : "them";
            log.warn(`Web interface: ${count} open in the browser - stopping the container ends ${them}.`);
        }
        const stopNow = await confirm({
            message: "Last session to this container closed. Stop it? (resumes fast)",
            initialValue: webSessions === 0,
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
