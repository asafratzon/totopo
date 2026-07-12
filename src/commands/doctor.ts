// =========================================================================================================================================
// src/commands/doctor.ts - Host readiness check for totopo
// Computes readiness checks and returns any failures; the caller decides what to print.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";

// Returns true if the given CLI tool is resolvable in the system PATH
function commandExists(cmd: string): boolean {
    // Single command string (not an args array) under shell: true sidesteps Node's DEP0190; cmd is a hardcoded internal name.
    const r = spawnSync(`command -v ${cmd}`, {
        shell: true,
        encoding: "utf8",
    });
    return r.status === 0;
}

export async function run(): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];

    function check(label: string, ok: boolean, detail?: string): void {
        if (!ok) errors.push(`${label}${detail ? `: ${detail}` : ""}`);
    }

    // --- Docker installed ----------------------------------------------------------------------------------------------------------------
    const hasDocker = commandExists("docker");
    check("Docker installed", hasDocker, hasDocker ? undefined : "'docker' not found in PATH");

    // --- Docker running ------------------------------------------------------------------------------------------------------------------
    const dockerInfo = spawnSync("docker", ["info"], { encoding: "utf8", stdio: "pipe" });
    check("Docker running", dockerInfo.status === 0, dockerInfo.status === 0 ? undefined : "Docker daemon not responding");

    // --- Report --------------------------------------------------------------------------------------------------------------------------
    return { ok: errors.length === 0, errors };
}
