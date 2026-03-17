#!/usr/bin/env node
// =============================================================================
// bin/totopo.js — totopo entry point
// Run this from your project directory (or via npx totopo).
// =============================================================================

import { execSync, spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Guard: inside container ──────────────────────────────────────────────────
try {
    if (execSync("whoami", { encoding: "utf8" }).trim() === "devuser") {
        console.error("");
        console.error("  You are running totopo from inside the dev container.");
        console.error("  Open a terminal on your host machine and run:");
        console.error("");
        console.error("    totopo  (or npx totopo from your project directory)");
        console.error("");
        process.exit(1);
    }
} catch {
    // whoami unavailable — not blocking
}

// ─── Paths ────────────────────────────────────────────────────────────────────
// realpathSync resolves the npm symlink in node_modules/.bin/ back to the
// real package root, so TOTOPO_PACKAGE_DIR is always the installed package.
const packageDir = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));

let repoRoot;
try {
    repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
} catch {
    console.error("");
    console.error("  No git repository found.");
    console.error("");
    console.error("  totopo requires a git repository. Run 'git init' first, then re-run totopo.");
    console.error("");
    process.exit(1);
}

process.env.TOTOPO_PACKAGE_DIR = packageDir;
process.env.TOTOPO_REPO_ROOT = repoRoot;

// ─── Auto-install dependencies ────────────────────────────────────────────────
const tsx = join(packageDir, "node_modules/.bin/tsx");
if (!existsSync(tsx)) {
    console.log("  Installing totopo dependencies...");
    let pm = "npm";
    try {
        execSync("which pnpm", { stdio: "ignore" });
        pm = "pnpm";
    } catch {}
    execSync(`${pm} install --silent`, { cwd: packageDir, stdio: "inherit" });
}

// ─── Helper ───────────────────────────────────────────────────────────────────
const run = (script, args = []) => spawnSync(tsx, [join(packageDir, `src/core/commands/${script}`), ...args], { stdio: "inherit" });

// ─── Onboarding ───────────────────────────────────────────────────────────────
if (!existsSync(join(repoRoot, ".totopo/Dockerfile"))) {
    run("onboard.ts");
    if (!existsSync(join(repoRoot, ".totopo/Dockerfile"))) process.exit(0);
}

// ─── Sync Dockerfile with host runtimes ───────────────────────────────────────
run("sync-dockerfile.ts");

// ─── Doctor (silent pre-check) ────────────────────────────────────────────────
const doctor = run("doctor.ts");
if (doctor.status !== 0) {
    console.error("  Fix the issues above and re-run totopo.");
    console.error("");
    process.exit(1);
}

// ─── Gather state for menu ────────────────────────────────────────────────────
const projectName = basename(repoRoot);

const dockerResult = spawnSync("docker", ["ps", "--filter", "name=totopo-managed-", "--format", "{{.Names}}"], {
    encoding: "utf8",
});
const activeCount = dockerResult.stdout ? dockerResult.stdout.trim().split("\n").filter(Boolean).length : 0;

let hasKey = false;
const envPath = join(repoRoot, ".totopo/.env");
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const value = trimmed.slice(trimmed.indexOf("=") + 1).trim();
        if (value) {
            hasKey = true;
            break;
        }
    }
}

// ─── Interactive menu (clack) ─────────────────────────────────────────────────
// stdout → /dev/tty so the clack UI renders on the terminal
// stderr → pipe so the selected action string is captured
const ttyFd = openSync("/dev/tty", "w");
const menuResult = spawnSync(tsx, [join(packageDir, "src/core/commands/menu.ts"), projectName, String(activeCount), String(hasKey)], {
    stdio: ["inherit", ttyFd, "pipe"],
    encoding: "utf8",
});
const action = (menuResult.stderr ?? "").trim();

// ─── Execute selection ────────────────────────────────────────────────────────
switch (action) {
    case "dev":
        run("dev.ts");
        break;
    case "stop":
        run("stop.ts");
        break;
    case "reset":
        run("reset.ts");
        break;
    case "doctor":
        run("doctor.ts", ["--verbose"]);
        break;
    case "settings":
        run("settings.ts");
        break;
    default:
        break; // quit or cancelled
}
