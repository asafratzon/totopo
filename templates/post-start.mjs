#!/usr/bin/env node
// =============================================================================
// post-start.mjs — Security validation & readiness check
// Runs automatically on every container start via postStartCommand.
// Must use only Node.js built-ins — no external packages available in container.
// =============================================================================

import { execSync } from "node:child_process";

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

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

let errors = 0;

const grey = (s) => `\x1b[90m${s}\x1b[0m`;

const ok = (label, detail) => console.log(`${green("✓")} ${label.padEnd(24)}${detail ? dim(detail) : ""}`);
const skip = (label, detail) => console.log(`${grey("–")} ${grey(label.padEnd(24))}${detail ? grey(detail) : ""}`);
const _warn = (label, detail) => console.log(`${yellow("▲")} ${label.padEnd(24)}${detail ? dim(detail) : ""}`);
const fail = (label, detail) => {
    console.log(`${red("✗")} ${label.padEnd(24)}${detail || ""}`);
    errors++;
};
const section = (title) => console.log(`\n${bold(title)}`);

// ─── Header ──────────────────────────────────────────────────────────────────
console.log(`\n${bold("totopo — Secure AI Box")}\n`);

// ─── Security ────────────────────────────────────────────────────────────────
section("Security");

const whoami = run("whoami");
if (whoami !== "root") {
    ok("non-root user", whoami ?? "unknown");
} else {
    fail("non-root user", "running as root — container is misconfigured");
}

const gitProtocol = run("git config --system protocol.allow");
if (gitProtocol === "never") {
    ok("git remote block", "protocol.allow = never");
} else {
    fail("git remote block", "not set — rebuild the container");
}

try {
    execSync("/usr/bin/git -C /workspace push", { stdio: "pipe" });
    fail("push blocked", "git push succeeded — remote access is NOT blocked");
} catch {
    ok("push blocked", "remote push not possible");
}

// ─── AI tools ────────────────────────────────────────────────────────────────
section("AI tools");

const aiToolResults = [];

const checkTool = (cmd) => {
    // Try --version first; some tools (e.g. opencode) may write version to
    // stderr or exit non-zero in a non-TTY context, so fall back to `which`
    // to confirm the binary exists before reporting failure.
    const out = run(`${cmd} --version`);
    if (out !== null && out.trim() !== "") {
        const version = out.split("\n")[0];
        ok(cmd, version);
        aiToolResults.push({ cmd, version, found: true });
        return;
    }
    const which = run(`which ${cmd}`);
    if (which !== null) {
        ok(cmd, "installed");
        aiToolResults.push({ cmd, version: "installed", found: true });
    } else {
        fail(cmd, "not found — rebuild container");
        aiToolResults.push({ cmd, version: null, found: false });
    }
};

checkTool("opencode");
checkTool("claude");
checkTool("codex");

// ─── Runtimes ────────────────────────────────────────────────────────────────
section("Runtimes");

const checkRuntime = (label, version) => {
    if (version !== null) ok(label, version);
    else skip(label, "skipped");
};

// JavaScript
ok("node", run("node --version") ?? "not found");
ok("npm", `v${run("npm --version") ?? "not found"}`);
ok("pnpm", run("pnpm --version") ? `v${run("pnpm --version")}` : "not found");
checkRuntime("bun", run("bun --version") ? `v${run("bun --version")}` : null);
// Python
ok("python3", run("python3 --version") ?? "not found");
checkRuntime("uv", run("uv --version"));
// Go
checkRuntime("go", run("go version"));
// Rust
checkRuntime("cargo", run("cargo --version"));
// Java
checkRuntime("java", run("java --version")?.split("\n")[0] ?? null);

// ─── Dev tools ───────────────────────────────────────────────────────────────
section("Dev tools");

ok("gh", run("gh --version")?.split("\n")[0] ?? "not found");
ok("rg", run("rg --version")?.split("\n")[0] ?? "not found");
ok("fd", run("fd --version") ?? "not found");
ok("fzf", run("fzf --version") ?? "not found");
ok("jq", run("jq --version") ?? "not found");
ok("yq", run("yq --version") ?? "not found");

// ─── API keys ────────────────────────────────────────────────────────────────
section("API keys");

console.log(`ℹ ${dim("Add API keys to ~/.totopo/.env on your host machine.")}`);

// ─── Summary ─────────────────────────────────────────────────────────────────
if (errors === 0) {
    section("AI tools");
    for (const { cmd, version, found } of aiToolResults) {
        if (found) ok(cmd, version);
        else fail(cmd, "not found — rebuild container");
    }

    console.log(`\n${green("●")} ${bold("Ready.")}`);
    console.log(`${grey("Type 'status' to re-run the readiness check.")}\n`);
} else {
    console.log(`\n${red("●")} ${bold(`${errors} error(s) — see above. Rebuild the container to fix.`)}\n`);
    process.exit(1);
}
