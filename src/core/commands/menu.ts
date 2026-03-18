#!/usr/bin/env node
// =========================================================================================================================================
// src/core/commands/menu.ts — totopo interactive menu (powered by @clack/prompts)
// Invoked by bin/totopo.js — outputs selected action to stderr.
// =========================================================================================================================================

import { box, cancel, isCancel, select } from "@clack/prompts";

// Parse CLI args passed by bin/totopo.js: project name, active container count, API key presence, project state
const [projectName = "unknown", activeCountStr, hasKeyStr, projectRunningStr, projectImageExistsStr] = process.argv.slice(2);
const activeCount = Number.parseInt(activeCountStr ?? "0", 10);
const hasKey = hasKeyStr === "true";
const projectRunning = projectRunningStr === "true";
const projectImageExists = projectImageExistsStr === "true";

// ─── Status box ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sessionLabel = activeCount === 1 ? "1 container running" : `${activeCount} containers running`;
const lines = [];
lines.push(`status: ${sessionLabel}`);
lines.push(`api keys: ${hasKey ? "configured" : "none"} (.totopo/.env)`);
box(lines.join("\n"), ` totopo · ${projectName} `, {
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
        { value: "manage", label: "Manage workspaces" },
        { value: "doctor", label: "Doctor" },
        { value: "settings", label: "Settings" },
        { value: "quit", label: "Quit" },
    ],
});

if (isCancel(action)) {
    cancel();
    process.exit(0);
}

// Output action to stderr — ai.sh captures it via redirection
process.stderr.write(action as string);
