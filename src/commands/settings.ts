// =========================================================================================================================================
// src/commands/settings.ts - Settings submenu: git mode, shadow paths, voice, auto-start, rebuild, reset config
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { cancel, confirm, isCancel, log, multiselect, note, outro, path, select, text } from "@clack/prompts";
import { getStatus, IS_MACOS, installPulse, startServer, stopServer, testMic } from "../lib/audio-host.js";
import { AUDIO_MODE, AUDIO_TCP_PORT, AUTO_START, type AutoStartAgent, GIT_MODE, type GitMode } from "../lib/constants.js";
import { readAudioMode, readAutoStartAgent, writeAudioMode, writeAutoStartAgent } from "../lib/global-config.js";
import { countPatternHits } from "../lib/shadows.js";
import { buildDefaultTotopoYaml, readTotopoYaml, writeTotopoYaml } from "../lib/totopo-yaml.js";
import type { WorkspaceContext } from "../lib/workspace-identity.js";
import { readAudio, readGitMode, writeAudio, writeGitMode } from "../lib/workspace-identity.js";

// --- Shadow paths menu -------------------------------------------------------------------------------------------------------------------
async function shadowPathsMenu(ctx: WorkspaceContext): Promise<void> {
    const yaml = readTotopoYaml(ctx.workspaceRoot);
    if (!yaml) {
        log.error("totopo.yaml not found or invalid.");
        return;
    }

    const patterns = yaml.shadow_paths ?? [];

    if (patterns.length > 0) {
        const lines = patterns.map((p) => {
            const hits = countPatternHits(p, ctx.workspaceRoot);
            return `  ${p}  (${hits} ${hits === 1 ? "match" : "matches"})`;
        });
        note(lines.join("\n"), "Shadow patterns");
    } else {
        log.info("No shadow patterns configured.");
    }

    log.message(
        "Shadow patterns block the agent from seeing matching host paths -\n" +
            "the container gets an empty, isolated copy instead.\n" +
            "Supports gitignore-style patterns (e.g. node_modules, .env*).\n" +
            "Git-tracked paths are skipped to avoid worktree diversions.",
    );

    const options: { value: string; label: string }[] = [{ value: "add", label: "Add pattern or path" }];
    if (patterns.length > 0) {
        options.push({ value: "remove", label: "Remove patterns" });
    }
    options.push({ value: "back", label: "← Back" });

    const action = await select({ message: "Shadow paths:", options });

    if (isCancel(action) || action === "back") return;

    if (action === "add") {
        await addShadowPattern(ctx);
    } else if (action === "remove") {
        await removeShadowPatterns(ctx);
    }
}

async function addShadowPattern(ctx: WorkspaceContext): Promise<void> {
    const yaml = readTotopoYaml(ctx.workspaceRoot);
    if (!yaml) return;

    const patterns = [...(yaml.shadow_paths ?? [])];

    const typeChoice = await select({
        message: "Add:",
        options: [
            { value: "pattern", label: "Pattern", hint: "gitignore-style (e.g. .env*, *.log)" },
            { value: "path", label: "Specific path", hint: "pick a file or directory" },
        ],
    });

    if (isCancel(typeChoice)) return;

    if (typeChoice === "pattern") {
        const input = await text({
            message: "Pattern:",
            placeholder: "e.g. .env* or node_modules",
            validate: (v) => {
                const p = (v ?? "").trim();
                if (p.length === 0) return "Pattern cannot be empty";
                if (patterns.includes(p)) return "Pattern already exists";
                return undefined;
            },
        });
        if (isCancel(input)) return;

        const pattern = (input as string).trim();
        const hits = countPatternHits(pattern, ctx.workspaceRoot);
        patterns.push(pattern);
        log.info(`Added: ${pattern} (${hits} ${hits === 1 ? "match" : "matches"})`);
    } else {
        const selected = await path({
            message: "Path to shadow:",
            root: ctx.workspaceRoot,
            directory: true,
        });
        if (isCancel(selected)) return;

        const absPath = (selected as string).trim();
        const rel = relative(ctx.workspaceRoot, absPath);

        if (!rel || rel.startsWith("..")) {
            log.warn("Path must be inside the workspace directory. Skipped.");
            return;
        }

        if (patterns.includes(rel)) {
            log.warn(`"${rel}" is already in shadow patterns. Skipped.`);
            return;
        }

        patterns.push(rel);
        log.info(`Added: ${rel}`);
    }

    yaml.shadow_paths = patterns;
    writeTotopoYaml(ctx.workspaceRoot, yaml);
    await promptStopContainer(ctx);
}

