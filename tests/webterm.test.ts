import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { AGENT_RESUME_COMMAND, AUTO_START, AUTO_START_AGENTS, RESUME_MARKER_PATH, WEB_CONTAINER_PORT } from "../src/lib/constants.js";
import {
    assignWebPortsToAllWorkspaces,
    collectAssignedWebPorts,
    ensureWebPort,
    latestClaudeSessionId,
    nextFreeWebPort,
    reassignOutOfRangeWebPorts,
    resolveWebPort,
    resumeCommandFor,
    webPortUsable,
    webSessionInfo,
} from "../src/lib/webterm.js";
import { initWorkspaceDir, readWebPort, writeWebPort } from "../src/lib/workspace-identity.js";
import { cleanTempDir, createTempDir, overrideEnv } from "./helpers.js";

const TEMPLATES_DIR = join(import.meta.dirname, "..", "templates");
const RANGE = { start: 3900, end: 3903 };

// Bind an ephemeral loopback port and return the socket plus its number, so the port is genuinely occupied.
function occupyEphemeralPort(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
    });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

// ---- nextFreeWebPort (pure) -------------------------------------------------------------------------------------------------------------

describe("nextFreeWebPort", () => {
    test("returns the range start when nothing is taken", () => {
        assert.equal(nextFreeWebPort(RANGE, new Set()), 3900);
    });

    test("skips taken ports and returns the lowest free one", () => {
        assert.equal(nextFreeWebPort(RANGE, new Set([3900, 3901])), 3902);
        assert.equal(nextFreeWebPort(RANGE, new Set([3900, 3902])), 3901);
    });

    test("returns null when the range is exhausted", () => {
        assert.equal(nextFreeWebPort(RANGE, new Set([3900, 3901, 3902, 3903])), null);
    });
});

// ---- Assignment over the per-workspace locks --------------------------------------------------------------------------------------------

