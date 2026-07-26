// config.js - Single place for the knobs the server reads at startup.
// Values fall back to sane defaults so `node server.js` just works inside the container.
// Nothing here is claude-specific: the relayed agent is whichever one `webterm <agent>` was given.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

// The server always binds this container port. totopo publishes it to a host port
// (127.0.0.1:HOST:3899); the host side may differ per workspace, this side never does.
export const PORT = Number(process.env.WEBTERM_PORT) || 3899;

// The agent command relayed over the PTY, as [cmd, ...args]. The `webterm` launcher always sets
// WEBTERM_AGENT from the agent the user named, so the default only applies to a bare `node server.js`.
export const AGENT_CMD = process.env.WEBTERM_AGENT || "claude";
export const AGENT_ARGS = (process.env.WEBTERM_AGENT_ARGS || "").split(/\s+/).filter(Boolean);

// Resume marker: a host-written file whose content is the full command that resumes the most
// recent conversation. The first session to consume it (rename-then-read, atomic) spawns that
// command instead of AGENT_CMD; later sessions start fresh. Empty means resume is disabled,
// so a standalone `node server.js` behaves exactly as before.
export const RESUME_MARKER = process.env.WEBTERM_RESUME_MARKER || "";

// One-line file naming the agent this server relays, written once the port is bound. The `webterm`
// launcher reads it so a second run can say which agent is live instead of just "already running":
// probing the port proves something is listening, never what it relays. Empty disables the write.
export const STATE_FILE = process.env.WEBTERM_STATE_FILE || "/tmp/webterm.agent";

// Working directory for the spawned CLI - the mounted workspace root.
export const CWD = process.env.WEBTERM_CWD || "/workspace";

// The workspace this container belongs to, shown in the session bar. Several workspaces can have their
// own interface open at once, each on its own port, so the page says which one you are looking at.
// Empty just leaves it out.
export const WORKSPACE = process.env.WEBTERM_WORKSPACE || "";

// A short note appended to claude's system prompt only when it is launched through the web interface,
// so it knows it is reached in a browser rather than a terminal. The whole webterm/ dir is baked into
// the image, so this resolves next to the server. WEBTERM_CONTEXT_FILE overrides it (used by tests).
export const CONTEXT_FILE = process.env.WEBTERM_CONTEXT_FILE || join(import.meta.dirname, "context", "claude.md");

// Build the argv a session's agent is spawned with. claude, and only claude, is told it is reached
// through the web interface: its CLI takes a per-launch system-prompt file, so the browser-awareness
// note rides on the spawn without touching the shared managed CLAUDE.md the terminal also reads. Every
// other agent (opencode, codex, a bare shell) is spawned verbatim. The flag is appended last, so it
// survives a --resume too. Lives here beside CONTEXT_FILE so it imports with no server side effects,
// which is what lets it be unit-tested without starting the server.
export function agentSpawnArgv(cmd, args) {
    if (basename(cmd) === "claude" && CONTEXT_FILE && existsSync(CONTEXT_FILE)) {
        return [...args, "--append-system-prompt-file", CONTEXT_FILE];
    }
    return args;
}

// Where pasted/uploaded images land. Fixed to a container tmp dir on purpose:
// it is never the host, and the weekly cleanup check only ever touches paths under here.
export const UPLOAD_DIR = "/tmp/uploads";

// Reject uploads larger than this (bytes). Images only; big files are almost always a mistake.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Age after which a file in UPLOAD_DIR is removed, and how often the cleanup check runs.
// Weekly cadence, age-based - deliberately not a minute-level timer.
export const UPLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// The key that the URL carries (`/?k=<key>`) and the relay demands. A fresh one is minted every time
// this server starts, so a key never outlives the process that issued it and nothing has to store it:
// whoever prints the URL reads it back from KEY_FILE. WEBTERM_KEY pins it (tests, hand-run debugging).
// There is deliberately no unauthenticated mode - without the gate the relay would drive an agent for
// any process that can reach the port, which loopback publishing alone does not prevent.
export const KEY = process.env.WEBTERM_KEY || randomBytes(16).toString("hex");

// Where the live key is published for the things that print the URL: the `webterm` launcher and the
// container greeting read it, and so does totopo on the host (docker exec cat) before probing /status.
// Written the moment the port is bound, so a server that never got the port leaves no key behind.
export const KEY_FILE = process.env.WEBTERM_KEY_FILE || "/tmp/webterm.key";

// Whether a presented key is the live one. Compared in constant time so a caller cannot learn the key
// one character at a time from how long the answer takes. Lives here, beside KEY and with no server
// side effects, which is what lets it be unit-tested without starting the server.
export function isAuthorized(candidate) {
    if (typeof candidate !== "string") return false;
    // Byte lengths, not string lengths: timingSafeEqual throws on a length mismatch, and a multi-byte
    // character makes those two differ.
    const presented = Buffer.from(candidate);
    const live = Buffer.from(KEY);
    if (presented.length !== live.length) return false;
    return timingSafeEqual(presented, live);
}

// WebSocket Origin gate, checked alongside the key: a page from a non-loopback origin cannot open the
// relay even if it somehow holds a key. We allow any localhost / 127.0.0.1 origin regardless of port,
// because the published host port can differ from the container port (e.g. 3900:3899) so the browser's
// Origin varies per workspace. The publish is loopback-only, so "any local port" is the right
// granularity: it still rejects remote origins like http://evil.com.
export function isAllowedOrigin(origin) {
    if (!origin) return false;
    try {
        const { hostname } = new URL(origin);
        return hostname === "localhost" || hostname === "127.0.0.1";
    } catch {
        return false;
    }
}

// Bracketed-paste framing. Wrapping the composed message in these markers makes the
// TUI treat a multi-line message (text + image paths) as one paste, then Enter submits it once.
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";
export const SUBMIT = "\r";

// Delay between delivering the paste and sending the submit Enter. When a message contains an
// image path, claude ingests the file asynchronously; an immediate Enter can land mid-ingest and
// be dropped (leaving the text un-submitted until a second Enter). A short gap lets the paste settle.
export const SUBMIT_DELAY_MS = Number(process.env.WEBTERM_SUBMIT_DELAY_MS) || 150;

// Stopping the container from the browser. The announce delay is how long the "going down" frame gets to
// reach every window before PID 1 is signalled - the container can die the instant it is, and a window
// that never heard would blame the network. The timeout is how long to wait before deciding the signal
// was ignored (a container started with a keep-alive that traps nothing), so the page can say so.
export const STOP_ANNOUNCE_MS = 150;
export const STOP_TIMEOUT_MS = 3_000;

// Cap on the replayed session buffer (bytes), per session. A session's PTY outlives every socket, so
// on attach we replay up to this much recent output and the window lands back in the live conversation.
// Older output beyond the cap is dropped from the replay (the agent's own history is unaffected).
export const MAX_OUTPUT_BUFFER = 1_000_000;

// How many sessions (live agent processes) may exist at once. Sessions are never closed for the user,
// so this is the backstop on memory: each live agent holds a few hundred MB in the container. Reaching
// it refuses the new session and says why, rather than quietly recycling a conversation.
export const MAX_SESSIONS = Number(process.env.WEBTERM_MAX_SESSIONS) || 8;

// WebSocket keepalive interval. A socket that stops answering pings is terminated, which releases the
// session it was driving. Without this a laptop that slept would hold its session "attached" until TCP
// gave up: the host would see a watcher that is not there, and the window that comes back would be
// told its own session is busy.
export const CLIENT_PING_INTERVAL_MS = Number(process.env.WEBTERM_PING_INTERVAL_MS) || 20_000;
