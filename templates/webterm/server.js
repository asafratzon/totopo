// server.js - HTTP + WebSocket relay for interactive AI agent CLI sessions.
//
// The page is mission control for this container: it lists every live session (one PTY each, all
// running AGENT_CMD in the workspace) as tabs, and one of them is attached to the browser window at a
// time. The window renders the live TUI (xterm.js) and forwards keystrokes; a rich composer uploads
// pasted images to /tmp/uploads and injects the composed message as one bracketed paste.
// Sessions belong to the server, not to the socket: see sessions.js for what that buys.
// Auth and sandbox are inherited: the spawned CLI sees the same agent config dirs and the same
// container isolation it has in the terminal. Nothing here touches credentials.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import {
    AGENT_ARGS,
    AGENT_CMD,
    agentSpawnArgv,
    CHECK_INTERVAL_MS,
    CLIENT_PING_INTERVAL_MS,
    CWD,
    isAllowedOrigin,
    MAX_OUTPUT_BUFFER,
    MAX_SESSIONS,
    MAX_UPLOAD_BYTES,
    PASTE_END,
    PASTE_START,
    PORT,
    RESUME_MARKER,
    STATE_FILE,
    SUBMIT,
    SUBMIT_DELAY_MS,
    UPLOAD_DIR,
    UPLOAD_MAX_AGE_MS,
    WORKSPACE,
} from "./config.js";
import { createRegistry } from "./sessions.js";

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

// Serve the client and xterm's shipped dist files straight from node_modules (no bundler).
app.use(express.static(join(import.meta.dirname, "public")));
app.use("/vendor/xterm", express.static(join(import.meta.dirname, "node_modules", "@xterm", "xterm", "css")));
app.use("/vendor/xterm", express.static(join(import.meta.dirname, "node_modules", "@xterm", "xterm", "lib")));
app.use("/vendor/xterm-fit", express.static(join(import.meta.dirname, "node_modules", "@xterm", "addon-fit", "lib")));

// Accept a raw image body (the client POSTs the pasted/dropped blob with its Content-Type).
// Reject non-image types up front; cap the size so a bad request cannot fill the disk.
app.post("/upload", express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), (req, res) => {
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

// verifyClient runs during the WS handshake: reject any non-loopback Origin before an upgrade.
const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: ({ origin }, done) => {
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
            agent: AGENT_CMD,
            workspace: WORKSPACE,
            max: MAX_SESSIONS,
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
    } else if (event.t === "taken") {
        send(event.client, { t: "taken", sid: event.sid });
    } else if (event.t === "exit") {
        console.log(`[webterm] session "${event.label}" ended on its own (${AGENT_CMD} exited)`);
        for (const client of clients) send(client, { t: "exit", sid: event.sid });
    } else if (event.t === "changed") {
        broadcastSessions();
    }
}

const registry = createRegistry({
    spawn: spawnAgent,
    maxSessions: MAX_SESSIONS,
    agent: AGENT_CMD,
    maxBuffer: MAX_OUTPUT_BUFFER,
    onEvent: handleEvent,
});

// What the host asks before it offers to stop the container. `sessions` is how many conversations are
// alive (they all die with the container), `attached` how many a window is watching right now. Counts
// and the agent name only - nothing about the conversations themselves.
app.get("/status", (_req, res) => {
    res.json({ agent: AGENT_CMD, sessions: registry.count(), attached: registry.attachedCount() });
});

// Consume the host-planted resume marker, if any. The rename is the claim: of all racing consumers
// (this server's sessions, the shell autostart hook) exactly one wins, so only one session resumes.
// Returns the resume command as [cmd, ...args], or null when there is nothing to resume.
function consumeResumeMarker() {
    if (!RESUME_MARKER) return null;
    const claimed = `${RESUME_MARKER}.web`;
    try {
        renameSync(RESUME_MARKER, claimed);
    } catch {
        return null; // No marker, or another consumer claimed it first.
    }
    try {
        const command = readFileSync(claimed, "utf8").trim();
        unlinkSync(claimed);
        const parts = command.split(/\s+/).filter(Boolean);
        return parts.length > 0 ? parts : null;
    } catch {
        return null;
    }
}

