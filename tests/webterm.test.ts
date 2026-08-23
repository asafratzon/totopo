import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
    AGENT_RESUME_COMMAND,
    AUTO_START,
    AUTO_START_AGENTS,
    CONTAINER_KEEP_ALIVE,
    CONTAINER_USER,
    CONTAINER_WORKSPACE,
    RESUME_MARKER_PATH,
    WEB_CONTAINER_PORT,
    WEB_KEY_FILE_PATH,
} from "../src/lib/constants.js";
import {
    assignWebPortsToAllWorkspaces,
    claudeProjectKey,
    collectAssignedWebPorts,
    ensureWebPort,
    latestClaudeSessionId,
    nextFreeWebPort,
    reassignOutOfRangeWebPorts,
    resolveWebPort,
    resumeCommandFor,
    setWebDefaultCwd,
    webPortUsable,
    webSessionInfo,
    webtermExecArgs,
} from "../src/lib/webterm.js";
import { initWorkspaceDir, readWebPort, writeWebPort } from "../src/lib/workspace-identity.js";
import { cleanTempDir, createTempDir, overrideEnv, readWebtermClient } from "./helpers.js";

const TEMPLATES_DIR = join(import.meta.dirname, "..", "templates");
const SRC_DIR = join(import.meta.dirname, "..", "src");
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

