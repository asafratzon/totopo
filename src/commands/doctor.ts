// =========================================================================================================================================
// src/commands/doctor.ts - Host readiness check for totopo
// Runs silently on success; exits non-zero on failure.
// Pass verbose=true for a full report.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { log, outro } from "@clack/prompts";

// Returns true if the given CLI tool is resolvable in the system PATH
function commandExists(cmd: string): boolean {
    const r = spawnSync("command", ["-v", cmd], {
        shell: true,
        encoding: "utf8",
    });
    return r.status === 0;
}

export async function run(_workspaceDir: string | null, verbose: boolean): Promise<{ ok: boolean }> {
    const errors: string[] = [];

    function check(label: string, ok: boolean, detail?: string): void {
        if (ok) {
            if (verbose) log.success(`${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
        } else {
            errors.push(`${label}${detail ? `: ${detail}` : ""}`);
            if (verbose) log.error(`${label}${detail ? `  ${detail}` : ""}`);
        }
    }

    if (verbose) console.log("");

    // --- Docker installed ----------------------------------------------------------------------------------------------------------------
    const hasDocker = commandExists("docker");
    check("Docker installed", hasDocker, hasDocker ? undefined : "'docker' not found in PATH");

    // --- Docker running ------------------------------------------------------------------------------------------------------------------
    const dockerInfo = spawnSync("docker", ["info"], { encoding: "utf8", stdio: "pipe" });
    check("Docker running", dockerInfo.status === 0, dockerInfo.status === 0 ? undefined : "Docker daemon not responding");

    // --- Report --------------------------------------------------------------------------------------------------------------------------
    if (errors.length > 0) {
        if (verbose) {
            console.log("");
            log.error("totopo doctor found problems:");
            for (const err of errors) {
                console.log(`       \x1b[2m•\x1b[0m  ${err}`);
            }
            console.log("");
        }
        return { ok: false };
    }

    if (verbose) {
        console.log("");
        outro("All checks passed.");
    }

    return { ok: true };
}
