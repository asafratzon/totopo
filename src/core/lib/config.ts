// =============================================================================
// src/core/settings.ts — per-repo totopo settings (persisted to .totopo/settings.json)
// =============================================================================

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type RuntimeMode = "full" | "host-mirror";

export interface TotopoSettings {
    runtimeMode: RuntimeMode;
    selectedTools: string[]; // only meaningful in host-mirror mode
}

const DEFAULTS: TotopoSettings = {
    runtimeMode: "host-mirror",
    selectedTools: [],
};

export function readSettings(totopoDir: string): TotopoSettings {
    const settingsPath = join(totopoDir, "settings.json");
    if (!existsSync(settingsPath)) {
        return { ...DEFAULTS };
    }
    try {
        const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
        return {
            runtimeMode: raw.runtimeMode === "full" ? "full" : "host-mirror",
            selectedTools: Array.isArray(raw.selectedTools) ? raw.selectedTools : [],
        };
    } catch {
        return { ...DEFAULTS };
    }
}

export function writeSettings(totopoDir: string, s: TotopoSettings): void {
    writeFileSync(join(totopoDir, "settings.json"), `${JSON.stringify(s, null, 4)}\n`);
}
