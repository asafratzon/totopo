import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { PACKAGE_ROOT } from "../src/lib/constants.js";
import { cleanTempDir, createTempDir } from "./helpers.js";

const STATUSLINE_SCRIPT = join(PACKAGE_ROOT, "templates", "claude-statusline.sh");
const HELPER_SCRIPT = join(PACKAGE_ROOT, "templates", "context-usage.sh");
const SESSION_ID = "78b4025b-4706-4754-9fb1-46b4856f34e5";

// These tests execute the shipped POSIX sh scripts directly, so they need sh, jq, and awk on
// the host. Skip (rather than fail) when the toolchain is unavailable.
const hasTools =
    spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0 &&
    spawnSync("jq", ["--version"], { stdio: "ignore" }).status === 0 &&
    spawnSync("awk", ["BEGIN { exit 0 }"], { stdio: "ignore" }).status === 0;

function runScript(script: string, home: string, input = "", extraEnv: Record<string, string> = {}): SpawnSyncReturns<string> {
    return spawnSync("sh", [script], { input, encoding: "utf8", env: { ...process.env, HOME: home, ...extraEnv } });
}

function statuslineInput(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        session_id: SESSION_ID,
        model: { display_name: "Fable 5" },
        effort: { level: "high" },
        context_window: { used_percentage: 12, total_input_tokens: 45000 },
        rate_limits: { five_hour: { used_percentage: 16, resets_at: Math.floor(Date.now() / 1000) + 1260 } },
        ...overrides,
    });
}

function snapshotDir(home: string): string {
    return join(home, ".claude", "context-usage");
}

