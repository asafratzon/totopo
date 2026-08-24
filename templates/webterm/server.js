// server.js - HTTP + WebSocket relay for interactive AI agent CLI sessions.
//
// The page is mission control for this container: it lists every live session (one PTY each, running an
// agent in the workspace) as tabs, and one of them is attached to the browser window at a time. Sessions
// pick their own agent, so claude and codex can be two tabs of the same bar.
// The window renders the live TUI (xterm.js) and forwards keystrokes; a rich composer uploads
// pasted images to /tmp/uploads and injects the composed message as one bracketed paste.
// Sessions belong to the server, not to the socket: see sessions.js for what that buys.
// Every route that carries the relay is gated by the key the URL holds (?k=), minted fresh at every start.
// Auth and sandbox are inherited: the spawned CLI sees the same agent config dirs and the same
// container isolation it has in the terminal. Nothing here touches credentials.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import {
    AGENT_ARGS,
    AGENT_STORES,
    AGENTS,
    AUTO_RESUME,
    agentSpawnArgv,
    CHECK_INTERVAL_MS,
    CLIENT_PING_INTERVAL_MS,
    DEFAULT_AGENT,
    DIR_SCAN_DEPTH,
    DIR_SCAN_MAX,
    DIR_SCAN_SKIP,
    isAllowedOrigin,
    isAuthorized,
    isKnownAgent,
    KEY,
    KEY_FILE,
    MAX_OUTPUT_BUFFER,
    MAX_SESSIONS,
    MAX_UPLOAD_BYTES,
    PASTE_END,
    PASTE_START,
    PORT,
    RESUME_STAMP,
    resolveWorkspacePath,
    STATE_FILE,
    STATUS_SCAN_MS,
    STOP_ANNOUNCE_MS,
    STOP_TIMEOUT_MS,
    SUBMIT,
    SUBMIT_DELAY_MS,
    UPLOAD_DIR,
    UPLOAD_MAX_AGE_MS,
    WEBTERM_CWD_RAW,
    WORKSPACE,
    WORKSPACE_ROOT,
    workspaceLabel,
} from "./config.js";
import { claimResumeChance, resumeArgvFor } from "./resume.js";
import { createRegistry, WORK_TICK_MS } from "./sessions.js";
import { statusFor, writesSnapshots } from "./snapshot.js";

// node-pty is a native CommonJS addon; load it through createRequire under ESM.
const require = createRequire(import.meta.url);
const pty = require("node-pty");

// --- Upload dir + weekly cleanup check ---------------------------------------------------------------------------------------------------

// Resolve once; every delete is checked to stay strictly under this path.
const UPLOAD_ROOT = resolve(UPLOAD_DIR);

function ensureUploadDir() {
    if (!existsSync(UPLOAD_ROOT)) mkdirSync(UPLOAD_ROOT, { recursive: true });
}

// True only for a path that lives strictly inside UPLOAD_ROOT. Mirrors the guard-then-delete
// ethos of src/lib/safe-rm.ts: we refuse to unlink anything outside the upload dir.
function isInsideUploadRoot(p) {
    const full = resolve(p);
    return full.startsWith(UPLOAD_ROOT + sep);
}

// Weekly, age-based cleanup check. Deletes only regular files older than UPLOAD_MAX_AGE_MS,
// only within UPLOAD_ROOT, best-effort. Logs a one-line summary (no silent truncation).
function checkUploads() {
    ensureUploadDir();
    const cutoff = Date.now() - UPLOAD_MAX_AGE_MS;
    let removed = 0;
    let kept = 0;
    for (const name of readdirSync(UPLOAD_ROOT)) {
        const full = join(UPLOAD_ROOT, name);
        try {
            const st = statSync(full);
            if (!st.isFile()) continue;
            if (st.mtimeMs < cutoff && isInsideUploadRoot(full)) {
                unlinkSync(full);
                removed += 1;
            } else {
                kept += 1;
            }
        } catch {
            // Best-effort: a vanished or unreadable entry is not fatal to the check.
        }
    }
    console.log(`[webterm] upload check: removed ${removed}, kept ${kept} (older-than 7d, ${UPLOAD_ROOT})`);
}

