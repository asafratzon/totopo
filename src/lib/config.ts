// =========================================================================================================================================
// src/lib/config.ts - per-project totopo settings (persisted to settings.json)
// totopoDir is ~/.totopo/projects/<id>/ - callers resolve this via project-identity.ts
// =========================================================================================================================================

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type RuntimeMode = "full" | "host-mirror";

export interface TotopoSettings {
    runtimeMode: RuntimeMode;
    selectedTools: string[]; // only meaningful in host-mirror mode
    shadowPaths: string[];
}

const DEFAULTS: TotopoSettings = {
    runtimeMode: "host-mirror",
    selectedTools: [],
    shadowPaths: [],
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
            shadowPaths:
                Array.isArray(raw.shadowPaths) && raw.shadowPaths.every((p: unknown) => typeof p === "string") ? raw.shadowPaths : [],
        };
    } catch {
        return { ...DEFAULTS };
    }
}

export function writeSettings(totopoDir: string, s: TotopoSettings): void {
    writeFileSync(join(totopoDir, "settings.json"), `${JSON.stringify(s, null, 4)}\n`);
}