function writeSnapshot(home: string, sessionId: string, fields: Record<string, unknown>, mtimeMs: number): string {
    const dir = snapshotDir(home);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sessionId}.json`);
    writeFileSync(path, `${JSON.stringify({ session_id: sessionId, ...fields })}\n`);
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
    return path;
}

// ---- claude-statusline.sh snapshot side effect ------------------------------------------------------------------------------------------

describe("claude-statusline.sh - context snapshot", { skip: !hasTools }, () => {
    test("writes a per-session snapshot and keeps the single-line output contract", async () => {
        const tmp = createTempDir();
        const result = runScript(STATUSLINE_SCRIPT, tmp, statuslineInput());
        assert.equal(result.status, 0);
        assert.equal(result.stdout.trimEnd().split("\n").length, 1, "status line must stay a single line");

        const snapshot = JSON.parse(readFileSync(join(snapshotDir(tmp), `${SESSION_ID}.json`), "utf8"));
        assert.equal(snapshot.session_id, SESSION_ID);
        assert.equal(snapshot.context_tokens, 45000);
        assert.equal(snapshot.context_used_pct, 12);
        assert.equal(snapshot.model, "Fable 5");
        assert.equal(snapshot.effort, "high");
        assert.equal(snapshot.quota_left_pct, 84);
        assert.ok(typeof snapshot.quota_resets_at === "number");
        assert.ok(typeof snapshot.updated_at === "number");
        // Value depends on whether the test itself runs under a Claude session, so only
        // assert the field exists (number when the ancestry walk resolved, null otherwise).
        assert.ok("claude_pid" in snapshot);
        await cleanTempDir(tmp);
    });

    test("records the claude pid from the TOTOPO_CLAUDE_PID override", async () => {
        const tmp = createTempDir();
        const result = runScript(STATUSLINE_SCRIPT, tmp, statuslineInput(), { TOTOPO_CLAUDE_PID: "4242" });
        assert.equal(result.status, 0);
        const snapshot = JSON.parse(readFileSync(join(snapshotDir(tmp), `${SESSION_ID}.json`), "utf8"));
        assert.equal(snapshot.claude_pid, 4242);
        await cleanTempDir(tmp);
    });

    test("records a null claude pid when the override is non-numeric", async () => {
        const tmp = createTempDir();
        // A non-numeric pid must be dropped (never fed to jq tonumber) without breaking the render.
        const result = runScript(STATUSLINE_SCRIPT, tmp, statuslineInput(), { TOTOPO_CLAUDE_PID: "not-a-pid" });
        assert.equal(result.status, 0);
        assert.equal(result.stdout.trimEnd().split("\n").length, 1);
        const snapshot = JSON.parse(readFileSync(join(snapshotDir(tmp), `${SESSION_ID}.json`), "utf8"));
        assert.equal(snapshot.claude_pid, null);
        await cleanTempDir(tmp);
    });

    test("clamps quota-left to 0 when usage overshoots 100%", async () => {
        const tmp = createTempDir();
        const result = runScript(
            STATUSLINE_SCRIPT,
            tmp,
            statuslineInput({ rate_limits: { five_hour: { used_percentage: 103, resets_at: Math.floor(Date.now() / 1000) + 600 } } }),
        );
        assert.equal(result.status, 0);
        assert.doesNotMatch(result.stdout, /-\d+%/, "over-limit usage must never render a negative percentage");
        const snapshot = JSON.parse(readFileSync(join(snapshotDir(tmp), `${SESSION_ID}.json`), "utf8"));
        assert.equal(snapshot.quota_left_pct, 0);
        await cleanTempDir(tmp);
    });

    test("records the claude pid start time from the TOTOPO_CLAUDE_PID_START override", async () => {
        const tmp = createTempDir();
        const result = runScript(STATUSLINE_SCRIPT, tmp, statuslineInput(), { TOTOPO_CLAUDE_PID: "4242", TOTOPO_CLAUDE_PID_START: "777" });
        assert.equal(result.status, 0);
        const snapshot = JSON.parse(readFileSync(join(snapshotDir(tmp), `${SESSION_ID}.json`), "utf8"));
        assert.equal(snapshot.claude_pid, 4242);
        assert.equal(snapshot.claude_pid_start, 777);
        await cleanTempDir(tmp);
    });

    test("strips the model parenthetical and shows the window size in the context segment", async () => {
        const tmp = createTempDir();
        const result = runScript(
            STATUSLINE_SCRIPT,
            tmp,
            statuslineInput({
                model: { display_name: "Opus 4.8 (1M context)" },
                context_window: { used_percentage: 11, total_input_tokens: 108000, context_window_size: 1000000 },
            }),
        );
        assert.equal(result.status, 0);
        // Model name renders without the "(1M context)" parenthetical, in the line and the snapshot.
        assert.match(result.stdout, /Opus 4\.8/);
        assert.doesNotMatch(result.stdout, /1M context/);
        assert.match(result.stdout, /108k.*\/ 1M \(11%\)/, "context segment shows used tokens / window size (pct)");
        const snapshot = JSON.parse(readFileSync(join(snapshotDir(tmp), `${SESSION_ID}.json`), "utf8"));
        assert.equal(snapshot.model, "Opus 4.8");
        await cleanTempDir(tmp);
    });

    test("formats a 200k window and drops the size half when the field is absent", async () => {
        const tmp = createTempDir();
        const with200k = runScript(
            STATUSLINE_SCRIPT,
            tmp,
            statuslineInput({ context_window: { used_percentage: 22, total_input_tokens: 45000, context_window_size: 200000 } }),
        );
        assert.equal(with200k.status, 0);
        assert.match(with200k.stdout, /45\.0k.*\/ 200k \(22%\)/);

        // statuslineInput carries no context_window_size, so the "/ size" half is omitted.
        const noSize = runScript(STATUSLINE_SCRIPT, tmp, statuslineInput());
        assert.equal(noSize.status, 0);
        assert.doesNotMatch(noSize.stdout, /\/ \d/, "no size half when context_window_size is unknown");
        await cleanTempDir(tmp);
    });

    test("skips the write when session_id is absent", async () => {
        const tmp = createTempDir();
        const input = statuslineInput();
        const withoutSession = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(input)).filter(([k]) => k !== "session_id")));
        const result = runScript(STATUSLINE_SCRIPT, tmp, withoutSession);
        assert.equal(result.status, 0);
        assert.equal(result.stdout.trimEnd().split("\n").length, 1);
        assert.ok(!existsSync(snapshotDir(tmp)), "snapshot dir should not be created");
        await cleanTempDir(tmp);
    });

    test("skips the write for unsafe session ids", async () => {
        const tmp = createTempDir();
        for (const unsafe of ["../evil", "a/b", "a.b", "a b"]) {
            const result = runScript(STATUSLINE_SCRIPT, tmp, statuslineInput({ session_id: unsafe }));
            assert.equal(result.status, 0);
            assert.equal(result.stdout.trimEnd().split("\n").length, 1);
        }
        assert.ok(!existsSync(snapshotDir(tmp)), "snapshot dir should not be created for unsafe ids");
        await cleanTempDir(tmp);
    });

    test("malformed stdin still emits a line and writes nothing", async () => {
        const tmp = createTempDir();
        const result = runScript(STATUSLINE_SCRIPT, tmp, "not json at all");
        assert.equal(result.status, 0);
        assert.equal(result.stdout.trimEnd().split("\n").length, 1);
        assert.ok(!existsSync(snapshotDir(tmp)));
        await cleanTempDir(tmp);
    });
});

// ---- context-usage.sh helper ------------------------------------------------------------------------------------------------------------

describe("context-usage.sh", { skip: !hasTools }, () => {
    test("prints a labeled summary from the newest snapshot", async () => {
        const tmp = createTempDir();
        const now = Math.floor(Date.now() / 1000);
        writeSnapshot(
            tmp,
            SESSION_ID,
            {
                updated_at: now - 3,
                context_tokens: 45000,
                context_used_pct: 12,
                model: "Fable 5",
                effort: "high",
                quota_left_pct: 84,
                quota_resets_at: now + 1260,
            },
            Date.now(),
        );
        const result = runScript(HELPER_SCRIPT, tmp);
        assert.equal(result.status, 0);
        assert.match(result.stdout, new RegExp(`session: ${SESSION_ID}`));
        assert.match(result.stdout, /context: 45\.0k tokens \(12% of window\)/);
        assert.match(result.stdout, /quota: {3}84% remaining, resets in 2\dm/);
        assert.match(result.stdout, /model: {3}Fable 5 \(effort high\)/);
        assert.doesNotMatch(result.stdout, /warning/);
        await cleanTempDir(tmp);
    });

    test("omits the quota line when the snapshot has no rate-limit data", async () => {
        const tmp = createTempDir();
        const now = Math.floor(Date.now() / 1000);
        writeSnapshot(tmp, SESSION_ID, { updated_at: now, context_tokens: 1000, context_used_pct: 0, model: "Fable 5" }, Date.now());
        const result = runScript(HELPER_SCRIPT, tmp);
        assert.equal(result.status, 0);
        assert.doesNotMatch(result.stdout, /quota:/);
        await cleanTempDir(tmp);
    });

    test("warns when the snapshot is stale", async () => {
        const tmp = createTempDir();
        const now = Math.floor(Date.now() / 1000);
        writeSnapshot(tmp, SESSION_ID, { updated_at: now - 600, context_tokens: 1000, context_used_pct: 1 }, Date.now() - 600_000);
        const result = runScript(HELPER_SCRIPT, tmp);
        assert.equal(result.status, 0);
        assert.match(result.stdout, /warning: snapshot is 10m old/);
        await cleanTempDir(tmp);
    });

    test("warns when another session updated its snapshot around the same time", async () => {
        const tmp = createTempDir();
        const now = Math.floor(Date.now() / 1000);
        writeSnapshot(tmp, "other-session", { updated_at: now - 30, context_tokens: 500, context_used_pct: 1 }, Date.now() - 30_000);
        writeSnapshot(tmp, SESSION_ID, { updated_at: now, context_tokens: 1000, context_used_pct: 1 }, Date.now());
        const result = runScript(HELPER_SCRIPT, tmp);
        assert.equal(result.status, 0);
        assert.match(result.stdout, new RegExp(`session: ${SESSION_ID}`), "newest snapshot should win");
        assert.match(result.stdout, /warning: another session updated its snapshot/);
        await cleanTempDir(tmp);
    });

    test("does not warn when the other session's snapshot is old", async () => {
        const tmp = createTempDir();
        const now = Math.floor(Date.now() / 1000);
        writeSnapshot(tmp, "other-session", { updated_at: now - 3600, context_tokens: 500, context_used_pct: 1 }, Date.now() - 3_600_000);
        writeSnapshot(tmp, SESSION_ID, { updated_at: now, context_tokens: 1000, context_used_pct: 1 }, Date.now());
        const result = runScript(HELPER_SCRIPT, tmp);
        assert.equal(result.status, 0);
        assert.doesNotMatch(result.stdout, /warning/);
        await cleanTempDir(tmp);
    });

    test("prefers the snapshot matching this session's claude pid over a newer one", async () => {
        const tmp = createTempDir();
        const now = Math.floor(Date.now() / 1000);
        writeSnapshot(
            tmp,
            SESSION_ID,
            { updated_at: now - 90, context_tokens: 1000, context_used_pct: 1, claude_pid: 11111 },
            Date.now() - 90_000,
        );
        writeSnapshot(tmp, "other-session", { updated_at: now, context_tokens: 500, context_used_pct: 1, claude_pid: 22222 }, Date.now());
        const result = runScript(HELPER_SCRIPT, tmp, "", { TOTOPO_CLAUDE_PID: "11111" });
        assert.equal(result.status, 0);
        assert.match(result.stdout, new RegExp(`session: ${SESSION_ID} \\(this session`), "pid match should beat mtime");
        assert.doesNotMatch(result.stdout, /warning/, "a pid-matched snapshot needs no caveats");
        await cleanTempDir(tmp);
    });

    test("matches by pid and start time when both sides carry one", async () => {
        const tmp = createTempDir();
        const now = Math.floor(Date.now() / 1000);
        writeSnapshot(
            tmp,
            SESSION_ID,
            { updated_at: now, context_tokens: 1000, context_used_pct: 1, claude_pid: 11111, claude_pid_start: 999 },
            Date.now(),
        );
        const result = runScript(HELPER_SCRIPT, tmp, "", { TOTOPO_CLAUDE_PID: "11111", TOTOPO_CLAUDE_PID_START: "999" });
        assert.equal(result.status, 0);
        assert.match(result.stdout, new RegExp(`session: ${SESSION_ID} \\(this session`));
        await cleanTempDir(tmp);
    });

    test("rejects a pid match when the recorded start time differs (recycled pid)", async () => {
        const tmp = createTempDir();
        const now = Math.floor(Date.now() / 1000);
        // Same pid recorded by a previous container boot: the start time disagrees, so the
        // deterministic match must not fire and the marker must be absent.
        writeSnapshot(
            tmp,
            SESSION_ID,
            { updated_at: now, context_tokens: 1000, context_used_pct: 1, claude_pid: 11111, claude_pid_start: 999 },
            Date.now(),
        );
        const result = runScript(HELPER_SCRIPT, tmp, "", { TOTOPO_CLAUDE_PID: "11111", TOTOPO_CLAUDE_PID_START: "888" });
        assert.equal(result.status, 0);
        assert.doesNotMatch(result.stdout, /this session/);
        await cleanTempDir(tmp);
    });

    test("falls back to newest with warnings when no snapshot matches the pid", async () => {
        const tmp = createTempDir();
        const now = Math.floor(Date.now() / 1000);
        writeSnapshot(
            tmp,
            "other-session",
            { updated_at: now - 30, context_tokens: 500, context_used_pct: 1, claude_pid: 11111 },
            Date.now() - 30_000,
        );
        writeSnapshot(tmp, SESSION_ID, { updated_at: now, context_tokens: 1000, context_used_pct: 1, claude_pid: 22222 }, Date.now());
        const result = runScript(HELPER_SCRIPT, tmp, "", { TOTOPO_CLAUDE_PID: "99999" });
        assert.equal(result.status, 0);
        assert.match(result.stdout, new RegExp(`session: ${SESSION_ID} \\(updated`), "newest snapshot should win on fallback");
        assert.doesNotMatch(result.stdout, /this session/);
        assert.match(result.stdout, /warning: another session updated its snapshot/);
        await cleanTempDir(tmp);
    });

    test("exits 1 with a friendly message when no snapshots exist", async () => {
        const tmp = createTempDir();
        const result = runScript(HELPER_SCRIPT, tmp);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /No context snapshots found/);
        assert.match(result.stderr, /status line renders at least once/);
        await cleanTempDir(tmp);
    });

    test("exits 1 when the newest snapshot is unreadable", async () => {
        const tmp = createTempDir();
        mkdirSync(snapshotDir(tmp), { recursive: true });
        writeFileSync(join(snapshotDir(tmp), `${SESSION_ID}.json`), "{ not valid json");
        const result = runScript(HELPER_SCRIPT, tmp);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /unreadable/);
        await cleanTempDir(tmp);
    });

    test("end to end: statusline writes, helper matches it by pid", async () => {
        const tmp = createTempDir();
        const render = runScript(STATUSLINE_SCRIPT, tmp, statuslineInput(), { TOTOPO_CLAUDE_PID: "4242" });
        assert.equal(render.status, 0);
        const result = runScript(HELPER_SCRIPT, tmp, "", { TOTOPO_CLAUDE_PID: "4242" });
        assert.equal(result.status, 0);
        assert.match(result.stdout, new RegExp(`session: ${SESSION_ID} \\(this session`));
        assert.match(result.stdout, /context: 45\.0k tokens \(12% of window\)/);
        assert.match(result.stdout, /quota: {3}84% remaining/);
        assert.doesNotMatch(result.stdout, /warning/);
        await cleanTempDir(tmp);
    });
});
