// =========================================================================================================================================
// src/commands/menu.ts - totopo workspace menu
// Shows workspace status box with profile, non-git notice, and shadow info.
// =========================================================================================================================================

import { existsSync } from "node:fs";
import { join } from "node:path";
import { styleText } from "node:util";
import { box, cancel, isCancel, select } from "@clack/prompts";
import { IS_MACOS } from "../lib/audio-host.js";
import { AUDIO_MODE, PROFILE } from "../lib/constants.js";
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
    const { ctx, workspaceRunning, audioServerRunning, version } = args;

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
    const fallbackProfile = profileNames.includes(PROFILE.default) ? PROFILE.default : (profileNames[0] ?? PROFILE.default);
    const activeProfile = cachedProfile && profileNames.includes(cachedProfile) ? cachedProfile : fallbackProfile;
    const profileLine = profileNames.length > 1 ? `\nprofile:     ${activeProfile}` : "";

    // --- Status box ----------------------------------------------------------------------------------------------------------------------
    const containerStatus = workspaceRunning ? "running" : "stopped";
    const gitNotice = hasGit ? "" : `\n${styleText("yellow", "●")} no git — agent changes are not tracked`;
    // Surface the host audio server. When this workspace has voice wiring on, show its state at a glance
    // (running / not running). When wiring is off but the global server happens to be up, still nudge the
    // user to stop it - totopo never stops it on its own.
    const audioRunning = `\n${styleText("yellow", "●")} audio server running (Settings › Voice / audio)`;
    const audioStopped = `\n${styleText("gray", "●")} audio server not running (Settings › Voice / audio)`;
    // In automatic mode (macOS) totopo starts the server when a session opens, so a "not running" notice
    // is just noise - suppress it. In manual mode (or off macOS) the user starts it, so the nudge stays.
    const autoStartsServer = IS_MACOS && readAudioMode() === AUDIO_MODE.automatic;
    let audioNotice = "";
    if (audioWiring) {
        if (audioServerRunning) audioNotice = audioRunning;
        else if (!autoStartsServer) audioNotice = audioStopped;
    } else if (audioServerRunning) {
        audioNotice = audioRunning;
    }

    box(
        `workspace:   ${ctx.workspaceId}${profileLine}\ncontainer:   ${containerStatus}${gitNotice}${audioNotice}`,
        ` totopo v${version} `,
        {
            contentAlign: "left",
            titleAlign: "center",
            width: "auto",
            rounded: true,
        },
    );

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
