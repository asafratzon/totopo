#!/usr/bin/env node
// =========================================================================================================================================
// scripts/doctor.ts — Host readiness check for totopo
// Runs silently on success; exits non-zero on failure.
// Pass --verbose for a full report.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { log, outro } from "@clack/prompts";

const verbose = process.argv.includes("--verbose");
const repoRoot = process.env.TOTOPO_REPO_ROOT;
if (!repoRoot) {
    log.error("TOTOPO_REPO_ROOT not set — run via ai.sh");
    process.exit(1);
}

const errors: string[] = [];

// Logs the result of a single health check; accumulates failures into the errors array for the final report
function check(label: string, ok: boolean, detail?: string): void {
    if (ok) {
        if (verbose) log.success(`${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
    } else {
        errors.push(`${label}${detail ? `: ${detail}` : ""}`);
        if (verbose) log.error(`${label}${detail ? `  ${detail}` : ""}`);
    }
}

// Returns true if the given CLI tool is resolvable in the system PATH
function commandExists(cmd: string): boolean {
    const r = spawnSync("command", ["-v", cmd], {
        shell: true,
        encoding: "utf8",
    });
    return r.status === 0;
}

if (verbose) console.log("");

// ─── Docker installed ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
check("Docker installed", commandExists("docker"), commandExists("docker") ? undefined : "'docker' not found in PATH");

// ─── Docker running ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const dockerInfo = spawnSync("docker", ["info"], {
    encoding: "utf8",
    stdio: "pipe",
});
check("Docker running", dockerInfo.status === 0, dockerInfo.status === 0 ? undefined : "Docker daemon not responding");

// ─── .totopo/ config present ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const configOk = existsSync(`${repoRoot}/.totopo/Dockerfile`);
check(".totopo/ config present", configOk, configOk ? undefined : "missing .totopo/Dockerfile");

// ─── Report ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (errors.length > 0) {
    if (verbose) {
        console.log("");
        log.error("totopo doctor found problems:");
        for (const err of errors) {
            console.log(`       \x1b[2m•\x1b[0m  ${err}`);
        }
        console.log("");
    }
    process.exit(1);
}

if (verbose) {
    console.log("");
    outro("All checks passed.");
}