// Spawn the agent for a new session. Env is inherited so subscription auth flows through. The first
// session after a container start finds the host-planted marker and continues the most recent
// conversation; every later session starts fresh, which is what the user wants once mid-work.
function spawnAgent() {
    const resume = consumeResumeMarker();
    const [spawnCmd, ...baseArgs] = resume ?? [AGENT_CMD, ...AGENT_ARGS];
    if (resume) console.log(`[webterm] resuming most recent conversation: ${resume.join(" ")}`);
    // Append the browser-awareness flag for claude (fresh or resumed); every other agent is untouched.
    const spawnArgs = agentSpawnArgv(spawnCmd, baseArgs);
    return pty.spawn(spawnCmd, spawnArgs, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: CWD,
        env: process.env,
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

// Start a session and attach this window to it.
function newSession(ws) {
    let created;
    try {
        created = registry.create();
    } catch (err) {
        console.error(`[webterm] could not start ${AGENT_CMD}: ${err instanceof Error ? err.message : String(err)}`);
        send(ws, { t: "error", code: "spawn" });
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
// was last looking at, or the oldest one nobody is watching. Auto-create happens only here, on connect,
// so closing the last session leaves the empty bar visible instead of immediately spawning another.
function greet(ws, wantSid) {
    if (registry.count() === 0) {
        newSession(ws);
        return;
    }
    const sid = registry.pickForClient(ws, wantSid);
    if (sid) openSession(ws, sid);
    else broadcastSessions(); // Every session is driven elsewhere; the bar still has to render.
}

// The composed message, delivered to whichever session this window is driving.
function paste(ws, text) {
    const session = registry.sessionFor(ws);
    if (!session) return;
    const term = session.term;
    // Wrap as one bracketed paste so a multi-line message is not submitted line-by-line.
    term.write(PASTE_START + text + PASTE_END);
    // Send Enter slightly later so it lands after the agent has ingested any pasted image paths,
    // otherwise the submit can be dropped and the message sits un-sent until a second Enter.
    setTimeout(() => {
        // Only submit if that session's PTY is still the live one (it may have exited meanwhile). The
        // lookup is by session, not by window: the Enter belongs to the session that got the paste.
        if (registry.get(session.id)?.term !== term) return;
        try {
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
            greet(ws, sid);
            return;
        case "ping":
            // Liveness probe from a window that just woke up: an answer proves the socket really works,
            // so it can reconnect at once instead of waiting for TCP to give up.
            send(ws, { t: "pong" });
            return;
        case "attach":
            if (sid) openSession(ws, sid);
            return;
        case "takeover":
            if (sid) registry.takeover(sid, ws);
            return;
        case "new":
            newSession(ws);
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
        case "in":
            if (typeof msg.data === "string") registry.sessionFor(ws)?.term.write(msg.data);
            return;
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

server.listen(PORT, "0.0.0.0", () => {
    console.log(`[webterm] listening on container port ${PORT} - open the published host port in your browser`);
    console.log(`[webterm] relaying: ${[AGENT_CMD, ...AGENT_ARGS].join(" ")} (cwd ${CWD})`);
    // Publish the relayed agent for the `webterm` launcher: a port probe proves something is listening,
    // not what it relays. Written after listen so the file only exists once the port is really bound.
    // Best-effort - without it the launcher just reports "already running" without naming the agent.
    if (STATE_FILE) {
        try {
            writeFileSync(STATE_FILE, `${AGENT_CMD}\n`);
        } catch {
            // Not fatal: the state file is a convenience for the launcher's message.
        }
    }
});