describe("web port assignment (isolated home)", () => {
    let homeRoot: string;
    let restoreHome: () => void;
    const workspaceRoots: string[] = [];

    // Register a workspace with a real .lock so the assignment walk can see it.
    function addWorkspace(id: string): void {
        const root = createTempDir();
        workspaceRoots.push(root);
        initWorkspaceDir(id, root);
    }

    beforeEach(() => {
        homeRoot = createTempDir();
        const fakeHome = join(homeRoot, "home");
        mkdirSync(fakeHome, { recursive: true });
        restoreHome = overrideEnv("HOME", fakeHome);
    });

    afterEach(async () => {
        restoreHome();
        await cleanTempDir(homeRoot);
        for (const root of workspaceRoots.splice(0)) {
            await cleanTempDir(root);
        }
    });

    test("collectAssignedWebPorts scans every lock and honors the exclusion", () => {
        addWorkspace("ws-a");
        addWorkspace("ws-b");
        writeWebPort("ws-a", 3900);
        writeWebPort("ws-b", 3901);

        assert.deepEqual([...collectAssignedWebPorts()].sort(), [3900, 3901]);
        assert.deepEqual([...collectAssignedWebPorts("ws-a")], [3901]);
    });

    test("ensureWebPort assigns the lowest free port once and stays sticky", () => {
        addWorkspace("ws-a");
        addWorkspace("ws-b");

        assert.deepEqual(ensureWebPort("ws-a", RANGE), { ok: true, port: 3900 });
        assert.deepEqual(ensureWebPort("ws-b", RANGE), { ok: true, port: 3901 });
        // Re-ensuring never moves an assignment.
        assert.deepEqual(ensureWebPort("ws-a", RANGE), { ok: true, port: 3900 });
        assert.equal(readWebPort("ws-a"), 3900);
    });

    test("ensureWebPort keeps an out-of-range sticky port as-is", () => {
        addWorkspace("ws-a");
        writeWebPort("ws-a", 5000);
        assert.deepEqual(ensureWebPort("ws-a", RANGE), { ok: true, port: 5000 });
    });

    test("ensureWebPort reports an exhausted range", () => {
        for (let i = 0; i <= 4; i++) {
            addWorkspace(`ws-${i}`);
        }
        for (let i = 0; i <= 3; i++) {
            assert.deepEqual(ensureWebPort(`ws-${i}`, RANGE), { ok: true, port: 3900 + i });
        }
        assert.deepEqual(ensureWebPort("ws-4", RANGE), { ok: false, reason: "exhausted" });
        assert.equal(readWebPort("ws-4"), null);
    });

    test("assignWebPortsToAllWorkspaces covers every workspace (the enable-time walk)", () => {
        addWorkspace("ws-a");
        addWorkspace("ws-b");
        addWorkspace("ws-c");

        const assigned = assignWebPortsToAllWorkspaces(RANGE);

        assert.equal(assigned.length, 3);
        const ports = assigned.map((a) => a.port).sort();
        assert.deepEqual(ports, [3900, 3901, 3902]);
        for (const a of assigned) {
            assert.equal(readWebPort(a.workspaceId), a.port);
        }
    });

    // resolveWebPort is what the session path uses: it adds "can this port actually carry the interface"
    // on top of the .lock bookkeeping, and moves the assignment when the answer is no.
    describe("resolveWebPort", () => {
        const always = async () => true;
        // Everything usable except the listed ports.
        const except = (...blocked: number[]) => {
            return async (port: number) => !blocked.includes(port);
        };

        test("keeps a usable sticky port and leaves the lock alone", async () => {
            addWorkspace("ws-a");
            writeWebPort("ws-a", 3902);

            assert.deepEqual(await resolveWebPort("ws-a", RANGE, always), { ok: true, port: 3902 });
            assert.equal(readWebPort("ws-a"), 3902);
        });

        test("moves the assignment when the sticky port cannot be used, and persists the move", async () => {
            addWorkspace("ws-a");
            writeWebPort("ws-a", 3900);

            assert.deepEqual(await resolveWebPort("ws-a", RANGE, except(3900)), { ok: true, port: 3901, movedFrom: 3900 });
            // Sticky means it stays where it was last put: the next session starts from the new port.
            assert.equal(readWebPort("ws-a"), 3901);
            assert.deepEqual(await resolveWebPort("ws-a", RANGE, always), { ok: true, port: 3901 });
        });

        test("skips ports another workspace already holds when moving", async () => {
            addWorkspace("ws-a");
            addWorkspace("ws-b");
            writeWebPort("ws-a", 3900);
            writeWebPort("ws-b", 3901);

            assert.deepEqual(await resolveWebPort("ws-a", RANGE, except(3900)), { ok: true, port: 3902, movedFrom: 3900 });
        });

        test("keeps the old assignment when nothing in the range is usable", async () => {
            addWorkspace("ws-a");
            writeWebPort("ws-a", 3900);

            assert.deepEqual(await resolveWebPort("ws-a", RANGE, except(3900, 3901, 3902, 3903)), {
                ok: false,
                reason: "exhausted",
                keptPort: 3900,
            });
            // The workspace keeps its identity and picks the port back up once the conflict clears.
            assert.equal(readWebPort("ws-a"), 3900);
            assert.deepEqual(await resolveWebPort("ws-a", RANGE, always), { ok: true, port: 3900 });
        });

        test("reports an unrecordable first assignment separately from an exhausted range", async () => {
            // No .lock for this id, so nothing can be written.
            assert.deepEqual(await resolveWebPort("ws-ghost", RANGE, always), {
                ok: false,
                reason: "unrecorded",
                keptPort: null,
            });
        });
    });

    test("ensureWebPort hands out nothing it could not record, and says so", () => {
        addWorkspace("ws-real");
        // No .lock for this id, so the write cannot land. Handing the port out anyway would make it
        // invisible to the next scan and assign it twice. The reason has to be distinguishable from an
        // exhausted range: only that one is fixed by widening the range.
        assert.equal(writeWebPort("ws-ghost", 3900), false);
        assert.deepEqual(ensureWebPort("ws-ghost", RANGE), { ok: false, reason: "unrecorded" });
        // The port is still free for the workspace that can actually record it.
        assert.deepEqual(ensureWebPort("ws-real", RANGE), { ok: true, port: 3900 });
        assert.equal(readWebPort("ws-real"), 3900);
    });

    test("reassignOutOfRangeWebPorts moves only out-of-range ports, to the lowest free", () => {
        addWorkspace("ws-in");
        addWorkspace("ws-out");
        writeWebPort("ws-in", 3901);
        writeWebPort("ws-out", 5000);

        const moves = reassignOutOfRangeWebPorts(RANGE);

        assert.deepEqual(moves, [{ workspaceId: "ws-out", from: 5000, to: 3900 }]);
        assert.equal(readWebPort("ws-in"), 3901, "in-range port must stay sticky");
        assert.equal(readWebPort("ws-out"), 3900);
    });
});