async function removeShadowPatterns(ctx: WorkspaceContext): Promise<void> {
    const yaml = readTotopoYaml(ctx.workspaceRoot);
    if (!yaml?.shadow_paths?.length) return;

    const toRemove = await multiselect({
        message: "Select patterns to remove: (space to toggle, enter to confirm)",
        options: yaml.shadow_paths.map((p) => ({ value: p, label: p })),
    });

    if (isCancel(toRemove)) return;

    const removeSet = new Set(toRemove as string[]);
    yaml.shadow_paths = yaml.shadow_paths.filter((p) => !removeSet.has(p));
    writeTotopoYaml(ctx.workspaceRoot, yaml);
    log.success(`Removed ${removeSet.size} pattern(s).`);
    await promptStopContainer(ctx);
}

// --- Git mode menu -----------------------------------------------------------------------------------------------------------------------
async function gitModeMenu(ctx: WorkspaceContext): Promise<void> {
    const current = readGitMode(ctx.workspaceId) ?? GIT_MODE.local;

    note(
        "Local         - local mutations allowed; remote blocked\n" +
            "Strict        - read-only; mutations and remote blocked\n" +
            "Unrestricted  - no totopo-enforced restrictions",
        "Git mode",
    );

    const choice = await select<GitMode>({
        message: "Git mode:",
        options: [
            {
                value: GIT_MODE.local,
                label: "Local",
                hint: current === GIT_MODE.local ? "current · default" : "default",
            },
            { value: GIT_MODE.strict, label: "Strict", ...(current === GIT_MODE.strict ? { hint: "current" } : {}) },
            {
                value: GIT_MODE.unrestricted,
                label: "Unrestricted",
                ...(current === GIT_MODE.unrestricted ? { hint: "current" } : {}),
            },
        ],
        initialValue: current,
    });

    if (isCancel(choice)) return;
    if (choice === current) return;

    if (choice === GIT_MODE.unrestricted) {
        const confirmed = await confirm({
            message: "Unrestricted mode disables totopo's built-in git restrictions (allows remote push/pull/fetch). Continue?",
            initialValue: false,
        });
        if (isCancel(confirmed) || !confirmed) {
            log.info("Git mode unchanged.");
            return;
        }
    }

    writeGitMode(ctx.workspaceId, choice);
    log.success(`Git mode set to ${choice}.`);
    await promptStopContainer(ctx);
}

// --- Voice / audio menu ------------------------------------------------------------------------------------------------------------------
async function audioMenu(ctx: WorkspaceContext): Promise<void> {
    while (true) {
        const wiring = readAudio(ctx.workspaceId);
        const mode = readAudioMode();
        const status = getStatus();

        const serverLine = !status.installed ? "not installed" : status.running ? `running on TCP ${AUDIO_TCP_PORT}` : "installed, stopped";
        // The server-control mode only matters where totopo manages the server (macOS).
        const modeLine = IS_MACOS ? `\nmode:         ${mode}` : "";
        note(
            `wiring:       ${wiring ? "enabled" : "disabled"}  (this workspace)\n` +
                `host server:  ${serverLine}` +
                modeLine +
                (status.version ? `\nversion:      ${status.version}` : ""),
            "Voice / audio",
        );

        log.message(
            "Claude Code /voice needs a microphone, which the container does not have.\n" +
                "Enable wiring (per-workspace) and run a host PulseAudio server that streams your mic in.\n" +
                "The server exposes your mic over a local TCP port while it runs, so keep it up only while you need voice.",
        );

        if (!IS_MACOS) {
            log.info(
                "Host server control is automated on macOS only. On Linux/Windows, start a PulseAudio server on the host manually - see the README.",
            );
        }

        const options: { value: string; label: string; hint?: string }[] = [
            { value: "toggle", label: wiring ? "Disable wiring" : "Enable wiring", hint: "PulseAudio env for this workspace's container" },
        ];
        if (IS_MACOS) {
            options.push({
                value: "mode",
                label: `Auto start/stop: ${mode === AUDIO_MODE.automatic ? "on" : "off"}`,
                hint: "auto-start on session, stop on last exit",
            });
            if (!status.installed) options.push({ value: "install", label: "Install pulseaudio", hint: "via Homebrew" });
            if (status.installed && !status.running)
                options.push({ value: "start", label: "Start host server", hint: `TCP ${AUDIO_TCP_PORT}` });
            if (status.running) {
                options.push({ value: "test", label: "Test microphone", hint: "record 3s and check capture" });
                options.push({ value: "stop", label: "Stop host server" });
            }
        }
        options.push({ value: "back", label: "← Back" });

        const action = await select({ message: "Voice / audio:", options });
        if (isCancel(action) || action === "back") return;

        if (action === "toggle") {
            const next = !wiring;
            writeAudio(ctx.workspaceId, next);
            log.success(`Voice/audio wiring ${next ? "enabled" : "disabled"} for this workspace.`);
            await promptStopContainer(ctx);
            continue;
        }

        if (action === "mode") {
            // The host server is a single shared resource, so this mode is host-global. It only changes
            // server lifecycle behavior, not container config, so no rebuild prompt.
            const next = mode === AUDIO_MODE.automatic ? AUDIO_MODE.manual : AUDIO_MODE.automatic;
            writeAudioMode(next);
            log.success(
                next === AUDIO_MODE.automatic
                    ? "Automatic mode on - opening a session starts the host audio server; exiting stops it when no other session is connected."
                    : "Automatic mode off - start and stop the host audio server yourself.",
            );
            continue;
        }

        let result: { ok: boolean; message: string };
        if (action === "install") {
            result = installPulse();
        } else if (action === "start") {
            result = startServer();
        } else if (action === "stop") {
            result = stopServer();
        } else {
            log.info("Recording 3 seconds - speak now...");
            result = testMic();
        }

        if (result.ok) {
            log.success(result.message);
        } else {
            log.warn(result.message);
        }
    }
}

