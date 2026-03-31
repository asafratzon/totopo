#!/usr/bin/env node
// =============================================================================
// post-start.mjs — Security validation & readiness check
// Baked into the container image at /home/devuser/post-start.mjs
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
const _yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

let errors = 0;

const grey = (s) => `\x1b[90m${s}\x1b[0m`;

const ok = (label, detail) => console.log(`${green("✓")} ${label.padEnd(24)}${detail ? dim(detail) : ""}`);
const skip = (label, detail) => console.log(`${grey("–")} ${grey(label.padEnd(24))}${detail ? grey(detail) : ""}`);
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
    else skip(label, "not installed");
};

// Always present (base image)
ok("node", run("node --version") ?? "not found");
ok("npm", `v${run("npm --version") ?? "not found"}`);
const pnpmVer = run("pnpm --version");
ok("pnpm", pnpmVer ? `v${pnpmVer}` : "not found");
ok("python3", run("python3 --version") ?? "not found");

// Optional (installed via profile hooks)
const bunVer = run("bun --version");
checkRuntime("bun", bunVer ? `v${bunVer}` : null);
checkRuntime("uv", run("uv --version"));
checkRuntime("go", run("go version"));
checkRuntime("cargo", run("cargo --version"));
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

console.log(`ℹ ${dim("API keys are injected via env_file in totopo.yaml. Set env_file to point to your .env file.")}`);

// ─── Summary ─────────────────────────────────────────────────────────────────
if (errors === 0) {
    console.log(`\n${green("●")} ${bold("Ready.")}`);
    console.log(`${grey("Type 'status' to re-run the readiness check.")}\n`);
} else {
    console.log(`\n${red("●")} ${bold(`${errors} error(s) — see above. Rebuild the container to fix.`)}\n`);
    process.exit(1);
}