// ---- Host-side probes (real sockets) ----------------------------------------------------------------------------------------------------

describe("webPortUsable", () => {
    test("true for a free host port", async () => {
        const { server, port } = await occupyEphemeralPort();
        await closeServer(server); // Free it again, keeping a port number nothing else is on.
        assert.equal(await webPortUsable(port, "totopo-test-nonexistent"), true);
    });

    test("false while something else holds the port", async () => {
        const { server, port } = await occupyEphemeralPort();
        try {
            assert.equal(await webPortUsable(port, "totopo-test-nonexistent"), false);
        } finally {
            await closeServer(server);
        }
    });
});

describe("webSessionInfo", () => {
    // Stand in for the container's webterm server: /status answers with whatever body the test wants.
    function serveStatus(body: string, status = 200): Promise<{ close: () => Promise<void>; port: number }> {
        return new Promise((resolve) => {
            const server = createHttpServer((req, res) => {
                if (req.url !== "/status") {
                    res.writeHead(404).end();
                    return;
                }
                res.writeHead(status, { "content-type": "application/json" }).end(body);
            });
            server.listen(0, "127.0.0.1", () => {
                resolve({
                    port: (server.address() as AddressInfo).port,
                    close: () => new Promise((done) => server.close(() => done())),
                });
            });
        });
    }

    test("reports live sessions and how many a browser is watching", async () => {
        const { close, port } = await serveStatus('{"agent":"claude","sessions":3,"attached":1}');
        try {
            assert.deepEqual(await webSessionInfo(port), { sessions: 3, attached: 1 });
        } finally {
            await close();
        }
    });

    test("reports 0 sessions for an interface that is listening with nothing running", async () => {
        const { close, port } = await serveStatus('{"agent":"claude","sessions":0,"attached":0}');
        try {
            assert.deepEqual(await webSessionInfo(port), { sessions: 0, attached: 0 });
        } finally {
            await close();
        }
    });

    test("null when nothing is listening, so a dead interface never changes the stop prompt", async () => {
        const { server, port } = await occupyEphemeralPort();
        await closeServer(server);
        assert.equal(await webSessionInfo(port), null);
    });

    test("null for an error status or an unexpected body", async () => {
        const failing = await serveStatus("nope", 500);
        try {
            assert.equal(await webSessionInfo(failing.port), null);
        } finally {
            await failing.close();
        }
        const garbage = await serveStatus('{"sessions":"many","attached":0}');
        try {
            assert.equal(await webSessionInfo(garbage.port), null);
        } finally {
            await garbage.close();
        }
        // A body missing half the answer is not usable either - the count drives what the prompt says.
        const partial = await serveStatus('{"agent":"claude","sessions":2}');
        try {
            assert.equal(await webSessionInfo(partial.port), null);
        } finally {
            await partial.close();
        }
    });
});

// ---- Cross-file literal sync ------------------------------------------------------------------------------------------------------------
// The launcher (bash) and the webterm app (plain JS) cannot import the TS constants, so their literals
// are pinned here: a drift between them and constants.ts fails these tests instead of failing at runtime.

