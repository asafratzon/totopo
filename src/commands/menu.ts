// =========================================================================================================================================
// src/commands/menu.ts - totopo workspace menu
// Shows workspace status box with profile, non-git notice, and shadow info.
// =========================================================================================================================================

import { existsSync } from "node:fs";
import { join } from "node:path";
import { styleText } from "node:util";
import { cancel, isCancel, log, select } from "@clack/prompts";
import { IS_MACOS } from "../lib/audio-host.js";
import { AUDIO_MODE, DEFAULT_PROFILE } from "../lib/constants.js";
import { readAudioMode } from "../lib/global-config.js";
import { readTotopoYaml } from "../lib/totopo-yaml.js";
import type { WorkspaceContext } from "../lib/workspace-identity.js";
import { readActiveProfile, readAudio } from "../lib/workspace-identity.js";

interface MenuArgs {
    ctx: WorkspaceContext;
    activeCount: number;
    workspaceRunning: boolean;
    audioServerRunning: boolean;
    version: string;
}

export async function run(args: MenuArgs): Promise<string> {
    const { ctx, activeCount, workspaceRunning, audioServerRunning, version } = args;

    // --- Read workspace config -----------------------------------------------------------------------------------------------------------
    const hasGit = existsSync(join(ctx.workspaceRoot, ".git"));
    const audioWiring = readAudio(ctx.workspaceId);

    // Profiles come from totopo.yaml (the source of truth). The lock file's active profile can be stale (e.g. a
    // profile since removed from totopo.yaml), so only trust it when it still exists. Mirror selectProfile() in
    // dev.ts: a single profile is no real choice, so omit the line entirely rather than show noise.
    let profileNames: string[] = [];
    try {
        profileNames = Object.keys(readTotopoYaml(ctx.workspaceRoot)?.profiles ?? {});
    } catch {
        // totopo.yaml is validated upstream; on any unexpected read error just omit the profile line.
    }
    const cachedProfile = readActiveProfile(ctx.workspaceId);
    // Fall back to a profile that actually exists (default if present, else the first) so the box never
    // shows a name absent from totopo.yaml. The line only renders when there are >1, so the list is non-empty there.
    const fallbackProfile = profileNames.includes(DEFAULT_PROFILE) ? DEFAULT_PROFILE : (profileNames[0] ?? DEFAULT_PROFILE);
    const activeProfile = cachedProfile && profileNames.includes(cachedProfile) ? cachedProfile : fallbackProfile;

    // --- Status line ---------------------------------------------------------------------------------------------------------------------
    // A single bold header line: version, then the workspace - with its container state shown only while
    // running - then an optional profile. Anything else (other containers, audio, git) drops to one quieter
    // notice line below.
    const boldSep = styleText(["bold", "gray"], " · ");

    // Append the running state (green) only when the container is up. A stopped container is the resting
    // default, so "container down" carries no signal - drop it and just name the workspace.
    const workspaceSegment = workspaceRunning
        ? `${styleText("bold", `${ctx.workspaceId} container`)} ${styleText(["bold", "green"], "up")}`
        : styleText("bold", ctx.workspaceId);

    const segments = [styleText("bold", `totopo v${version}`), workspaceSegment];
    if (profileNames.length > 1) segments.push(styleText("bold", `profile: ${activeProfile}`));
    const header = segments.join(boldSep);

    // --- Notices -------------------------------------------------------------------------------------------------------------------------
    // One quieter line under the header, its parts joined by a gray dot separator. Order: other containers,
    // audio, git. It only renders when at least one part applies, so the common case is just the header.
    const parts: string[] = [];
    // activeCount includes this workspace's container when it is up, so subtract it to count only the others.
    // The number always reads as "besides this one", and a lone running workspace shows nothing.
    const others = activeCount - (workspaceRunning ? 1 : 0);
    if (others > 0) parts.push(`${others} other container${others === 1 ? "" : "s"} up`);
    // Surface the host audio server. When this workspace has voice wiring on, show its state; when wiring is
    // off but the global server happens to be up, still nudge the user to stop it - totopo never stops it on
    // its own. In automatic mode (macOS) totopo starts the server on session open, so a "down" part is just
    // noise - suppress it. In manual mode (or off macOS) the user starts it, so the nudge stays.
    const autoStartsServer = IS_MACOS && readAudioMode() === AUDIO_MODE.automatic;
    if (audioWiring) {
        if (audioServerRunning) parts.push("audio server up");
        else if (!autoStartsServer) parts.push("audio server down");
    } else if (audioServerRunning) {
        parts.push("audio server up");
    }
    // No git means agent changes are not tracked. dev.ts only feeds this into the agent's context docs, so this
    // is the only warning a person sees - keep it here when the workspace is not a git repo.
    if (!hasGit) parts.push("no git");
    // The whole line is gray so it stays quieter than the bold header above it.
    const notices = parts.length > 0 ? [styleText("gray", parts.join(" · "))] : [];

    // Separate from whatever precedes it, then print the header and any notices as clack log lines - the gray
    // gutter lines up with the select menu that follows.
    process.stdout.write("\n");
    log.message([header, ...notices]);

    // --- Menu ----------------------------------------------------------------------------------------------------------------------------
    type Option = { value: string; label: string; hint?: string };
    const options: Option[] = [
        { value: "dev", label: "Open session", hint: "start or resume the dev container" },
        ...(workspaceRunning ? [{ value: "stop", label: "Stop container", hint: "stops this workspace's container" }] : []),
        { value: "settings", label: "Settings", hint: "git mode, shadow paths, voice, auto-start, rebuild" },
        { value: "advanced", label: "Advanced", hint: "stop, clear, remove, uninstall" },
        { value: "help", label: "Help", hint: "official docs" },
        { value: "quit", label: "Quit" },
    ];

    const action = await select({ message: "Menu:", options });

    if (isCancel(action)) {
        cancel();
        return "quit";
    }

    return action as string;
}
