// =========================================================================================================================================
// src/lib/global-config.ts - Host-global settings store (not tied to any workspace)
// Lives at ~/.totopo/global/config as key=value lines, mirroring the per-workspace .lock idiom.
// Settings live here when they are host-wide rather than per-workspace.
// =========================================================================================================================================

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    AUTO_START,
    AUTO_START_AGENTS,
    type AutoStartAgent,
    GLOBAL_CONFIG_FILE,
    GLOBAL_DIR,
    TOTOPO_DIR,
    WEB_RANGE_DEFAULT,
} from "./constants.js";
import { formatWebRange, parseWebRange, type WebRange } from "./ports.js";

// --- Keys --------------------------------------------------------------------------------------------------------------------------------

/** Field names mapped to the keys written in the global config file. */
export const GLOBAL_CONFIG_KEYS = {
    autoStartAgent: "auto_start_agent",
    webEnabled: "web_enabled",
    webRange: "web_range",
} as const;

// --- Path --------------------------------------------------------------------------------------------------------------------------------

/** Absolute path to the global config file - ~/.totopo/global/config */
export function globalConfigPath(): string {
    return join(homedir(), TOTOPO_DIR, GLOBAL_DIR, GLOBAL_CONFIG_FILE);
}

// --- Parse / write -----------------------------------------------------------------------------------------------------------------------

// Parse the config into an ordered map of raw key=value pairs. Returns an empty map when the file is
// missing or unreadable - absence is not an error, it just means defaults apply. Unknown keys are kept
// so a newer totopo's settings survive a write by an older one.
function parseGlobalConfig(): Map<string, string> {
    const config = new Map<string, string>();
    try {
        const lines = readFileSync(globalConfigPath(), "utf8")
            .trimEnd()
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
        for (const line of lines) {
            const eq = line.indexOf("=");
            if (eq === -1) continue;
            config.set(line.slice(0, eq), line.slice(eq + 1));
        }
    } catch {
        // Missing or unreadable - treat as empty.
    }
    return config;
}

// Write the raw key=value map back to ~/.totopo/global/config, creating ~/.totopo/global/ on demand.
// Unlike the per-workspace lock (which no-ops when missing), the global config has no init step, so it
// is created lazily on the first write.
function writeGlobalConfig(config: Map<string, string>): void {
    mkdirSync(join(homedir(), TOTOPO_DIR, GLOBAL_DIR), { recursive: true });
    const content = `${[...config].map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
    writeFileSync(globalConfigPath(), content);
}

// --- Retired keys ------------------------------------------------------------------------------------------------------------------------

/**
 * Drop a key this totopo no longer knows, preserving every other key. Returns whether the file changed,
 * so a caller can stay quiet when there was nothing to remove. The key is passed as a literal by the
 * one caller that retires it (legacy-check.ts), because a retired name has no constant left to point at.
 */
export function removeGlobalConfigKey(key: string): boolean {
    const config = parseGlobalConfig();
    if (!config.delete(key)) return false;
    writeGlobalConfig(config);
    return true;
}

// --- Auto-start agent --------------------------------------------------------------------------------------------------------------------

/** Read the agent to auto-start on session entry. Defaults to off when unset, missing, or unrecognized. */
export function readAutoStartAgent(): AutoStartAgent {
    const value = parseGlobalConfig().get(GLOBAL_CONFIG_KEYS.autoStartAgent);
    return value !== undefined && (AUTO_START_AGENTS as readonly string[]).includes(value) ? (value as AutoStartAgent) : AUTO_START.off;
}

/** Write the agent to auto-start. Creates the config file on demand and preserves all other keys. */
export function writeAutoStartAgent(agent: AutoStartAgent): void {
    const config = parseGlobalConfig();
    config.set(GLOBAL_CONFIG_KEYS.autoStartAgent, agent);
    writeGlobalConfig(config);
}

// --- Web agent interface -----------------------------------------------------------------------------------------------------------------

/** Read whether the web agent interface is enabled. Defaults to false when unset, missing, or unrecognized. */
export function readWebEnabled(): boolean {
    return parseGlobalConfig().get(GLOBAL_CONFIG_KEYS.webEnabled) === "true";
}

/** Write the web agent interface toggle. Creates the config file on demand and preserves all other keys. */
export function writeWebEnabled(enabled: boolean): void {
    const config = parseGlobalConfig();
    config.set(GLOBAL_CONFIG_KEYS.webEnabled, String(enabled));
    writeGlobalConfig(config);
}

/** Read the web interface host-port range. Falls back to the default when unset, missing, or invalid. */
export function readWebRange(): WebRange {
    const value = parseGlobalConfig().get(GLOBAL_CONFIG_KEYS.webRange);
    const parsed = value !== undefined ? parseWebRange(value) : null;
    // The default is a constant that always parses; the assertion just narrows the type.
    return parsed ?? (parseWebRange(WEB_RANGE_DEFAULT) as WebRange);
}

/** Write the web interface host-port range. Creates the config file on demand and preserves all other keys. */
export function writeWebRange(range: WebRange): void {
    const config = parseGlobalConfig();
    config.set(GLOBAL_CONFIG_KEYS.webRange, formatWebRange(range));
    writeGlobalConfig(config);
}