describe("baked webterm literals stay in sync with constants", () => {
    test("webterm.sh uses the fixed container port and the resume marker filename", () => {
        const launcher = readFileSync(join(TEMPLATES_DIR, "webterm.sh"), "utf8");
        assert.ok(launcher.includes(String(WEB_CONTAINER_PORT)), `launcher must bind port ${WEB_CONTAINER_PORT}`);
        // The launcher builds the path from $HOME (it always runs as devuser), so pin the filename.
        assert.ok(launcher.includes(basename(RESUME_MARKER_PATH)), "launcher must export the resume marker path");
    });

    test("webterm/config.js defaults to the fixed container port", () => {
        const config = readFileSync(join(TEMPLATES_DIR, "webterm", "config.js"), "utf8");
        const match = /WEBTERM_PORT\)\s*\|\|\s*(\d+)/.exec(config);
        assert.ok(match, "config.js must default PORT from WEBTERM_PORT");
        assert.equal(Number(match?.[1]), WEB_CONTAINER_PORT);
    });

    test("webterm.sh accepts exactly the agents totopo can auto-start", () => {
        const launcher = readFileSync(join(TEMPLATES_DIR, "webterm.sh"), "utf8");
        const match = /AGENTS=\(([^)]*)\)/.exec(launcher);
        assert.ok(match, "launcher must declare its accepted agents in an AGENTS=(...) array");
        const launcherAgents = (match?.[1] ?? "").trim().split(/\s+/);
        const expected = AUTO_START_AGENTS.filter((agent) => agent !== AUTO_START.off);
        assert.deepEqual(launcherAgents.slice().sort(), expected.slice().sort(), "launcher agent list drifted from AUTO_START_AGENTS");
    });

    test("launcher and server agree on the state file that names the live agent", () => {
        const launcher = readFileSync(join(TEMPLATES_DIR, "webterm.sh"), "utf8");
        const config = readFileSync(join(TEMPLATES_DIR, "webterm", "config.js"), "utf8");
        const launcherPath = /^STATE_FILE=(\S+)$/m.exec(launcher);
        const configPath = /WEBTERM_STATE_FILE\s*\|\|\s*"([^"]+)"/.exec(config);
        assert.ok(launcherPath, "launcher must define STATE_FILE");
        assert.ok(configPath, "config.js must default the state file path");
        // The launcher reads the file the server writes, so a drift between the two literals would make
        // a second `webterm <agent>` stop naming the live agent.
        assert.equal(launcherPath?.[1], configPath?.[1]);
        assert.ok(launcher.includes("export WEBTERM_STATE_FILE="), "launcher must pass the state file to the server");
    });

    test("launcher starts the server detached, not in the foreground", () => {
        const launcher = readFileSync(join(TEMPLATES_DIR, "webterm.sh"), "utf8");
        // A foreground `exec node ...` would block the invoking shell and die with it; the interface is a
        // background service, started the same way whether the host or the user launches it.
        assert.ok(/setsid node .*server\.js.* &$/m.test(launcher), "launcher must start server.js detached in the background");
        assert.ok(!/^exec node /m.test(launcher), "launcher must not exec the server in the foreground");
    });

    test("the agent reaches the server through one env name, and is never guessed", () => {
        const launcher = readFileSync(join(TEMPLATES_DIR, "webterm.sh"), "utf8");
        const config = readFileSync(join(TEMPLATES_DIR, "webterm", "config.js"), "utf8");
        assert.ok(launcher.includes("export WEBTERM_AGENT="), "launcher must export WEBTERM_AGENT");
        assert.ok(config.includes("process.env.WEBTERM_AGENT"), "config.js must read WEBTERM_AGENT");
        // The agent is always named explicitly (host: `webterm <agent>`, user: same), so the launcher
        // must not fall back to the auto-start setting or to a hardcoded agent.
        assert.ok(!launcher.includes("TOTOPO_AUTOSTART"), "launcher must not infer the agent from TOTOPO_AUTOSTART");
    });

    test("nothing in the app ends a session because a browser went away", () => {
        // A sleeping laptop looks exactly like a closed browser from the server, so any timer that ends a
        // session on disconnect takes live conversations with it - the bug this session model removes.
        // These literals fail the moment a grace period or a disconnect sweep comes back.
        for (const name of ["config.js", "server.js", "sessions.js"]) {
            const source = readFileSync(join(TEMPLATES_DIR, "webterm", name), "utf8");
            assert.ok(!/grace|reap/i.test(source), `${name} must not end sessions on disconnect`);
        }
    });

    test("the session cap has a default and an env override", () => {
        const config = readFileSync(join(TEMPLATES_DIR, "webterm", "config.js"), "utf8");
        const match = /MAX_SESSIONS = Number\(process\.env\.WEBTERM_MAX_SESSIONS\)\s*\|\|\s*(\d+)/.exec(config);
        assert.ok(match, "config.js must default MAX_SESSIONS from WEBTERM_MAX_SESSIONS");
        assert.ok(Number(match?.[1]) > 0, "the cap must be a positive number of sessions");
    });

    test("/status answers with the two counts the host probe reads", () => {
        const server = readFileSync(join(TEMPLATES_DIR, "webterm", "server.js"), "utf8");
        const body = /app\.get\("\/status"[\s\S]*?res\.json\(([\s\S]*?)\);/.exec(server);
        assert.ok(body, "server.js must answer GET /status");
        const fields = body?.[1] ?? "";
        // webSessionInfo needs both numbers; renaming either one here would quietly drop the warning the
        // stop prompt shows before it ends live browser sessions.
        assert.ok(fields.includes("sessions:"), "/status must report the live session count");
        assert.ok(fields.includes("attached:"), "/status must report how many sessions a browser is watching");
    });
});

