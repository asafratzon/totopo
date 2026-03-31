// =========================================================================================================================================
// src/commands/menu.ts - totopo project menu
// Shows project status box with profile, non-git notice, and shadow info.
// =========================================================================================================================================

import { existsSync } from "node:fs";
import { join } from "node:path";
import { box, cancel, isCancel, select } from "@clack/prompts";
import type { ProjectContext } from "../lib/project-identity.js";
import { readActiveProfile } from "../lib/project-identity.js";
import { readTotopoYaml } from "../lib/totopo-yaml.js";

interface MenuArgs {
    ctx: ProjectContext;
    activeCount: number;
    projectRunning: boolean;
}

export async function run(args: MenuArgs): Promise<string> {
    const { ctx, activeCount, projectRunning } = args;

    // --- Read project config -------------------------------------------------------------------------------------------------------------
    const yaml = readTotopoYaml(ctx.projectRoot);
    const activeProfile = readActiveProfile(ctx.projectId) ?? "default";
    const shadowCount = yaml?.shadow_paths?.length ?? 0;
    const hasGit = existsSync(join(ctx.projectRoot, ".git"));

    // --- Status box ----------------------------------------------------------------------------------------------------------------------
    const containersLabel = activeCount === 0 ? "none" : activeCount === 1 ? "1 running" : `${activeCount} running`;
    const containerStatus = projectRunning ? "running" : "stopped";
    const profileCount = yaml?.profiles ? Object.keys(yaml.profiles).length : 0;
    const profileLabel = profileCount > 1 ? `${activeProfile} (${profileCount} available)` : activeProfile;
    const shadowLine = shadowCount > 0 ? `\nshadows:     ${shadowCount === 1 ? "1 pattern" : `${shadowCount} patterns`}` : "";
    const gitNotice = hasGit ? "" : "\n⚠ no git — agent changes are not tracked";

    box(
        `project:     ${ctx.displayName}\nprofile:     ${profileLabel}\ncontainer:   ${containerStatus}\nall:         ${containersLabel}${shadowLine}${gitNotice}`,
        " totopo ",
        { contentAlign: "left", titleAlign: "center", width: "auto", rounded: true },
    );

    // --- Menu ----------------------------------------------------------------------------------------------------------------------------
    type Option = { value: string; label: string; hint?: string };
    const options: Option[] = [
        { value: "dev", label: "Open session", hint: "start or resume the dev container" },
        ...(projectRunning ? [{ value: "stop", label: "Stop container", hint: "stops this project's container" }] : []),
        { value: "settings", label: "Project Settings", hint: "profiles, shadow paths" },
        { value: "rebuild", label: "Rebuild container", hint: "force a fresh image build" },
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
