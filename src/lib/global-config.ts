// =========================================================================================================================================
// src/lib/global-config.ts - Host-global settings store (not tied to any workspace)
// Lives at ~/.totopo/global/config as key=value lines, mirroring the per-workspace .lock idiom.
// The host audio server is a single shared resource, so its control mode is global, not per-workspace.
// =========================================================================================================================================

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUDIO_MODE, AUDIO_MODES, type AudioMode, GLOBAL_CONFIG_FILE, GLOBAL_DIR, TOTOPO_DIR } from "./constants.js";

// --- Keys --------------------------------------------------------------------------------------------------------------------------------

/** Field names mapped to the keys written in the global config file. */
export const GLOBAL_CONFIG_KEYS = {
    audioMode: "audio_mode",
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

// --- Audio mode --------------------------------------------------------------------------------------------------------------------------

/** Read the host audio server control mode. Defaults to manual when unset, missing, or unrecognized. */
export function readAudioMode(): AudioMode {
    const value = parseGlobalConfig().get(GLOBAL_CONFIG_KEYS.audioMode);
    return value !== undefined && (AUDIO_MODES as readonly string[]).includes(value) ? (value as AudioMode) : AUDIO_MODE.manual;
}

/** Write the host audio server control mode. Creates the config file on demand and preserves all other keys. */
export function writeAudioMode(audioMode: AudioMode): void {
    const config = parseGlobalConfig();
    config.set(GLOBAL_CONFIG_KEYS.audioMode, audioMode);
    writeGlobalConfig(config);
}
