#!/usr/bin/env node
// =============================================================================
// post-start.mjs — Security validation & readiness check
// Runs automatically on every container start via postStartCommand.
// =============================================================================

import { execSync } from "node:child_process";
import { intro, log, outro } from "@clack/prompts";

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

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const grey = (s) => `\x1b[90m${s}\x1b[0m`;

let errors = 0;

const ok = (label, detail) => log.success(`${label.padEnd(24)}${detail ? dim(detail) : ""}`);
const skip = (label, detail) => log.info(`${grey(label.padEnd(24))}${detail ? grey(detail) : ""}`);
const warn = (label, detail) => log.warn(`${label.padEnd(24)}${detail ? dim(detail) : ""}`);
const fail = (label, detail) => {
    log.error(`${label.padEnd(24)}${detail || ""}`);
    errors++;
};

// ─── Header ──────────────────────────────────────────────────────────────────
intro("totopo — Secure AI Box");

// ─── Security ────────────────────────────────────────────────────────────────
log.step("Security");

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
log.step("AI tools");

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
log.step("Runtimes");

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
log.step("Dev tools");

ok("gh", run("gh --version")?.split("\n")[0] ?? "not found");
ok("rg", run("rg --version")?.split("\n")[0] ?? "not found");
ok("fd", run("fd --version") ?? "not found");
ok("fzf", run("fzf --version") ?? "not found");
ok("jq", run("jq --version") ?? "not found");
ok("yq", run("yq --version") ?? "not found");

// ─── API keys ────────────────────────────────────────────────────────────────
log.step("API keys");

const checkKey = (varName) => {
    const val = process.env[varName];
    if (val) {
        ok(varName, `${val.substring(0, 12)}...`);
    } else {
        warn(varName, "not set — add to .totopo/.env");
    }
};

checkKey("ANTHROPIC_API_KEY");
checkKey("KILO_API_KEY");

// ─── Summary ─────────────────────────────────────────────────────────────────
if (errors === 0) {
    outro("Ready.");
} else {
    outro(`${errors} error(s) — see above. Rebuild the container to fix.`);
    process.exit(1);
}
