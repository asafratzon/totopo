// =========================================================================================================================================
// src/commands/menu.ts - totopo workspace menu
// Shows workspace status box with profile, non-git notice, and shadow info.
// =========================================================================================================================================

import { existsSync } from "node:fs";
import { join } from "node:path";
import { box, cancel, isCancel, select } from "@clack/prompts";
import { readTotopoYaml } from "../lib/totopo-yaml.js";
import type { WorkspaceContext } from "../lib/workspace-identity.js";
import { readActiveProfile } from "../lib/workspace-identity.js";

interface MenuArgs {
    ctx: WorkspaceContext;
    activeCount: number;
    workspaceRunning: boolean;
}

export async function run(args: MenuArgs): Promise<string> {
    const { ctx, activeCount, workspaceRunning } = args;

    // --- Read workspace config -----------------------------------------------------------------------------------------------------------
    const yaml = readTotopoYaml(ctx.workspaceRoot);
    const activeProfile = readActiveProfile(ctx.workspaceId) ?? "default";
    const shadowCount = yaml?.shadow_paths?.length ?? 0;
    const hasGit = existsSync(join(ctx.workspaceRoot, ".git"));

    // --- Status box ----------------------------------------------------------------------------------------------------------------------
    const containersLabel = activeCount === 0 ? "none" : activeCount === 1 ? "1 running" : `${activeCount} running`;
    const containerStatus = workspaceRunning ? "running" : "stopped";
    const profileCount = yaml?.profiles ? Object.keys(yaml.profiles).length : 0;
    const profileLabel = profileCount > 1 ? `${activeProfile} (${profileCount} available)` : activeProfile;
    const shadowLine = shadowCount > 0 ? `\nshadows:     ${shadowCount === 1 ? "1 pattern" : `${shadowCount} patterns`}` : "";
    const gitNotice = hasGit ? "" : "\n⚠ no git — agent changes are not tracked";

    box(
        `workspace:   ${ctx.displayName}\nprofile:     ${profileLabel}\ncontainer:   ${containerStatus}\nall:         ${containersLabel}${shadowLine}${gitNotice}`,
        " totopo ",
        { contentAlign: "left", titleAlign: "center", width: "auto", rounded: true },
    );

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
