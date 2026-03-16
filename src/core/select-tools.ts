// =============================================================================
// src/core/select-tools.ts — multiselect UI for choosing container runtimes
// =============================================================================

import { cancel, isCancel, log, multiselect } from "@clack/prompts";
import type { HostRuntimes } from "./detect-host.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

interface ToolEntry {
    key: keyof HostRuntimes;
    label: string;
}

// Node is always included — not shown as a checkbox
const OPTIONAL_TOOLS: ToolEntry[] = [
    { key: "python", label: "Python" },
    { key: "go", label: "Go" },
    { key: "rust", label: "Rust / Cargo" },
    { key: "java", label: "Java (Temurin)" },
    { key: "bun", label: "Bun" },
];

export async function selectTools(hostRuntimes: HostRuntimes): Promise<string[]> {
    // Node is always included — show as a fixed line, not a deselectable checkbox
    const nodeVersion = hostRuntimes.node ? `v${hostRuntimes.node} · host` : "latest";
    log.success(`Node.js  ${dim(`${nodeVersion} · always included`)}`);

    const options = OPTIONAL_TOOLS.map(({ key, label }) => {
        const detected = hostRuntimes[key];
        return {
            value: key as string,
            label: detected ? `${label}  ${dim(`v${detected} · host`)}` : `${label}  ${dim("latest")}`,
        };
    });

    const initialValues = OPTIONAL_TOOLS.filter(({ key }) => hostRuntimes[key] !== undefined).map(({ key }) => key as string);

    const selected = await multiselect({
        message: `Select additional tools:\n   ${dim("Space to toggle · Enter to confirm")}`,
        options,
        initialValues,
        required: false,
    });

    if (isCancel(selected)) {
        cancel("Cancelled.");
        process.exit(0);
    }

    return ["node", ...(selected as string[])];
}
