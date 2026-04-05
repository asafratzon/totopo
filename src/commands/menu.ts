// =========================================================================================================================================
// src/commands/menu.ts - totopo workspace menu
// Shows workspace status box with profile, non-git notice, and shadow info.
// =========================================================================================================================================

import { existsSync } from "node:fs";
import { join } from "node:path";
import { styleText } from "node:util";
import { box, cancel, isCancel, select } from "@clack/prompts";
import { PROFILE } from "../lib/constants.js";
import type { WorkspaceContext } from "../lib/workspace-identity.js";
import { readActiveProfile } from "../lib/workspace-identity.js";

interface MenuArgs {
    ctx: WorkspaceContext;
    activeCount: number;
    workspaceRunning: boolean;
}

export async function run(args: MenuArgs): Promise<string> {
    const { ctx, workspaceRunning } = args;

    // --- Read workspace config -----------------------------------------------------------------------------------------------------------
    const activeProfile = readActiveProfile(ctx.workspaceId) ?? PROFILE.default;
    const hasGit = existsSync(join(ctx.workspaceRoot, ".git"));

    // --- Status box ----------------------------------------------------------------------------------------------------------------------
    const containerStatus = workspaceRunning ? "running" : "stopped";
    const gitNotice = hasGit ? "" : `\n${styleText("yellow", "●")} no git — agent changes are not tracked`;

    box(`workspace:   ${ctx.displayName}\nprofile:     ${activeProfile}\ncontainer:   ${containerStatus}${gitNotice}`, " totopo ", {
        contentAlign: "left",
        titleAlign: "center",
        width: "auto",
        rounded: true,
    });

    // --- Menu ----------------------------------------------------------------------------------------------------------------------------
    type Option = { value: string; label: string; hint?: string };
    const options: Option[] = [
        { value: "dev", label: "Open session", hint: "start or resume the dev container" },
        ...(workspaceRunning ? [{ value: "stop", label: "Stop container", hint: "stops this workspace's container" }] : []),
        { value: "settings", label: "Manage Workspace", hint: "profiles, shadow paths, rebuild" },
        { value: "manage-totopo", label: "Manage totopo →", hint: "stop, clear, remove, uninstall" },
        { value: "quit", label: "Quit" },
    ];

    const action = await select({ message: "Menu:", options });

    if (isCancel(action)) {
        cancel();
        return "quit";
    }

    return action as string;
}
