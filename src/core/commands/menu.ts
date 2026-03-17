#!/usr/bin/env node
// =========================================================================================================================================
// scripts/menu.ts — totopo interactive menu (powered by @clack/prompts)
// Called by ai.sh — outputs selected action to stderr.
// =========================================================================================================================================

import { box, cancel, isCancel, select } from "@clack/prompts";

// Parse CLI args passed by ai.sh: project name, active container count, and API key presence flag
const [projectName = "unknown", activeCountStr, hasKeyStr] = process.argv.slice(2);
const activeCount = Number.parseInt(activeCountStr ?? "0", 10);
const hasKey = hasKeyStr === "true";

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
        { value: "stop", label: "Stop all" },
        { value: "reset", label: "Reset (wipe workspaces + images)" },
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
