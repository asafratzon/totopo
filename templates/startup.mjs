#!/usr/bin/env node
// =============================================================================
// startup.mjs -- Container startup: AI CLI updates + readiness checks
// Baked into the container image at /home/devuser/startup.mjs
// Must run as root (npm global install requires root).
// Must use only Node.js built-ins -- no external packages available in container.
// =============================================================================

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const run = (cmd) => {
    try {
        return execSync(cmd, {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    } catch {
        return null;
    }
};

// -- ANSI helpers -------------------------------------------------------------
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const _yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const blue = (s) => `\x1b[34m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const grey = (s) => `\x1b[90m${s}\x1b[0m`;

let errors = 0;

const ok = (label, detail) => console.log(`${green("✓")} ${label.padEnd(24)}${detail ? dim(detail) : ""}`);
const skip = (label, detail) => console.log(`${grey("–")} ${grey(label.padEnd(24))}${detail ? grey(detail) : ""}`);
const fail = (label, detail) => {
    console.log(`${red("✗")} ${label.padEnd(24)}${detail || ""}`);
    errors++;
};
const section = (title) => console.log(`\n${bold(title)}`);

// -- Header -------------------------------------------------------------------
console.log(`\n${bold("totopo - Sandbox for AI Agents")}\n`);

// -- AI CLI update (requires root - skipped when run via 'status' alias as devuser) -
section("AI CLI update");

const isRoot = process.getuid?.() === 0;
const TIMESTAMP_FILE = "/home/devuser/.ai-cli-updated";
const THROTTLE_MS = 24 * 60 * 60 * 1000;

let lastUpdate = 0;
try {
    const raw = readFileSync(TIMESTAMP_FILE, "utf8").trim();
    lastUpdate = new Date(raw).getTime();
} catch {
    // File missing or unreadable -- treat as never updated
}

if (Number.isFinite(lastUpdate) && Date.now() - lastUpdate < THROTTLE_MS) {
    ok("AI CLIs", "up to date");
} else if (!isRoot) {
    skip("AI CLIs", "update skipped (requires root)");
} else {
    console.log(`${blue("●")} ${dim("Updating AI CLIs to latest...")}`);
    try {
        execSync("npm install -g opencode-ai@latest @anthropic-ai/claude-code@latest @openai/codex@latest", {
            stdio: "inherit",
        });
        writeFileSync(TIMESTAMP_FILE, `${new Date().toISOString()}\n`);
        ok("AI CLIs", "updated");
    } catch {
        fail("AI CLIs", "update failed -- continuing with existing versions");
    }
}

// -- Security -----------------------------------------------------------------
section("Security");

const idOutput = run("id devuser");
if (idOutput?.includes("uid=1001")) {
    ok("non-root user", "devuser (uid=1001)");
} else {
    fail("non-root user", "devuser not found or wrong uid -- container is misconfigured");
}

const gitProtocol = run("git config --system protocol.allow");
if (gitProtocol === "never") {
    ok("git remote block", "protocol.allow = never");
} else {
    fail("git remote block", "not set -- rebuild the container");
}

try {
    execSync("/usr/bin/git -C /workspace push", { stdio: "pipe" });
    fail("push blocked", "git push succeeded -- remote access is NOT blocked");
} catch {
    ok("push blocked", "remote push not possible");
}

// -- AI tools -----------------------------------------------------------------
section("AI tools");

const checkTool = (cmd) => {
    const out = run(`${cmd} --version`);
    if (out !== null && out.trim() !== "") {
        const version = out.split("\n")[0];
        ok(cmd, version);
        return;
    }
    const which = run(`which ${cmd}`);
    if (which !== null) {
        ok(cmd, "installed");
    } else {
        fail(cmd, "not found -- rebuild container");
    }
};

checkTool("opencode");
checkTool("claude");
checkTool("codex");

// -- Runtimes -----------------------------------------------------------------
section("Runtimes");

const checkRuntime = (label, version) => {
    if (version !== null) ok(label, version);
    else skip(label, "not installed");
};

// Always present (base image)
ok("node", run("node --version") ?? "not found");
ok("npm", `v${run("npm --version") ?? "not found"}`);
const pnpmVer = run("pnpm --version");
ok("pnpm", pnpmVer ? `v${pnpmVer}` : "not found");
ok("python3", run("python3 --version") ?? "not found");
ok("pipx", run("pipx --version") ?? "not found");

// Optional (installed via profile hooks)
const bunVer = run("bun --version");
checkRuntime("bun", bunVer ? `v${bunVer}` : null);
checkRuntime("go", run("go version"));
checkRuntime("cargo", run("cargo --version"));
checkRuntime("java", run("java --version")?.split("\n")[0] ?? null);

// -- Dev tools ----------------------------------------------------------------
section("Dev tools");

ok("gh", run("gh --version")?.split("\n")[0] ?? "not found");
ok("rg", run("rg --version")?.split("\n")[0] ?? "not found");
ok("fd", run("fd --version") ?? "not found");
ok("fzf", run("fzf --version") ?? "not found");
ok("jq", run("jq --version") ?? "not found");
ok("yq", run("yq --version") ?? "not found");

// -- Database tools -----------------------------------------------------------
section("Database tools");

ok("sqlite3", run("sqlite3 --version")?.split(" ").slice(0, 2).join(" ") ?? "not found");
ok("psql", run("psql --version") ?? "not found");
ok("mysql", run("mysql --version") ?? "not found");
ok("redis-cli", run("redis-cli --version") ?? "not found");

// -- API keys -----------------------------------------------------------------
section("API keys");

console.log(`${blue("●")} ${dim("API keys are injected via env_file in totopo.yaml. Set env_file to point to your .env file.")}`);

// -- Summary ------------------------------------------------------------------
if (errors === 0) {
    const workspaceSuffix = process.env.TOTOPO_WORKSPACE ? ` - workspace: ${bold(process.env.TOTOPO_WORKSPACE)}` : "";
    console.log(`\n${blue("●")}  ${bold("totopo dev container ready")}${workspaceSuffix}`);
    console.log(
        `${grey("   To adjust settings, ask any agent about")} ${bold("totopo.yaml")} ${grey("- it lives in the workspace root.")}\n`,
    );
    console.log(`${green("●")} ${bold("Ready.")}`);
    console.log(`${grey("Type 'status' to re-run the readiness check.")}\n`);
} else {
    console.log(`\n${red("●")} ${bold(`${errors} error(s) - see above. Rebuild the container to fix.`)}\n`);
    process.exit(1);
}