// --- Where sessions start ----------------------------------------------------------------------------------------------------------------
//
// A terminal session opens in the directory `npx totopo` ran in. A browser session cannot copy that: the
// server is one process per container that outlives every invocation, so "the directory" is not a property
// of how the interface was reached. It is two things instead - a default every new session takes, which the
// host keeps pointed at wherever totopo last ran, and a directory the browser can name per session.

// The default. Seeded from what the launcher passed and refused when it is not a directory inside the
// workspace, so a stray value falls back to the root with a line saying so rather than failing every
// session that follows.
let defaultCwd = resolveWorkspacePath(WEBTERM_CWD_RAW) ?? WORKSPACE_ROOT;
const defaultCwdRefused = WEBTERM_CWD_RAW !== "" && resolveWorkspacePath(WEBTERM_CWD_RAW) === null;

/**
 * Where a session the browser asked for should run, or null when the path names nothing usable.
 * No path at all means the default, which is what the plain "+ New session" sends.
 *
 * The browser writes paths relative to the workspace root, so that is tried first, and "/" reads there as
 * the root itself. A full container path ("/workspace/src") is accepted too, because someone reading it off
 * a terminal prompt will type it and refusing that would be pedantry rather than a rule.
 */
function sessionCwd(raw) {
    if (typeof raw !== "string") return defaultCwd;
    return resolveWorkspacePath(raw) ?? resolveWorkspacePath(raw.replace(/^\/+/, ""));
}

// --- Which agent a session runs ----------------------------------------------------------------------------------------------------------
//
// The same shape as the directory above: a default that new sessions take, which the launcher seeds and the
// container command can move, and a per-session choice the browser can make. A session's agent is fixed for
// its whole life - it is the process - so nothing here ever touches a live one.

let defaultAgent = DEFAULT_AGENT;

/**
 * The agent a session the browser asked for should run, or null when it named something we do not run.
 * No agent at all means the default, which is what the plain "+ New session" sends.
 */
function sessionAgent(raw) {
    if (raw === undefined || raw === null) return defaultAgent;
    return isKnownAgent(raw) ? raw : null;
}