// --- Auto-start agent menu ---------------------------------------------------------------------------------------------------------------
async function autoStartMenu(ctx: WorkspaceContext): Promise<void> {
    const current = readAutoStartAgent();

    note(
        "When set, the chosen agent launches automatically as you enter the container; quit it and you drop to a shell.\n" +
            "This is a host-global preference - it applies to every workspace.",
        "Auto-start agent",
    );

    const choice = await select<AutoStartAgent>({
        message: "Auto-start agent:",
        options: [
            { value: AUTO_START.off, label: "Off", hint: current === AUTO_START.off ? "current · default" : "default" },
            { value: AUTO_START.claude, label: "Claude Code", hint: current === AUTO_START.claude ? "current · claude" : "claude" },
            { value: AUTO_START.opencode, label: "OpenCode", hint: current === AUTO_START.opencode ? "current · opencode" : "opencode" },
            { value: AUTO_START.codex, label: "Codex", hint: current === AUTO_START.codex ? "current · codex" : "codex" },
        ],
        initialValue: current,
    });

    if (isCancel(choice)) return;
    if (choice === current) return;

    writeAutoStartAgent(choice);
    log.success(
        choice === AUTO_START.off
            ? "Auto-start disabled - you'll land in a shell. Applies to all workspaces."
            : `Auto-start set to ${choice} for all workspaces.`,
    );
    await promptStopContainer(ctx);
}

// --- Prompt to stop container ------------------------------------------------------------------------------------------------------------
async function promptStopContainer(ctx: WorkspaceContext): Promise<void> {
    const containerName = ctx.containerName;
    const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", containerName], {
        encoding: "utf8",
        stdio: "pipe",
    });
    const containerStatus = inspect.status === 0 ? inspect.stdout.trim() : null;

    if (containerStatus !== "running") {
        log.info("Changes will apply on next session.");
        return;
    }

    const shouldStop = await confirm({ message: "Stop the running container so changes apply on next session?" });
    if (isCancel(shouldStop) || !shouldStop) {
        log.warn("Container still running with old config - it will be recreated on next session.");
        return;
    }

    log.info("Stopping container...");
    spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
    spawnSync("docker", ["rm", containerName], { stdio: "pipe" });
    log.info("Container removed. Open a new session to apply changes.");
}

// --- Reset totopo.yaml -------------------------------------------------------------------------------------------------------------------
async function resetTotopoYaml(ctx: WorkspaceContext): Promise<void> {
    const yaml = readTotopoYaml(ctx.workspaceRoot);
    if (!yaml) {
        log.error("totopo.yaml not found or invalid.");
        return;
    }

    note(
        "This will reset totopo.yaml to the minimal default (workspace_id + shadow_paths).\n" +
            "Your workspace_id is preserved; shadow_paths reset to the defaults (node_modules, .env*).\n" +
            "Any env, profiles, or ports settings will be removed - re-add them from the docs (menu > Help).",
        "Reset totopo.yaml",
    );

    const confirmed = await confirm({ message: "Reset totopo.yaml to defaults?" });
    if (isCancel(confirmed) || !confirmed) return;

    const freshYaml = buildDefaultTotopoYaml(yaml.workspace_id);
    writeTotopoYaml(ctx.workspaceRoot, freshYaml);
    log.success("totopo.yaml reset to defaults.");

    await promptStopContainer(ctx);
}

