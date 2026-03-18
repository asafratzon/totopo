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
const warn = (label, detail) => console.log(`${yellow("▲")} ${label.padEnd(24)}${detail ? dim(detail) : ""}`);
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

const checkTool = (cmd) => {
    const out = run(`${cmd} --version`);
    if (out !== null) {
        ok(cmd, out.split("\n")[0]);
    } else {
        fail(cmd, "not found — rebuild container");
    }
};

checkTool("claude");
checkTool("kilo");
checkTool("opencode");

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

console.log(`ℹ ${dim("Optionally add API keys to .totopo/.env before starting the container.")}`);

// ─── Summary ─────────────────────────────────────────────────────────────────
if (errors === 0) {
    console.log(`\n${green("●")} ${bold("Ready.")}\n`);
} else {
    console.log(`\n${red("●")} ${bold(`${errors} error(s) — see above. Rebuild the container to fix.`)}\n`);
    process.exit(1);
}
