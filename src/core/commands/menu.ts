// =========================================================================================================================================
// src/core/commands/menu.ts — totopo interactive menu (powered by @clack/prompts)
// Invoked by bin/totopo.js — returns selected action string.
// =========================================================================================================================================

import { box, cancel, isCancel, select } from "@clack/prompts";

interface MenuArgs {
    projectName: string;
    activeCount: number;
    hasKey: boolean;
    projectRunning: boolean;
    projectImageExists: boolean;
}

export async function run(args: MenuArgs): Promise<string> {
    const { projectName, activeCount, projectRunning, projectImageExists } = args;

    // ─── Status box ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const containersLabel = activeCount === 0 ? "none" : activeCount === 1 ? "1 running" : `${activeCount} running`;
    const lines = [];
    lines.push(`workspace:   ${projectName}`);
    lines.push(`containers:  ${containersLabel}`);
    box(lines.join("\n"), " totopo ", {
        contentAlign: "center",
        titleAlign: "center",
        width: "auto",
        rounded: true,
    });

    // ─── Menu ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const action = await select({
        message: "Menu:",
        options: [
            { value: "dev", label: "Start session" },
            ...(projectRunning ? [{ value: "stop", label: "Stop" }] : []),
            ...(projectImageExists ? [{ value: "rebuild", label: "Rebuild" }] : []),
            { value: "settings", label: "Settings" },
            { value: "manage", label: "Manage workspaces" },
            { value: "doctor", label: "Doctor" },
            { value: "quit", label: "Quit" },
        ],
    });

    if (isCancel(action)) {
        cancel();
        return "quit";
    }

    return action as string;
}
