#!/usr/bin/env node
// =============================================================================
// startup.mjs -- Container startup: AI CLI updates + readiness checks
// Baked into the container image at /home/devuser/startup.mjs
// Must run as root (npm global install requires root).
// Must use only Node.js built-ins -- no external packages available in container.
// =============================================================================

import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { checkGitMode } from "./startup-git-mode.mjs";

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
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const blue = (s) => `\x1b[34m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const grey = (s) => `\x1b[90m${s}\x1b[0m`;

let errors = 0;

// Summary mode (passed by the host at session start): still run every check and side-effect, but stay
// quiet -- suppress the section dump and surface only failures. The 'status' alias runs without it,
// so it keeps the full verbose output as the on-demand "details" view.
const summary = process.argv.includes("--summary");

const ok = summary ? () => {} : (label, detail) => console.log(`${green("✓")} ${label.padEnd(24)}${detail ? dim(detail) : ""}`);
const skip = summary ? () => {} : (label, detail) => console.log(`${grey("–")} ${grey(label.padEnd(24))}${detail ? grey(detail) : ""}`);
const fail = (label, detail) => {
    console.log(`${red("✗")} ${label.padEnd(24)}${detail || ""}`);
    errors++;
};
// Non-fatal notice: always prints (even in summary), but does NOT increment errors, so it never aborts
// the session. Used for things the user should know about but that must not block connecting (e.g. a
// transient AI CLI update failure -- the existing versions still work).
const warn = (label, detail) => console.log(`${yellow("!")} ${label.padEnd(24)}${detail ? yellow(detail) : ""}`);
const section = summary ? () => {} : (title) => console.log(`\n${bold(title)}`);

// -- Header -------------------------------------------------------------------
if (!summary) console.log(`\n${bold("totopo - Sandbox for AI Agents")}\n`);

// -- AI CLI update (requires root - skipped when run via 'status' alias as devuser) -
section("AI CLI update");

const isRoot = process.getuid?.() === 0;
const TIMESTAMP_FILE = "/home/devuser/.ai-cli-updated";
const THROTTLE_MS = 24 * 60 * 60 * 1000;

let lastUpdate = 0;
let timestampFileExists = false;
try {
    const raw = readFileSync(TIMESTAMP_FILE, "utf8").trim();
    lastUpdate = new Date(raw).getTime();
    timestampFileExists = true;
} catch {
    // File missing or unreadable -- treat as never updated
}

// Print npm's output indented under the bullet above, so its flush-left "changed N packages" summary
// reads as part of totopo's output rather than looking like it leaked from unrelated logging.
const printIndented = (text) => {
    for (const line of text.split("\n")) {
        if (line.trim()) console.log(grey(`   ${line}`));
    }
};

// Run the global npm install behind a one-line braille spinner so the user can see the (otherwise
// silent, buffered) install is alive on a TTY. npm output is captured and printed indented only once it
// finishes, keeping the live view to a single animated line. A failed update is NON-FATAL: it reports
// via warn() (no errors++), so a transient registry/network hiccup never blocks the session -- the user
// keeps the existing CLI versions. On a non-TTY (tests, piped) the spinner is skipped for clean output.
const doUpdate = (label) =>
    new Promise((resolve) => {
        const animate = process.stdout.isTTY;
        const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        let frame = 0;
        let timer;
        if (animate) {
            const draw = () => {
                process.stdout.write(`\r${blue(frames[frame])} ${dim(label)}`);
                frame = (frame + 1) % frames.length;
            };
            draw();
            timer = setInterval(draw, 80);
        } else {
            console.log(`${blue("●")} ${dim(label)}`);
        }

        const child = spawn("npm", ["install", "-g", "opencode-ai@latest", "@anthropic-ai/claude-code@latest", "@openai/codex@latest"], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let errOut = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d) => {
            out += d;
        });
        child.stderr.on("data", (d) => {
            errOut += d;
        });

        // Settle exactly once (spawn can emit both 'error' and 'close'). Clear the spinner line and leave
        // a static bullet in its place so scrollback reads cleanly, then print the captured output.
        let done = false;
        const finish = (report) => {
            if (done) return;
            done = true;
            if (timer) clearInterval(timer);
            if (animate) process.stdout.write(`\r\x1b[K${blue("●")} ${dim(label)}\n`);
            report();
            resolve();
        };

        child.on("error", (err) => {
            finish(() => {
                printIndented(String(err?.message ?? err));
                warn("AI CLIs", "update failed -- continuing with existing versions");
            });
        });
        child.on("close", (code) => {
            finish(() => {
                if (code === 0) {
                    printIndented(out);
                    writeFileSync(TIMESTAMP_FILE, `${new Date().toISOString()}\n`);
                    ok("AI CLIs", "updated");
                } else {
                    printIndented(`${out}${errOut}`);
                    warn("AI CLIs", "update failed -- continuing with existing versions");
                }
            });
        });
    });

// SPACE within `seconds` -> skip. Any other input is ignored. Ctrl+C exits 130. Non-TTY -> no skip.
const promptSkipUpdate = (seconds) =>
    new Promise((resolve) => {
        if (!process.stdin.isTTY) {
            resolve(false);
            return;
        }
        let remaining = seconds;
        let tick;
        let timer;
        const line = (s) => `\r\x1b[K${blue("●")} ${dim(`Updating AI CLIs in ${s}s... press SPACE to skip`)}`;
        const cleanup = () => {
            clearInterval(tick);
            clearTimeout(timer);
            process.stdin.removeListener("data", onData);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.write("\r\x1b[K");
        };
        const onData = (chunk) => {
            for (const byte of chunk) {
                if (byte === 0x03) {
                    cleanup();
                    process.exit(130);
                }
                if (byte === 0x20) {
                    cleanup();
                    resolve(true);
                    return;
                }
            }
        };
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", onData);
        process.stdout.write(line(remaining));
        tick = setInterval(() => {
            remaining -= 1;
            if (remaining > 0) process.stdout.write(line(remaining));
        }, 1000);
        timer = setTimeout(() => {
            cleanup();
            resolve(false);
        }, seconds * 1000);
    });

if (Number.isFinite(lastUpdate) && Date.now() - lastUpdate < THROTTLE_MS) {
    ok("AI CLIs", "up to date");
} else if (!isRoot) {
    skip("AI CLIs", "update skipped (requires root)");
} else {
    // About to show update activity (the skip prompt and/or install/update output). In summary mode that is the
    // first thing after the host's "Starting dev container...", so add a blank line to separate it.
    if (summary) console.log("");
    if (!timestampFileExists) {
        await doUpdate("Installing AI CLIs...");
    } else if (await promptSkipUpdate(5)) {
        skip("AI CLIs", "update skipped by user");
    } else {
        await doUpdate("Updating AI CLIs to latest...");
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

// -- Git mode (strict / local / unrestricted) - applied + verified by separate module --
checkGitMode({ ok, fail, skip, run, isRoot });

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

// Direct console.log, so it must be gated explicitly to stay quiet in summary mode (kept for 'status').
if (!summary) {
    console.log(`${blue("●")} ${dim("API keys are injected via env_file in totopo.yaml. Set env_file to point to your .env file.")}`);
}

// -- Summary ------------------------------------------------------------------
if (errors === 0) {
    // Summary mode stays silent on success -- the welcome block is printed by the shell on connect.
    if (!summary) {
        const workspaceSuffix = process.env.TOTOPO_WORKSPACE ? ` - workspace: ${bold(process.env.TOTOPO_WORKSPACE)}` : "";
        console.log(`\n${blue("●")}  ${bold("totopo dev container ready")}${workspaceSuffix}`);
        console.log(
            `${grey("   To adjust settings, ask any agent about")} ${bold("totopo.yaml")} ${grey("- it lives in the workspace root.")}\n`,
        );
        console.log(`${green("●")} ${bold("Ready.")}`);
        console.log(`${grey("Type 'status' to re-run the readiness check.")}\n`);
    }
} else {
    console.log(`\n${red("●")} ${bold(`${errors} error(s) - see above. Rebuild the container to fix.`)}\n`);
    if (summary) console.log(`${grey("Run 'status' for full readiness details.")}\n`);
    process.exit(1);
}