// ---- Browser self-awareness -------------------------------------------------------------------------------------------------------------
// claude, and only claude, is told it runs in the browser via a per-launch system-prompt file. The argv
// builder is pure and lives in config.js (no server side effects), so it loads the same way the registry
// test loads sessions.js.

describe("claude browser self-awareness", () => {
    const CONFIG_URL = pathToFileURL(join(TEMPLATES_DIR, "webterm", "config.js")).href;

    test("agentSpawnArgv appends the system-prompt flag for claude only", async () => {
        const { agentSpawnArgv } = (await import(CONFIG_URL)) as { agentSpawnArgv: (cmd: string, args: string[]) => string[] };

        const claude = agentSpawnArgv("claude", []);
        assert.ok(claude.includes("--append-system-prompt-file"), "claude must be told it runs in the browser");
        // A full path to the binary is still claude.
        assert.ok(agentSpawnArgv("/usr/local/bin/claude", []).includes("--append-system-prompt-file"));
        // The flag rides after any existing args (e.g. a resume), so a resumed claude keeps the awareness.
        assert.deepEqual(agentSpawnArgv("claude", ["--resume", "abc"]).slice(0, 2), ["--resume", "abc"]);

        for (const other of ["bash", "opencode", "codex"]) {
            assert.deepEqual(agentSpawnArgv(other, ["--foo"]), ["--foo"], `${other} must be spawned verbatim`);
        }
    });

    test("the baked note exists and config.js points at it", () => {
        const note = readFileSync(join(TEMPLATES_DIR, "webterm", "context", "claude.md"), "utf8").trim();
        assert.ok(note.length > 0, "the injected browser-awareness note must not be empty");
        const config = readFileSync(join(TEMPLATES_DIR, "webterm", "config.js"), "utf8");
        assert.ok(/CONTEXT_FILE\s*=/.test(config), "config.js must define CONTEXT_FILE");
        assert.ok(config.includes('"context", "claude.md"'), "CONTEXT_FILE must resolve the baked note");
    });
});

// ---- Resume-flag drift ------------------------------------------------------------------------------------------------------------------
// AGENT_RESUME_COMMAND hardcodes each CLI's resume flag; the CLIs update independently of totopo, so
// verify each flag against the CLI's own help output. The last token is always the flag; everything
// before it (binary + any subcommand) is what --help is asked of. Skips when the CLI is not installed
// (host machines without the agents) - inside a totopo container all three are present and this runs.

describe("AGENT_RESUME_COMMAND drift", () => {
    for (const [agent, command] of Object.entries(AGENT_RESUME_COMMAND)) {
        test(`${agent}: "${command}" still matches the CLI's help`, (t) => {
            const parts = command.split(" ");
            const flag = parts.at(-1) as string;
            const [bin, ...subcommands] = parts.slice(0, -1) as [string, ...string[]];

            const result = spawnSync(bin, [...subcommands, "--help"], { encoding: "utf8", stdio: "pipe", timeout: 30_000 });
            if (result.error) {
                t.skip(`${bin} is not installed here`);
                return;
            }

            const help = `${result.stdout ?? ""}${result.stderr ?? ""}`;
            assert.ok(
                help.includes(flag),
                `"${bin} ${[...subcommands, "--help"].join(" ")}" no longer mentions "${flag}" - update AGENT_RESUME_COMMAND in constants.ts`,
            );
        });
    }

    test('claude: "--resume <id>" (planted by resumeCommandFor) still matches the CLI\'s help', (t) => {
        const result = spawnSync("claude", ["--help"], { encoding: "utf8", stdio: "pipe", timeout: 30_000 });
        if (result.error) {
            t.skip("claude is not installed here");
            return;
        }
        const help = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        assert.ok(help.includes("--resume"), 'claude --help no longer mentions "--resume" - update resumeCommandFor in webterm.ts');
    });
});

