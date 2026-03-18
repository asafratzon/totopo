#!/usr/bin/env node
// =========================================================================================================================================
// src/core/commands/menu.ts — totopo interactive menu (powered by @clack/prompts)
// Invoked by bin/totopo.js — outputs selected action to stderr.
// =========================================================================================================================================

import { box, cancel, isCancel, select } from "@clack/prompts";

// Parse CLI args passed by bin/totopo.js: project name, active container count, project state
const [projectName = "unknown", activeCountStr, , projectRunningStr, projectImageExistsStr] = process.argv.slice(2);
const activeCount = Number.parseInt(activeCountStr ?? "0", 10);
const projectRunning = projectRunningStr === "true";
const projectImageExists = projectImageExistsStr === "true";

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
    process.exit(0);
}

// Output action to stderr — ai.sh captures it via redirection
process.stderr.write(action as string);
