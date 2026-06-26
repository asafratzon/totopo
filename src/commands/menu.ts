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
    const activeProfile = readActiveProfile(ctx.workspaceId) ?? PROFILE.default;
    const hasGit = existsSync(join(ctx.workspaceRoot, ".git"));
    const audioWiring = readAudio(ctx.workspaceId);

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
        `workspace:   ${ctx.workspaceId}\nprofile:     ${activeProfile}\ncontainer:   ${containerStatus}${gitNotice}${audioNotice}`,
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
        { value: "settings", label: "Settings", hint: "git mode, shadow paths, voice, rebuild" },
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