// --- Settings submenu --------------------------------------------------------------------------------------------------------------------
export async function run(ctx: WorkspaceContext): Promise<"back" | "rebuild" | "clean-rebuild" | undefined> {
    while (true) {
        const currentGitMode = readGitMode(ctx.workspaceId) ?? GIT_MODE.local;
        const options: { value: string; label: string; hint?: string }[] = [
            { value: "git-mode", label: "Git mode", hint: `current: ${currentGitMode}` },
            { value: "shadow-paths", label: "Shadow paths", hint: "manage shadow patterns" },
            { value: "audio", label: "Voice / audio", hint: "Claude Code /voice mic setup" },
            { value: "auto-start", label: "Auto-start agent", hint: `current: ${readAutoStartAgent()}` },
            { value: "rebuild", label: "Rebuild container", hint: "force a fresh image build" },
            { value: "clean-rebuild", label: "Clean rebuild", hint: "fresh build, no cache" },
            { value: "reset", label: "Reset config", hint: "restore totopo.yaml to defaults" },
            { value: "back", label: "← Back" },
        ];

        const action = await select({ message: "Settings:", options });

        if (isCancel(action) || action === "back") {
            return "back";
        }

        switch (action) {
            case "git-mode":
                await gitModeMenu(ctx);
                break;
            case "shadow-paths":
                await shadowPathsMenu(ctx);
                break;
            case "audio":
                await audioMenu(ctx);
                break;
            case "auto-start":
                await autoStartMenu(ctx);
                break;
            case "rebuild":
                return "rebuild";
            case "clean-rebuild":
                return "clean-rebuild";
            case "reset":
                await resetTotopoYaml(ctx);
                break;
        }
    }
}

// --- Stop workspace container ------------------------------------------------------------------------------------------------------------
export async function stop(containerName: string): Promise<void> {
    const inspectResult = spawnSync("docker", ["inspect", "--type", "container", containerName], { encoding: "utf8" });

    if (inspectResult.status !== 0) {
        log.info(`Container ${containerName} is not running.`);
        return;
    }

    const confirmed = await confirm({ message: `Stop ${containerName}?` });
    if (isCancel(confirmed) || !confirmed) {
        cancel();
        return;
    }

    log.info(`Stopping ${containerName}...`);
    spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
    spawnSync("docker", ["rm", containerName], { stdio: "pipe" });

    outro(`${containerName} stopped and removed.`);
}

// --- Reset workspace image (stop container + remove image for fresh rebuild) -------------------------------------------------------------
// Returns false when the user declines a running-container rebuild, so the caller can skip the fresh build
// and leave the live session untouched.
export async function resetImage(containerName: string): Promise<boolean> {
    const statusResult = spawnSync("docker", ["inspect", "--type", "container", "--format", "{{.State.Status}}", containerName], {
        encoding: "utf8",
        stdio: "pipe",
    });
    const containerExists = statusResult.status === 0;
    const running = containerExists && statusResult.stdout.trim() === "running";

    // A running container is a live session. A rebuild stops and removes it first, so confirm before
    // killing it out from under the user rather than surprising them mid-session.
    if (running) {
        log.warn("Rebuilding stops and removes the running container.\nAgent memory, settings, and workspace data are preserved.");
        const proceed = await confirm({ message: "Rebuild now?", initialValue: true });
        if (isCancel(proceed) || !proceed) {
            cancel("Rebuild cancelled - container left running.");
            return false;
        }
    }

    if (containerExists) {
        log.info(`Stopping container ${containerName}...`);
        spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
        spawnSync("docker", ["rm", containerName], { stdio: "pipe" });
    }

    const imageResult = spawnSync("docker", ["images", "-q", containerName], { encoding: "utf8", stdio: "pipe" });
    if ((imageResult.stdout ?? "").trim().length > 0) {
        log.info(`Removing image ${containerName}...`);
        spawnSync("docker", ["rmi", containerName], { stdio: "pipe" });
    }

    log.info("Image removed - starting fresh build…");
    return true;
}
