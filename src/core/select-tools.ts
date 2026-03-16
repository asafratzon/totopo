// =============================================================================
// src/core/select-tools.ts — multiselect UI for choosing container runtimes
// =============================================================================

import { cancel, isCancel, multiselect } from "@clack/prompts";
import type { HostRuntimes } from "./detect-host.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

interface ToolEntry {
    key: keyof HostRuntimes;
    label: string;
}

const TOOL_CATALOGUE: ToolEntry[] = [
    { key: "node", label: "Node.js" },
    { key: "python", label: "Python" },
    { key: "go", label: "Go" },
    { key: "rust", label: "Rust / Cargo" },
    { key: "java", label: "Java (Temurin)" },
    { key: "bun", label: "Bun" },
];

export async function selectTools(hostRuntimes: HostRuntimes): Promise<string[]> {
    const options = TOOL_CATALOGUE.map(({ key, label }) => {
        const detected = hostRuntimes[key];
        const base = {
            value: key as string,
            label: detected ? `${label}  ${dim(`v${detected} · host`)}` : `${label}  ${dim("latest")}`,
            selected: detected !== undefined,
        };
        return key === "node" ? { ...base, hint: "required" } : base;
    });

    const selected = await multiselect({
        message: "Select tools to include in container:",
        options,
        required: false,
    });

    if (isCancel(selected)) {
        cancel("Cancelled.");
        process.exit(0);
    }

    const result = [...(selected as string[])];

    // Node is always forced-selected — AI tools (claude, kilo, opencode) require it
    if (!result.includes("node")) {
        result.unshift("node");
    }

    return result;
}