// The one-line file that names the default agent, for the `webterm` launcher to read back. Written when the
// port is bound and again whenever the default moves, so a second `webterm <agent>` can say what is live.
function publishAgent() {
    if (!STATE_FILE) return;
    try {
        writeFileSync(STATE_FILE, `${defaultAgent}\n`);
    } catch (err) {
        console.warn(`[webterm] could not write ${STATE_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * The directories the picker offers. Bounded on purpose (see DIR_SCAN_* in config.js): a deep walk of a
 * real workspace is slow and the list would be unreadable anyway. Dot directories and the skip list are
 * never descended into, and neither are symlinks - a link out of the workspace would list paths that the
 * picker then refuses. Breadth-first, so a cap that bites drops the deepest entries rather than a whole
 * branch, and it reports the cut so the caller can say the list is partial.
 */
function scanDirs() {
    const found = [];
    let queue = [WORKSPACE_ROOT];
    let truncated = false;
    for (let depth = 0; depth < DIR_SCAN_DEPTH && queue.length > 0 && !truncated; depth++) {
        const next = [];
        for (const dir of queue) {
            let entries;
            try {
                entries = readdirSync(dir, { withFileTypes: true });
            } catch {
                continue; // Unreadable directory: nothing to offer from it.
            }
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.name.startsWith(".") || DIR_SCAN_SKIP.has(entry.name)) continue;
                if (found.length >= DIR_SCAN_MAX) {
                    truncated = true;
                    break;
                }
                const full = join(dir, entry.name);
                found.push(workspaceLabel(full));
                next.push(full);
            }
            if (truncated) break;
        }
        queue = next;
    }
    if (truncated) console.log(`[webterm] directory list capped at ${DIR_SCAN_MAX} - deeper directories can still be typed in`);
    return { dirs: found, truncated };
}

// --- The key gate ------------------------------------------------------------------------------------------------------------------------

// Publish the live key where the things that print the URL can read it: the `webterm` launcher, the
// container greeting, and totopo on the host before it probes /status. Called once the port is bound and
// never before - a second server that loses the bind must not leave its key behind as if it had won.
// Owner-only, and chmod'ed after the write because the mode above applies to a file being created rather
// than to one that already exists.
// Best-effort: a key that cannot be published still gates the relay, it only leaves the URL unprintable.
function publishKey() {
    try {
        writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });
        chmodSync(KEY_FILE, 0o600);
    } catch (err) {
        console.error(`[webterm] could not publish the key to ${KEY_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

// The key a request presents. Only a plain `?k=` string counts: a repeated parameter parses to an array,
// which is not a key.
function presentedKey(value) {
    return typeof value === "string" ? value : "";
}

// What a browser gets instead of the page when its URL has no valid key. Deliberately self-contained -
// the app's stylesheet and script are for a window that got in, and a locked page must stand on its own.
const LOCKED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>totopo - key required</title>
<style>
 body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center; background:#0d1117; color:#e6edf3;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
 main { max-width:34rem; padding:2rem; }
 h1 { font-size:1.15rem; margin:0 0 .9rem; }
 p { margin:0 0 .7rem; color:#8b949e; line-height:1.5; }
 code { color:#e6edf3; background:#161b22; border:1px solid #30363d; border-radius:5px; padding:.1rem .35rem; }
</style></head>
<body><main>
 <h1>This link needs its key</h1>
 <p>The web interface issues a new key every time it starts, and only the URL it printed can open it.</p>
 <p>Get the current URL from the session greeting, or run <code>webterm &lt;agent&gt;</code> inside the container.</p>
</main></body></html>
`;

// The gate on every route that carries the relay. Static assets stay open: they hold nothing secret and
// drive nothing, and gating them would mean a cookie - which on localhost is shared across ports, so any
// other local port could ride this workspace's. The key stays in the URL, scoped to the window given it.
// Two gates for one rule, differing only in what a refusal looks like: a person opening a URL gets a page
// that says what is missing, and the app's own calls get the JSON their callers already read.
function requirePage(req, res, next) {
    if (isAuthorized(presentedKey(req.query.k))) {
        next();
        return;
    }
    console.warn(`[webterm] refused ${req.method} ${req.path}: no valid key`);
    res.status(403).type("html").send(LOCKED_PAGE);
}

function requireKey(req, res, next) {
    if (isAuthorized(presentedKey(req.query.k))) {
        next();
        return;
    }
    console.warn(`[webterm] refused ${req.method} ${req.path}: no valid key`);
    res.status(403).json({ error: "missing or invalid key" });
}

// --- Upload endpoint ---------------------------------------------------------------------------------------------------------------------

// Map a small set of image content-types to file extensions. Anything else is rejected.
const IMAGE_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
};

const app = express();

// The document is the one static file behind the gate, and it is the only one that matters: a window that
// never got the page opens no socket, so the interface as a whole is unreachable without the key.
app.get(["/", "/index.html"], requirePage);

// Serve the client and xterm's shipped dist files straight from node_modules (no bundler).
app.use(express.static(join(import.meta.dirname, "public")));
app.use("/vendor/xterm", express.static(join(import.meta.dirname, "node_modules", "@xterm", "xterm", "css")));
app.use("/vendor/xterm", express.static(join(import.meta.dirname, "node_modules", "@xterm", "xterm", "lib")));
app.use("/vendor/xterm-fit", express.static(join(import.meta.dirname, "node_modules", "@xterm", "addon-fit", "lib")));

// Accept a raw image body (the client POSTs the pasted/dropped blob with its Content-Type).
// Reject non-image types up front; cap the size so a bad request cannot fill the disk.
app.post("/upload", requireKey, express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), (req, res) => {
    const contentType = String(req.headers["content-type"] || "")
        .split(";")[0]
        .trim();
    const ext = IMAGE_EXT[contentType];
    if (!ext) {
        res.status(415).json({ error: `unsupported content-type "${contentType}" - images only` });
        return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: "empty body" });
        return;
    }
    ensureUploadDir();
    const filePath = join(UPLOAD_ROOT, `${randomBytes(8).toString("hex")}${ext}`);
    try {
        writeFileSync(filePath, req.body);
    } catch (err) {
        res.status(500).json({ error: `write failed: ${err instanceof Error ? err.message : String(err)}` });
        return;
    }
    // Return the in-container absolute path; the composer injects this so the CLI reads the file.
    res.json({ path: filePath });
});

// --- HTTP + WebSocket server -------------------------------------------------------------------------------------------------------------

const server = createServer(app);

// The key a WebSocket handshake presents, read off the upgrade request's own URL (there is no express
// query parsing here). A malformed URL presents nothing.
function handshakeKey(url) {
    try {
        return new URL(url ?? "", "http://localhost").searchParams.get("k") ?? "";
    } catch {
        return "";
    }
}

// verifyClient runs during the WS handshake: no key, no relay. The Origin check stays as the second gate -
// it stops a remote page from scripting a socket even in a world where it somehow learned a key.
const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: ({ origin, req }, done) => {
        if (!isAuthorized(handshakeKey(req.url))) {
            console.warn("[webterm] rejected WS handshake: no valid key");
            done(false, 403, "Forbidden");
            return;
        }
        if (isAllowedOrigin(origin)) {
            done(true);
            return;
        }
        console.warn(`[webterm] rejected WS handshake from origin: ${origin ?? "(none)"}`);
        done(false, 403, "Forbidden origin");
    },
});

// Every connected browser window. Sessions outlive these sockets, so this set answers only one
// question: who has to be told when something changes.
const clients = new Set();

function send(client, frame) {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(frame));
}

// The session bar, personalised per window: the list is the same for everyone, "which one am I
// driving" is not.
function broadcastSessions() {
    const list = registry.list();
    for (const client of clients) {
        send(client, {
            t: "sessions",
            // What "+ New session" will use, so the picker opens on them and every window agrees, and the
            // whole list of agents, so the menu beside it offers what this server will actually run.
            agent: defaultAgent,
            agents: AGENTS,
            workspace: WORKSPACE,
            max: MAX_SESSIONS,
            defaultCwd: workspaceLabel(defaultCwd),
            list,
            attachedSid: registry.attachedSid(client),
        });
    }
}

// The registry decides what happened; this is the only place that turns it into frames.
function handleEvent(event) {
    if (event.t === "out") {
        send(event.client, { t: "out", sid: event.sid, data: event.data });
    } else if (event.t === "replay") {
        send(event.client, { t: "replay", sid: event.sid, data: event.data });
        // A window that just landed on a session needs its strip as well as its terminal, and this is the one
        // event that means "this window is now looking at this session", reload or reconnect included.
        sendStatus(event.sid, { force: true });
    } else if (event.t === "taken") {
        send(event.client, { t: "taken", sid: event.sid });
    } else if (event.t === "exit") {
        console.log(`[webterm] session "${event.label}" ended on its own (${event.agent} exited)`);
        for (const client of clients) send(client, { t: "exit", sid: event.sid, agent: event.agent });
    } else if (event.t === "changed") {
        broadcastSessions();
    }
}

const registry = createRegistry({
    spawn: spawnAgent,
    maxSessions: MAX_SESSIONS,
    maxBuffer: MAX_OUTPUT_BUFFER,
    onEvent: handleEvent,
});

// --- The status strip --------------------------------------------------------------------------------------------------------------------
//
// A claude session's own numbers, above the composer: the model, the context it is holding, what is left of
// the quota, the version it runs. They come from the snapshot its status line writes (see snapshot.js), which
// is a file, so this side is a poll and a comparison - look at what the session's snapshot says now, and send
// a frame only when it says something different from the last one this window was told.

// sid -> the payload last sent for it, serialised. Only so an unchanged snapshot costs nothing: the script
// rewrites the file on every prompt render, and most rewrites move nothing the strip shows.
const lastStatus = new Map();

/**
 * Push this session's status to the window watching it, when it has moved.
 *
 * Nothing is sent for an agent that writes no snapshots - there is no strip for a codex tab, and an empty
 * frame would only tell the window to draw one and find nothing. `force` is for the two moments a window
 * needs the current state whatever the server last sent: it just landed on the session, or it asked.
 */
function sendStatus(sid, { force = false } = {}) {
    const session = registry.get(sid);
    const pid = Number(session?.term?.pid);
    if (!session?.client || !writesSnapshots(session.agent) || !Number.isInteger(pid)) return;
    const status = statusFor({ pid }, AGENT_STORES.claudeSnapshots);
    const serialised = JSON.stringify(status);
    if (!force && lastStatus.get(sid) === serialised) return;
    lastStatus.set(sid, serialised);
    send(session.client, { t: "snapshot", sid, status });
}

// One pass over the sessions: whoever is watching one hears about it when its snapshot moved. Sessions that
// are gone drop out of the map here, which is the only cleanup it needs.
function sweepStatus() {
    const live = new Set();
    for (const entry of registry.list()) {
        live.add(entry.id);
        sendStatus(entry.id);
    }
    for (const sid of lastStatus.keys()) {
        if (!live.has(sid)) lastStatus.delete(sid);
    }
}

// What the host asks before it offers to stop the container. `sessions` is how many conversations are
// alive (they all die with the container), `attached` how many a window is watching right now, `agent` the
// one a new session gets and `agents` what is actually running, per agent. Counts and names only - nothing
// about the conversations themselves.
// A window whose socket dropped asks it too: an answer means the relay is fine, a 403 means this window's
// key is no longer the live one, and no answer at all means the container is gone. Three different things
// to tell the user, and this is what tells them apart.
app.get("/status", requireKey, (_req, res) => {
    const agents = {};
    for (const entry of registry.list()) agents[entry.agent] = (agents[entry.agent] ?? 0) + 1;
    res.json({ agent: defaultAgent, agents, sessions: registry.count(), attached: registry.attachedCount() });
});

// What the picker fills its suggestions from. Scanned per request rather than cached: the picker is opened
// now and then, and a list built at startup would miss every directory created since.
app.get("/dirs", requireKey, (_req, res) => {
    const { dirs, truncated } = scanDirs();
    res.json({ default: workspaceLabel(defaultCwd), dirs, truncated });
});

// The host moves the default here, on every session start that finds this interface already running. The
// interface is started once per container start with the directory totopo ran in, so without this the
// default would age: run totopo somewhere else tomorrow and the browser would still open new sessions in
// yesterday's directory, while the terminal session opened in the new one.
app.post("/cwd", requireKey, express.json({ limit: 4096 }), (req, res) => {
    // A body without a path is refused rather than read as the workspace root: this route moves where every
    // later session starts, so it acts only on a directory that was actually named.
    const raw = req.body?.cwd;
    const wanted = typeof raw === "string" ? resolveWorkspacePath(raw) : null;
    if (wanted === null) {
        res.status(400).json({ error: "not a directory inside the workspace" });
        return;
    }
    if (wanted !== defaultCwd) {
        defaultCwd = wanted;
        console.log(`[webterm] new sessions now start in ${defaultCwd}`);
        // Every open window shows the default in its picker, so they all have to hear it.
        broadcastSessions();
    }
    res.json({ default: workspaceLabel(defaultCwd) });
});

// `webterm <agent>` in the container, with the interface already running. It moves what "+ New session"
// starts and nothing else: live sessions keep the agent they were started with, because the agent is the
// process. This is what replaced killing the server to change agents, which took every open session with it.
app.post("/agent", requireKey, express.json({ limit: 4096 }), (req, res) => {
    const wanted = sessionAgent(req.body?.agent);
    if (wanted === null || req.body?.agent === undefined) {
        res.status(400).json({ error: `not an agent this server runs (${AGENTS.join(", ")})` });
        return;
    }
    if (wanted !== defaultAgent) {
        defaultAgent = wanted;
        console.log(`[webterm] new sessions now start ${defaultAgent}`);
        publishAgent();
        // Every open window shows the default on its "+ New session", so they all have to hear it.
        broadcastSessions();
    }
    res.json({ default: defaultAgent });
});

// The argv that reopens this session's last conversation, or null. Three things have to hold, and each is a
// different question: auto-resume is on at all (it is part of the host's auto-start setting), this session
// runs the agent the interface was started with (DEFAULT_AGENT, not wherever the default has moved to since -
// any other agent would spend the chance on a conversation it cannot open), and this container start has not
// had its resume yet. Only then is the store read, in resume.js, which is the only side that knows its shape.
function resumeArgv(agent, cwd) {
    if (!AUTO_RESUME || agent !== DEFAULT_AGENT) return null;
    if (!claimResumeChance(RESUME_STAMP)) return null;
    return resumeArgvFor(agent, cwd, AGENT_STORES);
}

// Spawn a new session's agent, in the directory the registry was given. Env is inherited so subscription
// auth flows through. The first session after a container start reopens the most recent conversation; every
// later session starts fresh, which is what the user wants once mid-work.
// AGENT_ARGS belong to the agent the launcher named, so any other agent is spawned bare.
function spawnAgent({ cwd, agent }) {
    const resume = resumeArgv(agent, cwd);
    const [spawnCmd, ...baseArgs] = resume ?? [agent, ...(agent === DEFAULT_AGENT ? AGENT_ARGS : [])];
    if (resume) console.log(`[webterm] resuming most recent conversation: ${resume.join(" ")}`);
    // Append the browser-awareness flag for claude (fresh or resumed); every other agent is untouched.
    const spawnArgs = agentSpawnArgv(spawnCmd, baseArgs);
    return pty.spawn(spawnCmd, spawnArgs, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        // TOTOPO_WEB_SESSION is this session saying what it is, rather than something downstream sniffing a
        // WEBTERM_* variable that happens to be around. claude's status line reads it and stops after writing
        // its snapshot, because the strip above the composer draws the same data outside the terminal. A shell
        // opened inside this terminal inherits it, which is right - it is still a browser session - and a
        // `docker exec` terminal session never has it.
        env: { ...process.env, TOTOPO_WEB_SESSION: "1" },
    });
}

// --- Frames from a window ----------------------------------------------------------------------------------------------------------------

// Put a window on a session. It gets it unless another window is really driving it, in which case the
// browser asks the user whether to take it over - the PTY has one size, so two drivers fight.
function openSession(ws, sid) {
    const result = registry.attach(sid, ws);
    if (result === "busy") send(ws, { t: "busy", sid });
    else if (result === "gone") broadcastSessions();
}

// Start a session and attach this window to it. `rawCwd` and `rawAgent` are what the browser asked for, if
// anything: the plain "+ New session" sends neither and takes both defaults, the picker sends a path
// relative to the workspace and the menu sends an agent. Either one naming something we cannot run is
// refused rather than quietly swapped for the default - starting the wrong agent, or one somewhere the user
// did not ask for, is worse than saying no.
function newSession(ws, rawCwd, rawAgent) {
    const cwd = sessionCwd(rawCwd);
    if (cwd === null) {
        console.warn(`[webterm] refused a new session: "${rawCwd}" is not a directory inside the workspace`);
        send(ws, { t: "error", code: "cwd" });
        return;
    }
    const agent = sessionAgent(rawAgent);
    if (agent === null) {
        console.warn(`[webterm] refused a new session: "${rawAgent}" is not an agent this server runs`);
        send(ws, { t: "error", code: "agent" });
        return;
    }
    let created;
    try {
        created = registry.create({ cwd, cwdLabel: workspaceLabel(cwd), agent });
    } catch (err) {
        console.error(`[webterm] could not start ${agent}: ${err instanceof Error ? err.message : String(err)}`);
        send(ws, { t: "error", code: "spawn", agent });
        return;
    }
    if (!created.ok) {
        console.log(`[webterm] refused a new session: already at the limit of ${MAX_SESSIONS}`);
        send(ws, { t: "error", code: created.error });
        return;
    }
    console.log(`[webterm] started session "${created.session.label}" (${registry.count()}/${MAX_SESSIONS})`);
    openSession(ws, created.session.id);
}

// A window connected. Mission control always opens on something: an empty container gets one session
// (that first session is what consumes the resume marker), otherwise the window lands on the session it
// was last looking at, or the oldest one nobody is watching.
//
// Auto-create is for a page that was just opened, which is why the window says whether this is its first
// socket. A reconnect is the same page coming back from a blip or a slept laptop, and it must land on
// exactly what it left: closing the last session on purpose leaves an empty bar, and waking up hours
// later should still show that empty bar rather than a fresh agent process nobody asked for.
function greet(ws, wantSid, fresh) {
    if (registry.count() === 0) {
        if (fresh) newSession(ws);
        else broadcastSessions(); // Nothing to attach to; the bar still has to render, empty.
        return;
    }
    const sid = registry.pickForClient(ws, wantSid);
    if (sid) openSession(ws, sid);
    else broadcastSessions(); // Every session is driven elsewhere; the bar still has to render.
}

// End the day from the browser: stop the container, and with it every session in it. PID 1 is the
// container's keep-alive, and the container stops when it exits - but the kernel drops a signal sent to
// PID 1 from inside its own namespace unless PID 1 installed a handler for it. totopo starts containers
// with a keep-alive that traps TERM for exactly this; one created before that lands here and ignores the
// signal, which is what the timer reports so the page can point at the host instead of hanging.
function stopContainer() {
    console.log("[webterm] stopping the container (asked for from the browser)");
    // Announced before the signal: the container can go the instant PID 1 does, and a window that heard
    // nothing would show "cannot reach the container" for something the user just asked for.
    for (const client of clients) send(client, { t: "stopping" });
    setTimeout(() => {
        try {
            process.kill(1, "SIGTERM");
        } catch (err) {
            console.error(`[webterm] could not signal PID 1: ${err instanceof Error ? err.message : String(err)}`);
            for (const client of clients) send(client, { t: "error", code: "stop" });
            return;
        }
        setTimeout(() => {
            // Still running, so the signal was dropped rather than acted on.
            console.warn("[webterm] the container did not stop - its keep-alive does not act on TERM from inside");
            for (const client of clients) send(client, { t: "error", code: "stop" });
        }, STOP_TIMEOUT_MS).unref();
    }, STOP_ANNOUNCE_MS).unref();
}

// The composed message, delivered to whichever session this window is driving.
function paste(ws, text) {
    const session = registry.sessionFor(ws);
    if (!session) return;
    const term = session.term;
    // Wrap as one bracketed paste so a multi-line message is not submitted line-by-line.
    registry.typed(session.id);
    term.write(PASTE_START + text + PASTE_END);
    // Send Enter slightly later so it lands after the agent has ingested any pasted image paths,
    // otherwise the submit can be dropped and the message sits un-sent until a second Enter.
    setTimeout(() => {
        // Only submit if that session's PTY is still the live one (it may have exited meanwhile). The
        // lookup is by session, not by window: the Enter belongs to the session that got the paste.
        if (registry.get(session.id)?.term !== term) return;
        try {
            registry.typed(session.id);
            term.write(SUBMIT);
        } catch {
            // PTY went away; nothing to submit.
        }
    }, SUBMIT_DELAY_MS);
}

function resize(ws, cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
    try {
        registry.sessionFor(ws)?.term.resize(cols, rows);
    } catch {
        // A transient bad size (e.g. 0 during layout) must not kill the session.
    }
}

function handleFrame(ws, msg) {
    const sid = typeof msg.sid === "string" ? msg.sid : null;
    switch (msg.t) {
        case "hello":
            greet(ws, sid, msg.fresh === true);
            return;
        case "ping":
            // Liveness probe from a window that just woke up: an answer proves the socket really works,
            // so it can reconnect at once instead of waiting for TCP to give up.
            send(ws, { t: "pong" });
            return;
        case "attach":
            if (sid) openSession(ws, sid);
            return;
        case "seen":
            // The user did something in this window - a click, a scroll, a key. It changes nothing about who
            // drives what, only whether the next ending of the session it is driving is worth a sound. Typing
            // arrives as "in" and is stamped there, so this covers everything that is not a keystroke.
            registry.seen(registry.attachedSid(ws));
            return;
        case "takeover":
            if (sid) registry.takeover(sid, ws);
            return;
        case "new":
            // No cwd or agent on the frame means the defaults; the picker and the agent menu send theirs.
            newSession(ws, msg.cwd, msg.agent);
            return;
        case "stop":
            // Never implicit: the browser only sends this after the user confirmed a card that names
            // everything it ends.
            stopContainer();
            return;
        case "close": {
            // Read the display name first: closing removes the session, and this is what the log names it by.
            const target = sid ? registry.get(sid) : null;
            const shown = target ? target.name || target.label : null;
            if (sid && registry.close(sid)) console.log(`[webterm] closed session "${shown}" (asked for)`);
            return;
        }
        case "rename": {
            if (sid && typeof msg.name === "string" && registry.rename(sid, msg.name)) {
                const session = registry.get(sid);
                if (session?.name) console.log(`[webterm] renamed session "${session.label}" to "${session.name}"`);
                else console.log(`[webterm] cleared the name on session "${session?.label ?? sid}"`);
            }
            return;
        }
        case "reorder":
            // Not logged: unlike a rename, where the session goes in the bar says nothing a later log line
            // needs. The registry broadcasts the new bar to every window.
            if (sid) registry.reorder(sid, msg.index);
            return;
        case "in": {
            if (typeof msg.data !== "string") return;
            const session = registry.sessionFor(ws);
            if (!session) return;
            // Stamped as the user's own typing first, so the echo that comes straight back is not read as
            // the agent working.
            registry.typed(session.id);
            session.term.write(msg.data);
            return;
        }
        case "snapshot": {
            // The strip asking for its session's numbers again, after a reconnect. It gets the session this
            // window is driving and never one the frame names.
            const attached = registry.attachedSid(ws);
            if (attached) sendStatus(attached, { force: true });
            return;
        }
        case "paste":
            if (typeof msg.data === "string") paste(ws, msg.data);
            return;
        case "resize":
            resize(ws, msg.cols, msg.rows);
            return;
        default:
            return; // Unknown frame: ignore.
    }
}

// One socket per browser window carries everything - the session list, the attached session's output,
// and every command - so switching sessions is a frame, not a reconnect.
wss.on("connection", (ws) => {
    clients.add(ws);
    // Answering the keepalive ping is what keeps this socket (and its attachment) alive.
    ws.isAlive = true;
    ws.on("pong", () => {
        ws.isAlive = true;
    });

    ws.on("message", (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return; // Ignore malformed frames.
        }
        handleFrame(ws, msg);
    });

    // The window is gone - closed, slept, network dropped, all the same from here. Its session keeps
    // running and keeps buffering; only the attachment is released.
    ws.on("close", () => {
        clients.delete(ws);
        registry.detach(ws);
    });
});

// --- Startup -----------------------------------------------------------------------------------------------------------------------------

ensureUploadDir();
checkUploads();
setInterval(checkUploads, CHECK_INTERVAL_MS).unref();

// Whether each agent is working is a question about time - how long since its last byte - so something has
// to ask it. The registry does the deciding; this only sets the pace, and only broadcasts when an answer
// actually changed.
setInterval(() => registry.tick(), WORK_TICK_MS).unref();

// The strip's sweep, for a related reason: a snapshot file is written by a shell script into a mounted
// directory, so the only way to know it moved is to look.
setInterval(() => sweepStatus(), STATUS_SCAN_MS).unref();

// Keepalive sweep. A window that stops answering is terminated, which releases the session it was
// driving so the window that comes back can pick it up without a takeover prompt. Sessions themselves
// are never touched here - a dead socket says nothing about whether a conversation is worth keeping.
setInterval(() => {
    for (const client of clients) {
        if (!client.isAlive) {
            client.terminate();
            continue;
        }
        client.isAlive = false;
        client.ping();
    }
}, CLIENT_PING_INTERVAL_MS).unref();

// Nothing here works without the port, so a bind failure ends the process - but with a line saying which
// port and why, rather than a stack trace in the log. The ordinary cause is two launchers racing: the one
// that loses lands here, and the interface the winner started is already serving.
// Both objects, because ws re-emits the HTTP server's error on the WebSocket server: whichever of the two
// is left without a listener is the one that crashes.
const onServerError = (err) => {
    console.error(`[webterm] could not listen on container port ${PORT}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
};
server.on("error", onServerError);
wss.on("error", onServerError);

server.listen(PORT, "0.0.0.0", () => {
    // First thing after the bind: the key is what makes the URL printable, and the launcher is already
    // watching the port to know when to print it.
    publishKey();
    console.log(`[webterm] listening on container port ${PORT} - open the published host port in your browser`);
    console.log(`[webterm] agents: ${AGENTS.join(", ")} (new sessions start ${[defaultAgent, ...AGENT_ARGS].join(" ")} in ${defaultCwd})`);
    if (defaultCwdRefused) {
        console.warn(`[webterm] ignored WEBTERM_CWD="${WEBTERM_CWD_RAW}": not a directory inside ${WORKSPACE_ROOT}`);
    }
    // Publish the default agent for the `webterm` launcher: a port probe proves something is listening, not
    // what it runs. Written after listen so the file only exists once the port is really bound.
    publishAgent();
});
