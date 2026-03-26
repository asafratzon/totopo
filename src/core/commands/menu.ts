// =========================================================================================================================================
// src/core/commands/menu.ts — totopo project menu (powered by @clack/prompts)
// Invoked by bin/totopo.js for a known registered project — returns selected action string.
// =========================================================================================================================================

import { box, cancel, isCancel, select } from "@clack/prompts";
import type { ProjectContext } from "../lib/project-identity.js";

interface MenuArgs {
    ctx: ProjectContext;
    activeCount: number;
    projectRunning: boolean;
    hasTotopoYaml: boolean;
}

export async function run(args: MenuArgs): Promise<string> {
    const { ctx, activeCount, projectRunning, hasTotopoYaml } = args;

    // ─── Status box ──────────────────────────────────────────────────────────────
    const containersLabel = activeCount === 0 ? "none" : activeCount === 1 ? "1 running" : `${activeCount} running`;
    const containerStatus = projectRunning ? "running" : "stopped";
    box(
        `project:     ${ctx.meta.displayName}\ncontainer:   ${containerStatus}\nall:         ${containersLabel}\nkeys:        ~/.totopo/.env`,
        " totopo ",
        { contentAlign: "left", titleAlign: "center", width: "auto", rounded: true },
    );

    // ─── Menu ────────────────────────────────────────────────────────────────────
    type Option = { value: string; label: string; hint?: string };
    const options: Option[] = [
        { value: "dev", label: "Open session", hint: "start or resume the dev container" },
        ...(projectRunning ? [{ value: "stop", label: "Stop container", hint: "stops this project's container" }] : []),
        { value: "settings", label: "Runtime mode", hint: "switch between host-mirror and full" },
        { value: "rebuild", label: "Rebuild container", hint: "force a fresh image build" },
        ...(!hasTotopoYaml ? [{ value: "add-anchor", label: "Add project anchor", hint: "create totopo.yaml for shared onboarding" }] : []),
        { value: "manage-totopo", label: "Manage totopo →", hint: "stop, clear, remove, reset, uninstall" },
        { value: "quit", label: "Quit" },
    ];

    const action = await select({ message: "Menu:", options });

    if (isCancel(action)) {
        cancel();
        return "quit";
    }

    return action as string;
}