describe("a web port that was taken while the image built", () => {
    // The create path re-probes the port minutes after run() picked it, and drops the mapping when something
    // else took it. That drop has to reach the caller: a session that carried on with the port it asked for
    // would launch the interface into a container that has no mapping, then poll - and believe - whatever
    // process now holds the port on the host.
    const DEV = readFileSync(join(SRC_DIR, "commands", "dev.ts"), "utf8");

    test("startContainer reports the port it really published", () => {
        assert.ok(
            /interface ContainerStartResult \{[\s\S]*?webPort: number \| null;/.test(DEV),
            "the result must carry the published port",
        );
        assert.ok(/const result = \(status: ContainerStartStatus\)[\s\S]*?webPort: publishedWebPort \?\? null/.test(DEV));
    });

    test("run stops using the port it asked for", () => {
        const uses = DEV.match(/webPort = startResult\.webPort;/g) ?? [];
        // Both calls: the first start, and the restart after a rebuild - which re-probes all over again.
        assert.equal(uses.length, 2, "every startContainer call must adopt the port it reports");
    });
});

describe("webSessionInfo", () => {
    // Stand in for the container's webterm server: /status answers with whatever body the test wants, and
    // remembers the key it was asked with - the real one refuses a probe that presents the wrong one.
    function serveStatus(body: string, status = 200): Promise<{ close: () => Promise<void>; port: number; lastKey: () => string | null }> {
        let lastKey: string | null = null;
        return new Promise((resolve) => {
            const server = createHttpServer((req, res) => {
                const url = new URL(req.url ?? "", "http://localhost");
                if (url.pathname !== "/status") {
                    res.writeHead(404).end();
                    return;
                }
                lastKey = url.searchParams.get("k");
                res.writeHead(status, { "content-type": "application/json" }).end(body);
            });
            server.listen(0, "127.0.0.1", () => {
                resolve({
                    port: (server.address() as AddressInfo).port,
                    lastKey: () => lastKey,
                    close: () => new Promise((done) => server.close(() => done())),
                });
            });
        });
    }

    test("reports live sessions and how many a browser is watching, presenting the key", async () => {
        const { close, port, lastKey } = await serveStatus('{"agent":"claude","sessions":3,"attached":1}');
        try {
            assert.deepEqual(await webSessionInfo(port, "abc123"), { sessions: 3, attached: 1 });
            assert.equal(lastKey(), "abc123", "the probe must carry the key the interface demands");
        } finally {
            await close();
        }
    });

    test("reports 0 sessions for an interface that is listening with nothing running", async () => {
        const { close, port } = await serveStatus('{"agent":"claude","sessions":0,"attached":0}');
        try {
            assert.deepEqual(await webSessionInfo(port, "abc123"), { sessions: 0, attached: 0 });
        } finally {
            await close();
        }
    });

    test("asks without a key when there is none to read, which is what an older container needs", async () => {
        const { close, port, lastKey } = await serveStatus('{"agent":"claude","sessions":1,"attached":0}');
        try {
            assert.deepEqual(await webSessionInfo(port, null), { sessions: 1, attached: 0 });
            assert.equal(lastKey(), null, "no key read means no key presented, not an empty one");
        } finally {
            await close();
        }
    });

    test("null when nothing is listening, so a dead interface never changes the stop prompt", async () => {
        const { server, port } = await occupyEphemeralPort();
        await closeServer(server);
        assert.equal(await webSessionInfo(port, "abc123"), null);
    });

    test("null when the interface refuses the key, so a stale key never reads as an empty container", async () => {
        const refused = await serveStatus('{"error":"missing or invalid key"}', 403);
        try {
            assert.equal(await webSessionInfo(refused.port, "stale"), null);
        } finally {
            await refused.close();
        }
    });

    test("null for an error status or an unexpected body", async () => {
        const failing = await serveStatus("nope", 500);
        try {
            assert.equal(await webSessionInfo(failing.port, "abc123"), null);
        } finally {
            await failing.close();
        }
        const garbage = await serveStatus('{"sessions":"many","attached":0}');
        try {
            assert.equal(await webSessionInfo(garbage.port, "abc123"), null);
        } finally {
            await garbage.close();
        }
        // A body missing half the answer is not usable either - the count drives what the prompt says.
        const partial = await serveStatus('{"agent":"claude","sessions":2}');
        try {
            assert.equal(await webSessionInfo(partial.port, "abc123"), null);
        } finally {
            await partial.close();
        }
    });
});

// ---- The URL's key ----------------------------------------------------------------------------------------------------------------------
// The relay refuses anything that does not present the key its server minted at startup. isAuthorized is
// the whole gate, and it is pure, so it loads the same way the argv builder below does.

describe("the key the URL carries", () => {
    // A module instance of its own: WEBTERM_KEY has to be set before config.js is first imported, and the
    // spawn-argv test imports it too. The query suffix is what makes this a separate instance.
    const KEYED_CONFIG_URL = `${pathToFileURL(join(TEMPLATES_DIR, "webterm", "config.js")).href}?keytest`;
    const PINNED = "0123456789abcdef0123456789abcdef";

    async function loadKeyed() {
        process.env.WEBTERM_KEY = PINNED;
        return (await import(KEYED_CONFIG_URL)) as { KEY: string; KEY_FILE: string; isAuthorized: (candidate: unknown) => boolean };
    }

    test("only the live key is accepted", async () => {
        const { KEY, isAuthorized } = await loadKeyed();
        assert.equal(KEY, PINNED);
        assert.ok(isAuthorized(PINNED));
        // Empty, absent, wrong-but-same-length and wrong-length all have to be refused, and none of them
        // may throw: they arrive straight off a URL anyone can type.
        assert.equal(isAuthorized(""), false);
        assert.equal(isAuthorized(undefined), false);
        assert.equal(isAuthorized(null), false);
        assert.equal(isAuthorized(PINNED.slice(0, -1)), false);
        assert.equal(isAuthorized(`${PINNED}x`), false);
        assert.equal(isAuthorized(PINNED.replace(/.$/, "0")), false);
        // A repeated ?k= parses to an array upstream; anything that is not a string is not a key.
        assert.equal(isAuthorized([PINNED] as unknown as string), false);
        // Same character count, more bytes: the comparison must weigh bytes or it throws.
        assert.equal(isAuthorized(`${PINNED.slice(0, -1)}é`), false);
    });

    test("a key nobody pinned is 128 bits of hex", () => {
        const config = readFileSync(join(TEMPLATES_DIR, "webterm", "config.js"), "utf8");
        const match = /KEY = process\.env\.WEBTERM_KEY \|\| randomBytes\((\d+)\)\.toString\("hex"\)/.exec(config);
        assert.ok(match, "config.js must mint the key from randomBytes when WEBTERM_KEY is unset");
        assert.ok(Number(match?.[1]) >= 16, "a guessable key is worse than no gate at all");
    });

    test("the launcher, the server and the greeting agree on where the key is published", async () => {
        const { KEY_FILE } = await loadKeyed();
        assert.equal(KEY_FILE, WEB_KEY_FILE_PATH, "config.js and constants.ts must name the same key file");
        const launcher = readFileSync(join(TEMPLATES_DIR, "webterm.sh"), "utf8");
        assert.ok(new RegExp(`^KEY_FILE=${WEB_KEY_FILE_PATH}$`, "m").test(launcher), "the launcher must read the same key file");
        assert.ok(launcher.includes("export WEBTERM_KEY_FILE="), "the launcher must pass the key file to the server");
        // Every URL the launcher prints is built from the file, so none of them can hand out a bare URL.
        assert.ok(launcher.includes('/?k=$(head -n 1 "$KEY_FILE")'), "the launcher must print the key with the URL");
    });

    test("every route that carries the relay is gated", () => {
        const server = readFileSync(join(TEMPLATES_DIR, "webterm", "server.js"), "utf8");
        assert.ok(/app\.get\(\["\/", "\/index\.html"\], requirePage\)/.test(server), "the page itself must need the key");
        assert.ok(/app\.post\("\/upload", requireKey/.test(server), "uploads must need the key");
        assert.ok(/app\.get\("\/status", requireKey/.test(server), "the status probe must need the key");
        // The handshake gate is the one that matters most: it is what drives an agent.
        assert.ok(/verifyClient[\s\S]*?isAuthorized\(handshakeKey\(req\.url\)\)/.test(server), "the WS handshake must need the key");
        // The Origin check stays as the second gate rather than being replaced by the key.
        assert.ok(server.includes("isAllowedOrigin(origin)"), "the origin check must survive alongside the key");
    });

    test("the client sends its key on everything the server gates", () => {
        const app = readWebtermClient();
        assert.ok(app.includes('new URLSearchParams(location.search).get("k")'), "the window takes its key from its URL");
        assert.ok(/const wsUrl = .*\/ws\$\{KEY_QUERY\}/.test(app), "the socket must carry the key");
        assert.ok(/fetch\(`\/upload\$\{KEY_QUERY\}`/.test(app), "uploads must carry the key");
        assert.ok(/fetch\(`\/status\$\{KEY_QUERY\}`/.test(app), "the probe that tells a stale key from a dead container must carry it");
    });

    test("a launcher that loses the race leaves the winner's key alone", () => {
        const launcher = readFileSync(join(TEMPLATES_DIR, "webterm.sh"), "utf8");
        // Two launchers can both find the port free. Deleting the key file would let the loser wipe the key
        // the winner just published, leaving an interface up that nobody can build a URL for.
        assert.ok(!/rm -f "\$KEY_FILE"/.test(launcher), "the launcher must never delete the key file");
        // Waiting for the value to change is what replaces the delete: a dead server's key is never printed,
        // and a live one's always is, whichever process published it.
        assert.ok(/PREV_KEY="\$\(head -n 1 "\$KEY_FILE"\)"/.test(launcher), "the launcher must remember the key it found");
        assert.ok(/!= "\$PREV_KEY"/.test(launcher), "the launcher must wait for a key that is not the old one");
        // The loser's server still tries to bind and cannot. That belongs in the log as a sentence.
        const server = readFileSync(join(TEMPLATES_DIR, "webterm", "server.js"), "utf8");
        assert.ok(/server\.on\("error"/.test(server), "a server that cannot bind must report it rather than throw a stack trace");
    });
});

// ---- A page that cannot do anything says so ---------------------------------------------------------------------------------------------

describe("the curtain", () => {
    const APP = readWebtermClient();

    test("the page goes inert the moment the socket does", () => {
        const html = readFileSync(join(TEMPLATES_DIR, "webterm", "public", "index.html"), "utf8");
        const css = readFileSync(join(TEMPLATES_DIR, "webterm", "public", "styles.css"), "utf8");
        assert.ok(html.includes('id="curtain"'), "the page needs the curtain element");
        // Fixed and over everything: a curtain inside the terminal area would leave the tab bar and the
        // composer live, which is the bug it exists to fix.
        assert.ok(/#curtain\s*\{[^}]*position:\s*fixed/.test(css), "the curtain must cover the whole page");
        assert.ok(/body\.offline #tabbar\s*\{[^}]*pointer-events:\s*none/.test(css), "the bar must stop taking clicks when offline");
        assert.ok(APP.includes('document.body.classList.add("offline")'), "a closed socket must mark the page offline at once");
    });

    test("a blip is waited out, a spent key is not", () => {
        // The grace is what keeps a sleeping laptop from flashing a curtain on every wake.
        const grace = /const CURTAIN_DELAY_MS = ([\d_]+)/.exec(APP);
        assert.ok(grace, "the down curtain must be delayed");
        assert.ok(Number((grace?.[1] ?? "0").replaceAll("_", "")) >= 1000, "a curtain that appears instantly would flash on every blip");
        // 403 is the relay saying "I am here and your key is not mine", which reconnecting cannot fix.
        assert.ok(/res\.status === 403[\s\S]{0,80}lockedCurtain\(\)/.test(APP), "a refused key must show the locked curtain");
        assert.ok(/function scheduleReconnect\(\)\s*\{\s*if \(halted/.test(APP), "the locked and stopping states must stop reconnecting");
    });

    test("a stop that has landed says so, instead of saying it is still stopping", () => {
        // Nothing else takes the relay down while the container is on its way out, so the closing socket is the
        // confirmation. Without this the page sits on "Stopping the container" for good, seconds after it stopped.
        assert.ok(/if \(curtainKind === "stopping"\) \{\s*stoppedCurtain\(\);/.test(APP), "a closed socket must end the stopping wait");
        assert.ok(/showCurtain\(\s*"stopped",/.test(APP), "there has to be a curtain for a container that has gone");
        // The wait looks like a wait, and only the wait does.
        assert.ok(/if \(kind === "stopping"\) heading\.append\(pendingDots\(\)\)/.test(APP), "only the stopping curtain shows dots");
    });

    test("coming back from a blip starts nothing", () => {
        const server = readFileSync(join(TEMPLATES_DIR, "webterm", "server.js"), "utf8");
        // Opening the page means "put me somewhere"; reconnecting means "give me back what I had". Without
        // the distinction, a laptop waking up on an empty bar spawns an agent nobody asked for.
        assert.ok(/sendFrame\(\{ t: "hello", sid: [^}]*fresh \}\)/.test(APP), "the window must say whether this is its first socket");
        assert.ok(/const fresh = !everConnected;/.test(APP), "only the page's first socket is fresh");
        assert.ok(/greet\(ws, sid, msg\.fresh === true\)/.test(server), "the server must take the flag from the frame");
        assert.ok(/registry\.count\(\) === 0\)\s*\{\s*if \(fresh\) newSession\(ws\);/.test(server), "only a fresh window auto-creates");
    });
});

// ---- Stopping the container from the page -----------------------------------------------------------------------------------------------

describe("stop the container", () => {
    test("the keep-alive can be stopped from inside the container", () => {
        // PID 1 only receives a signal from inside its own namespace when it has a handler for it, so the
        // trap is the whole reason the button can work at all.
        const command = CONTAINER_KEEP_ALIVE.join(" ");
        assert.ok(command.includes("trap"), "the keep-alive must trap TERM or nothing in the container can stop it");
        assert.ok(/\bTERM\b/.test(command), "the trap must cover the signal docker and the server both send");
    });

    test("the container is only stopped after a card that names what it ends", () => {
        const app = readWebtermClient();
        // The click opens the card; only the card's own button sends the frame.
        assert.ok(app.includes('button.addEventListener("click", stopCard)'), "the power button must ask first");
        assert.ok(/stopCard[\s\S]*?run: \(\) => sendFrame\(\{ t: "stop" \}\)/.test(app), "only the confirmed card may send the stop frame");
    });

    test("the server announces the stop before it signals, and reports one that did not take", () => {
        const server = readFileSync(join(TEMPLATES_DIR, "webterm", "server.js"), "utf8");
        const stop = /function stopContainer\(\)[\s\S]*?\n}/.exec(server)?.[0] ?? "";
        assert.ok(stop.includes('send(client, { t: "stopping" })'), "every window has to hear it before the container goes");
        // The announce has to be sent before the signal, or a window learns nothing and blames the network.
        assert.ok(stop.indexOf('t: "stopping"') < stop.indexOf("process.kill(1"), "announce first, signal second");
        assert.ok(stop.includes('{ t: "error", code: "stop" }'), "a signal that changed nothing must be reported");
    });
});

// ---- The two boxes on the page agree about the keyboard ---------------------------------------------------------------------------------

describe("composing a message", () => {
    const APP = readWebtermClient();

    test("Shift+Enter is a newline in the terminal as well as in the composer", () => {
        // A terminal has no Shift+Enter: Enter is a carriage return whatever else is held. ESC then CR is what the
        // agents read as a newline (it is what Alt+Enter sends), so the shortcut has to be mapped onto that byte
        // pair rather than passed through, or it just submits the message.
        assert.ok(
            /event\.key === "Enter" && event\.shiftKey[\s\S]{0,220}sendFrame\(\{ t: "in", data: "\\x1b\\r" \}\)/.test(APP),
            "Shift+Enter in the terminal must send ESC then CR",
        );
        // The composer's own Enter must stay a send, and its Shift+Enter the textarea's own newline.
        assert.ok(/if \(e\.key === "Enter" && !e\.shiftKey\) \{\s*e\.preventDefault\(\);\s*send\(\);/.test(APP), "Enter alone still sends");
    });

    test("Up recalls a sent message without ever taking a written one away", () => {
        // The two rules that keep the arrows out of ordinary typing: never start from a box with something in it,
        // and never step on from the middle of a message that is already showing.
        assert.ok(/if \(historyAt === null && input\.value !== ""\) return;/.test(APP), "Up must not disturb a half-written message");
        assert.ok(/if \(!atFirstLine\(\)\) return;/.test(APP), "Up inside a multi-line message must move the caret");
        assert.ok(/endHistoryWalk\(\)/.test(APP), "typing has to end the walk");
        // Stored after the image tokens are expanded, or a recalled message means something different the second time.
        assert.ok(
            /sendFrame\(\{ t: "paste", data: text \}\)[\s\S]{0,200}rememberSent\(sid, text\)/.test(APP),
            "history stores what was sent",
        );
        assert.ok(APP.includes("dropHistory(msg.sid)"), "a session that ends takes its history with it");
    });
});

// ---- The sound an alert makes -----------------------------------------------------------------------------------------------------------

describe("the finish chime", () => {
    const APP = readWebtermClient();

    test("it waits after the alert, long enough to be answered and no longer", () => {
        // The hold is the entire presence test: an alert still standing at the end of it is one nobody came back to.
        // Both ends matter. Too short and it fires at a pause you were about to type into; too long and the finish
        // you are waiting for arrives after you have given up on it, which is the complaint that set this length.
        const hold = /const CHIME_HOLD_MS = ([\d_]+)/.exec(APP);
        assert.ok(hold, "the chime must have its own hold");
        const ms = Number((hold?.[1] ?? "0").replaceAll("_", ""));
        assert.ok(ms >= 5_000, "a hold this short leaves no time to answer the alert");
        assert.ok(ms <= 15_000, "a sound this late is one the user has stopped waiting for");
        // And the alert is all it reads. Not browser focus, which is what it used to read, and not anything about
        // the turn that came before - the prompt you sent does not buy silence.
        assert.ok(/entry\.attention && !chimed\.has/.test(APP), "the sound waits on the alert itself");
        assert.ok(!/t: "away"/.test(APP), "browser focus is no longer what decides");
        assert.ok(!/entry\.chime/.test(APP), "nothing before the ending has a say any more");
    });

    test("one finish is one sound, in one window", () => {
        // Marked before the mute and on-screen tests, so an alert that stays quiet is spent rather than saved up to
        // go off later when the window is put away.
        assert.ok(/for \(const entry of due\) chimed\.add\(entry\.id\);/.test(APP), "a due alert is spent whether or not it is heard");
        assert.ok(/chimed\.delete\(sid\)/.test(APP), "a spent alert must clear, or a session can only ever chime once");
        // Two windows on the same container see the same alert, and one sound is the point.
        assert.ok(APP.includes("CHIME_CLAIM_KEY"), "windows must be able to see each other's chime");
        assert.ok(/localStorage\.setItem\(SOUND_KEY/.test(APP), "muting must outlive the page it was clicked on");
    });

    test("the bell sits with the power button and the sound ships as code, not as a file", () => {
        const css = readFileSync(join(TEMPLATES_DIR, "webterm", "public", "styles.css"), "utf8");
        assert.ok(APP.includes("right.append(bellButton(), stopButton())"), "the bell belongs in the bar's right-hand cluster");
        assert.ok(/#bellbtn\.muted\s*\{[^}]*opacity/.test(css), "muted has to read as off without relying on the slash alone");
        // Synthesised, like the favicon above it is drawn: nothing to fetch, nothing to license, and the whole sound
        // is three numbers times three in the source.
        const assets = readdirSync(join(TEMPLATES_DIR, "webterm", "public"));
        const audio = assets.filter((name) => /\.(mp3|ogg|wav|m4a|aac|flac)$/i.test(name));
        assert.deepEqual(audio, [], "the chime must stay synthesised rather than shipped as an asset");
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

    test("the app scopes sessions to the directory the container mounts the workspace at", () => {
        const config = readFileSync(join(TEMPLATES_DIR, "webterm", "config.js"), "utf8");
        const match = /WORKSPACE_ROOT = "([^"]+)"/.exec(config);
        assert.ok(match, "config.js must declare the workspace root it scopes sessions to");
        assert.equal(match?.[1], CONTAINER_WORKSPACE, "the app would refuse every real directory if this drifted");
    });

    test("the launcher passes the session directory on, and falls back to its own", () => {
        const launcher = readFileSync(join(TEMPLATES_DIR, "webterm.sh"), "utf8");
        const config = readFileSync(join(TEMPLATES_DIR, "webterm", "config.js"), "utf8");
        // The host's value has to win (it is the directory totopo ran in), and a hand-run has to still get
        // the shell's own directory - which is what the fallback shape says.
        assert.match(
            launcher,
            /export WEBTERM_CWD="\$\{WEBTERM_CWD:-\$PWD\}"/,
            "launcher must pass WEBTERM_CWD, defaulting to its own $PWD",
        );
        assert.ok(config.includes("process.env.WEBTERM_CWD"), "config.js must read WEBTERM_CWD");
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

// ---- Several agents, one server ---------------------------------------------------------------------------------------------------------
// The agent is per session, so the server has to know which ones it will run and refuse anything else: a name
// from the browser ends up as a process. The list is the same one the launcher accepts and the same one totopo
// can auto-start, and this is where those three are pinned to each other.

describe("the agents one server will run", () => {
    const CONFIG_URL = pathToFileURL(join(TEMPLATES_DIR, "webterm", "config.js")).href;

    test("isKnownAgent accepts exactly the auto-start agents", async () => {
        const { AGENTS, isKnownAgent } = (await import(CONFIG_URL)) as { AGENTS: string[]; isKnownAgent: (name: unknown) => boolean };
        const expected = AUTO_START_AGENTS.filter((agent) => agent !== AUTO_START.off);
        assert.deepEqual(AGENTS.slice().sort(), expected.slice().sort(), "config.js agent list drifted from AUTO_START_AGENTS");
        for (const agent of AGENTS) assert.ok(isKnownAgent(agent));
        // A name that is not on the list is a spawn that must never happen, however it arrived.
        for (const bad of ["bash", "sh -c rm", "", "CLAUDE", null, undefined, 7, {}]) {
            assert.equal(isKnownAgent(bad), false, `${String(bad)} must not be runnable`);
        }
    });

    test("the default agent falls back to a known one rather than to whatever the env said", async () => {
        const { AGENTS, DEFAULT_AGENT } = (await import(CONFIG_URL)) as { AGENTS: string[]; DEFAULT_AGENT: string };
        // The launcher validates its argument too, so this is the second lock: a bare `node server.js`, or an
        // env var set by hand, cannot make "+ New session" spawn something arbitrary.
        assert.ok(AGENTS.includes(DEFAULT_AGENT), "the default must be an agent this server runs");
    });

    test("the launcher moves the default over the same key-gated route the browser uses", () => {
        const launcher = readFileSync(join(TEMPLATES_DIR, "webterm.sh"), "utf8");
        const server = readFileSync(join(TEMPLATES_DIR, "webterm", "server.js"), "utf8");
        assert.ok(/app\.post\("\/agent", requireKey/.test(server), "the route must demand the key like every other one");
        assert.ok(launcher.includes("/agent?k="), "the launcher must call it with the live key");
        // The whole point: naming another agent no longer ends the sessions that are open.
        assert.ok(!launcher.includes("pkill"), "switching agents must not kill the server any more");
    });

    test("a session's agent reaches the PTY, and only the default agent's own args ride along", () => {
        const server = readFileSync(join(TEMPLATES_DIR, "webterm", "server.js"), "utf8");
        assert.ok(/function spawnAgent\(\{ cwd, agent \}\)/.test(server), "the registry passes the agent through to the spawn");
        assert.ok(/agent === DEFAULT_AGENT \? AGENT_ARGS : \[\]/.test(server), "WEBTERM_AGENT_ARGS belong to the agent it was set for");
        // The resume marker holds a command for the agent the host started the interface with, so no other agent
        // may claim it - it would consume the conversation and then fail to open it.
        assert.ok(/if \(!RESUME_MARKER \|\| agent !== DEFAULT_AGENT\) return null;/.test(server));
    });

    test("a name the server does not run is refused before anything can be started", () => {
        // isKnownAgent is only a lock if it is asked first. The frame comes off a socket, so an unknown name here
        // is either a stale page or something hand-made, and the gap between reading it and spawning it is the
        // whole attack surface: nothing may reach create() until the name has been checked against the list.
        const server = readFileSync(join(TEMPLATES_DIR, "webterm", "server.js"), "utf8");
        const body = /function newSession\(ws, rawCwd, rawAgent\) \{([\s\S]*?)\n\}/.exec(server)?.[1] ?? "";
        assert.ok(body, "server.js must define newSession");
        const checked = body.indexOf("const agent = sessionAgent(rawAgent);");
        const refused = body.indexOf('send(ws, { t: "error", code: "agent" });');
        const created = body.indexOf("registry.create(");
        assert.ok(checked >= 0 && refused > checked, "an unknown agent has to be turned away, not swapped for the default");
        assert.ok(created > refused, "the refusal must come before the spawn");
        assert.ok(/return isKnownAgent\(raw\) \? raw : null;/.test(server), "and the check is the shared list, not a local one");
    });

    test("the panel asks both halves of what a session is, and sends them together", () => {
        // Which agent and which directory are the only two things that make a session and neither can be changed
        // later, so they are one question. Two controls could not say "codex, over there" at all, which is the
        // hole this closed; a frame that carried only one of them would reopen it.
        const app = readWebtermClient();
        assert.ok(/sendFrame\(\{ t: "new", cwd: field\.value\.trim\(\), agent: state\.agent \}\)/.test(app));
        // And the plain button stays one click: no cwd, no agent, both defaulted by the server.
        assert.ok(/add\.addEventListener\("click", \(\) => sendFrame\(\{ t: "new" \}\)\)/.test(app));
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

// ---- Where a session starts -------------------------------------------------------------------------------------------------------------
// A terminal session opens in the directory totopo ran in. The interface has to make the same promise, which
// takes two things: the directory reaching the launcher at container start, and a way to move it afterwards
// for a container that was already up.

describe("the directory the interface starts sessions in", () => {
    test("the launcher is told the directory through the environment, and the agent stays explicit", () => {
        const args = webtermExecArgs("totopo-demo", "claude", "/workspace/apps/api");

        assert.deepEqual(args, [
            "exec",
            "-d",
            "-u",
            CONTAINER_USER,
            "-e",
            "WEBTERM_CWD=/workspace/apps/api",
            "totopo-demo",
            "webterm",
            "claude",
        ]);
        // `docker exec -w` on a path docker cannot use fails the whole exec, which would cost the session its
        // interface over something the server can just refuse.
        assert.ok(!args.includes("-w"), "the directory must not be passed as the exec working directory");
    });
});

describe("setWebDefaultCwd", () => {
    // Stand in for the container's webterm server: POST /cwd remembers the key and the body it was asked
    // with, so the test can check both reached it.
    function serveCwd(status = 200): Promise<{
        close: () => Promise<void>;
        port: number;
        lastKey: () => string | null;
        lastBody: () => string;
    }> {
        let lastKey: string | null = null;
        let lastBody = "";
        return new Promise((resolve) => {
            const server = createHttpServer((req, res) => {
                const url = new URL(req.url ?? "", "http://localhost");
                if (req.method !== "POST" || url.pathname !== "/cwd") {
                    res.writeHead(404).end();
                    return;
                }
                lastKey = url.searchParams.get("k");
                let body = "";
                req.on("data", (chunk) => {
                    body += chunk;
                });
                req.on("end", () => {
                    lastBody = body;
                    res.writeHead(status, { "content-type": "application/json" }).end('{"default":"apps/api"}');
                });
            });
            server.listen(0, "127.0.0.1", () => {
                resolve({
                    port: (server.address() as AddressInfo).port,
                    lastKey: () => lastKey,
                    lastBody: () => lastBody,
                    close: () => new Promise((done) => server.close(() => done())),
                });
            });
        });
    }

    test("sends the directory this session started from, carrying the key", async () => {
        const { close, port, lastKey, lastBody } = await serveCwd();
        try {
            assert.equal(await setWebDefaultCwd(port, "abc123", "/workspace/apps/api"), true);
            assert.equal(lastKey(), "abc123");
            assert.deepEqual(JSON.parse(lastBody()), { cwd: "/workspace/apps/api" });
        } finally {
            await close();
        }
    });

    test("false when the interface refuses the key or the path, so nothing reads as moved", async () => {
        const refused = await serveCwd(403);
        try {
            assert.equal(await setWebDefaultCwd(refused.port, "stale", "/workspace"), false);
        } finally {
            await refused.close();
        }
        const rejected = await serveCwd(400);
        try {
            assert.equal(await setWebDefaultCwd(rejected.port, "abc123", "/etc"), false);
        } finally {
            await rejected.close();
        }
    });

    test("false when nothing is listening - the push is a convenience, never a failure", async () => {
        const { server, port } = await occupyEphemeralPort();
        await closeServer(server);
        assert.equal(await setWebDefaultCwd(port, "abc123", "/workspace"), false);
    });
});

// ---- Which directory a session may start in ---------------------------------------------------------------------------------------------
// The rule is scoping, not security (the container is the boundary): a path has to name a directory that
// exists inside the workspace, so the picker cannot start an agent somewhere the user did not mean.

describe("the paths the app accepts for a session", () => {
    const CONFIG_URL = pathToFileURL(join(TEMPLATES_DIR, "webterm", "config.js")).href;
    let root: string;
    let helpers: {
        resolveWorkspacePath: (raw: unknown, root?: string) => string | null;
        workspaceLabel: (absolute: string, root?: string) => string;
    };

    beforeEach(async () => {
        root = createTempDir();
        mkdirSync(join(root, "apps", "api"), { recursive: true });
        writeFileSync(join(root, "readme.md"), "not a directory");
        helpers = (await import(CONFIG_URL)) as typeof helpers;
    });

    afterEach(async () => {
        await cleanTempDir(root);
    });

    test("nothing, a relative path and a full path all name a directory inside the workspace", () => {
        assert.equal(helpers.resolveWorkspacePath("", root), root, "empty is the workspace root");
        assert.equal(helpers.resolveWorkspacePath("  apps/api  ", root), join(root, "apps", "api"), "and it is trimmed");
        assert.equal(helpers.resolveWorkspacePath(join(root, "apps"), root), join(root, "apps"));
    });

    test("null for anything outside the workspace, or that is not a directory", () => {
        assert.equal(helpers.resolveWorkspacePath("../..", root), null);
        assert.equal(helpers.resolveWorkspacePath("apps/../../elsewhere", root), null);
        assert.equal(helpers.resolveWorkspacePath("/etc", root), null);
        assert.equal(helpers.resolveWorkspacePath("apps/missing", root), null);
        assert.equal(helpers.resolveWorkspacePath("readme.md", root), null, "a file is not somewhere an agent can run");
        assert.equal(helpers.resolveWorkspacePath(undefined, root), root, "no value at all reads as the root");
    });

    test("a directory reaches the browser relative to the workspace, with the root as an empty string", () => {
        assert.equal(helpers.workspaceLabel(root, root), "", "the root has no path worth showing on a tab");
        assert.equal(helpers.workspaceLabel(join(root, "apps", "api"), root), join("apps", "api"));
    });
});

// ---- Resuming in a sub-directory --------------------------------------------------------------------------------------------------------
// claude keeps a separate history per directory, so the resume command has to name a conversation from the
// directory the session will actually run in. Handing it one from elsewhere either fails outright or drops
// the user into another directory's history.

describe("resuming a conversation in a sub-directory", () => {
    const NESTED = "/workspace/apps/api";
    const OLDER = new Date("2026-07-24T10:00:00Z");
    const NEWER = new Date("2026-07-24T12:00:00Z");
    const AT_ROOT = "11111111-1111-4111-8111-111111111111";
    const AT_NESTED = "22222222-2222-4222-8222-222222222222";

    let cacheDir: string;

    // A transcript's one real user message, with or without the directory claude recorded on it (transcripts
    // written before claude carried the field are the reason the fallback exists).
    function userLine(cwd: string | null): string {
        const record: Record<string, unknown> = { type: "user", isSidechain: false, message: { role: "user", content: "hi" } };
        if (cwd !== null) record.cwd = cwd;
        return `${JSON.stringify(record)}\n`;
    }

    function addTranscript(projectKey: string, sessionId: string, cwd: string | null, mtime: Date): void {
        const dir = join(cacheDir, "agents", "claude", "projects", projectKey);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${sessionId}.jsonl`);
        writeFileSync(file, userLine(cwd));
        utimesSync(file, mtime, mtime);
    }

    beforeEach(() => {
        cacheDir = createTempDir();
    });

    afterEach(async () => {
        await cleanTempDir(cacheDir);
    });

    test("claudeProjectKey names a directory's transcript dir the way claude does", () => {
        assert.equal(claudeProjectKey(CONTAINER_WORKSPACE), "-workspace");
        assert.equal(claudeProjectKey(NESTED), "-workspace-apps-api");
        assert.equal(claudeProjectKey("/workspace/my.app_1"), "-workspace-my-app-1");
    });

    test("picks the newest conversation from that directory, not the newest overall", () => {
        addTranscript("-workspace", AT_ROOT, CONTAINER_WORKSPACE, NEWER);
        addTranscript("-workspace-apps-api", AT_NESTED, NESTED, OLDER);

        assert.equal(latestClaudeSessionId(cacheDir, NESTED), AT_NESTED);
        assert.equal(latestClaudeSessionId(cacheDir, CONTAINER_WORKSPACE), AT_ROOT);
    });

    test("finds it wherever claude filed it, because the recorded directory is what decides", () => {
        // A dir name this code would never derive: if the naming ever changes, what the transcript says
        // about itself still matches.
        addTranscript("-workspace-apps-api-2", AT_NESTED, NESTED, OLDER);

        assert.equal(latestClaudeSessionId(cacheDir, NESTED), AT_NESTED);
    });

    test("transcripts too old to record a directory fall back to the dir name", () => {
        addTranscript("-workspace-apps-api", AT_NESTED, null, OLDER);
        addTranscript("-workspace", AT_ROOT, null, NEWER);

        assert.equal(latestClaudeSessionId(cacheDir, NESTED), AT_NESTED, "the root's newer history is not this directory's");
        assert.equal(latestClaudeSessionId(cacheDir, CONTAINER_WORKSPACE), AT_ROOT);
    });

    test("resumeCommandFor plants that directory's own conversation", () => {
        addTranscript("-workspace", AT_ROOT, CONTAINER_WORKSPACE, NEWER);
        addTranscript("-workspace-apps-api", AT_NESTED, NESTED, OLDER);

        assert.equal(resumeCommandFor("claude", cacheDir, NESTED), `claude --resume ${AT_NESTED}`);
        assert.equal(resumeCommandFor("claude", cacheDir), `claude --resume ${AT_ROOT}`, "no directory given means the workspace root");
    });

    test("no history for the directory starts fresh rather than resuming another one's", () => {
        addTranscript("-workspace", AT_ROOT, CONTAINER_WORKSPACE, NEWER);

        assert.equal(resumeCommandFor("claude", cacheDir, NESTED), AGENT_RESUME_COMMAND.claude);
    });
});