// ---- Resume session selection -----------------------------------------------------------------------------------------------------------
// resumeCommandFor picks the claude session explicitly instead of trusting `claude --continue`,
// whose picker takes the newest transcript by mtime and silently starts fresh when that transcript
// has no real messages. These fixtures mirror the transcript shapes found in a real project dir.

describe("latestClaudeSessionId / resumeCommandFor", () => {
    let cacheDir: string;
    let projectDir: string;

    const REAL_LINE = `${JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "hi" } })}\n`;
    const CONTENTLESS_LINES = `${JSON.stringify({ type: "mode", mode: "normal" })}\n${JSON.stringify({ type: "system", subtype: "local_command", isSidechain: false })}\n`;
    const SIDECHAIN_LINE = `${JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: "sub task" } })}\n`;

    function addTranscript(sessionId: string, content: string, mtime: Date): void {
        const file = join(projectDir, `${sessionId}.jsonl`);
        writeFileSync(file, content);
        utimesSync(file, mtime, mtime);
    }

    beforeEach(() => {
        cacheDir = createTempDir();
        projectDir = join(cacheDir, "agents", "claude", "projects", "-workspace");
        mkdirSync(projectDir, { recursive: true });
    });

    afterEach(async () => {
        await cleanTempDir(cacheDir);
    });

    test("returns null when the project dir is missing or holds no transcripts", () => {
        assert.equal(latestClaudeSessionId(createTempDir()), null);
        assert.equal(latestClaudeSessionId(cacheDir), null);
    });

    test("picks the newest transcript that has a real user message", () => {
        addTranscript("11111111-1111-4111-8111-111111111111", REAL_LINE, new Date("2026-07-24T10:00:00Z"));
        addTranscript("22222222-2222-4222-8222-222222222222", REAL_LINE, new Date("2026-07-24T12:00:00Z"));
        assert.equal(latestClaudeSessionId(cacheDir), "22222222-2222-4222-8222-222222222222");
    });

    test("skips a newer contentless transcript (the silent-fresh trap of claude --continue)", () => {
        addTranscript("11111111-1111-4111-8111-111111111111", REAL_LINE, new Date("2026-07-24T10:00:00Z"));
        addTranscript("22222222-2222-4222-8222-222222222222", CONTENTLESS_LINES, new Date("2026-07-24T12:00:00Z"));
        assert.equal(latestClaudeSessionId(cacheDir), "11111111-1111-4111-8111-111111111111");
    });

    test("skips newer sidechain (subagent) transcripts and non-session files", () => {
        addTranscript("11111111-1111-4111-8111-111111111111", REAL_LINE, new Date("2026-07-24T10:00:00Z"));
        addTranscript("22222222-2222-4222-8222-222222222222", SIDECHAIN_LINE, new Date("2026-07-24T12:00:00Z"));
        writeFileSync(join(projectDir, "notes.jsonl"), REAL_LINE);
        assert.equal(latestClaudeSessionId(cacheDir), "11111111-1111-4111-8111-111111111111");
    });

    test("resumeCommandFor resumes claude by id and falls back to the generic flag", () => {
        assert.equal(resumeCommandFor("claude", cacheDir), AGENT_RESUME_COMMAND.claude);
        addTranscript("11111111-1111-4111-8111-111111111111", REAL_LINE, new Date("2026-07-24T10:00:00Z"));
        assert.equal(resumeCommandFor("claude", cacheDir), "claude --resume 11111111-1111-4111-8111-111111111111");
        // Non-claude agents always use their generic flag; the transcript scan is claude-specific.
        assert.equal(resumeCommandFor("codex", cacheDir), AGENT_RESUME_COMMAND.codex);
    });
});
