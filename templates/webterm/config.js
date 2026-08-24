// config.js - Single place for the knobs the server reads at startup.
// Values fall back to sane defaults so `node server.js` just works inside the container.
// Nothing here is claude-specific: the relayed agent is whichever one `webterm <agent>` was given.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

// The server always binds this container port. totopo publishes it to a host port
// (127.0.0.1:HOST:3899); the host side may differ per workspace, this side never does.
export const PORT = Number(process.env.WEBTERM_PORT) || 3899;

// The agents this server will run. One server relays all of them - the agent is per session - so this is the
// list a session may be started with, and the same list the `webterm` launcher accepts. Nothing else may be
// spawned: the browser names an agent, and a name that is not in here is refused rather than run.
export const AGENTS = ["claude", "opencode", "codex"];

export function isKnownAgent(name) {
    return typeof name === "string" && AGENTS.includes(name);
}

// The agent a session gets when the browser does not name one, which is the one-click "+ New session". The
// `webterm` launcher sets it from the agent the user named, so the fallback only applies to a bare
// `node server.js`. It moves at runtime (POST /agent), so the server holds its own copy of this.
export const DEFAULT_AGENT = isKnownAgent(process.env.WEBTERM_AGENT) ? process.env.WEBTERM_AGENT : AGENTS[0];

// Extra arguments for the default agent, and only for it: they come from the same launcher run that named it,
// so they mean nothing to any other agent the browser might start.
export const AGENT_ARGS = (process.env.WEBTERM_AGENT_ARGS || "").split(/\s+/).filter(Boolean);

// The devuser home, guarded the way the baked shell scripts guard it: a detached `docker exec` need not
// carry HOME, and every path below is built from this one.
const HOME = process.env.HOME || "/home/devuser";

// Resume stamp: the file that records which container start has already had its resume. The first session
// after a container start reopens the most recent conversation; later sessions start fresh, and this is what
// tells the two apart (see resume.js). It has a default rather than coming from the launcher, because the
// shell auto-start hook reaches the same decision through resume-cli.js without the launcher ever running -
// both doors have to name the same file or each would hand out a resume of its own.
export const RESUME_STAMP = process.env.WEBTERM_RESUME_STAMP || `${HOME}/.totopo-resume-stamp`;

// Whether reopening the last conversation is on at all. Set by the `webterm` launcher from the host's
// auto-start setting: auto-resume is part of auto-start, so a hand-run `webterm claude` with auto-start off
// starts fresh rather than picking up a conversation the user did not ask for. It is also what keeps a
// standalone `node server.js` from resuming anything.
export const AUTO_RESUME = process.env.WEBTERM_AUTO_RESUME === "1";

// Where each agent keeps what it wrote about its own sessions, and where claude's status line leaves the
// snapshot the strip is drawn from. These are container paths and they are read only in the container -
// the layouts belong to CLIs that are installed here and nowhere else, so nothing on the host carries a
// copy of them. Grouped rather than four constants because two features read from the same set.
export const AGENT_STORES = {
    claudeSnapshots: `${HOME}/.claude/context-usage`,
    claudeProjects: `${HOME}/.claude/projects`,
    codexSessions: `${HOME}/.codex/sessions`,
    opencodeSessions: `${HOME}/.local/share/opencode/storage/session`,
};

// How often a session's snapshot file is looked at again for the strip above the composer. A poll because
// the file is written into a mounted directory by a shell script and there is nothing to subscribe to.
// Claude Code rewrites it on every prompt render, so this is really "how quickly the strip catches up",
// and a frame goes out only when something the strip shows actually changed.
export const STATUS_SCAN_MS = Number(process.env.WEBTERM_STATUS_SCAN_MS) || 2_000;

// One-line file naming the agent new sessions get, written once the port is bound and again whenever the
// default moves. The `webterm` launcher reads it so a second run can say what is live instead of just
// "already running": probing the port proves something is listening, never what it runs. Empty disables it.
export const STATE_FILE = process.env.WEBTERM_STATE_FILE || "/tmp/webterm.agent";

// The mounted workspace, and the only tree a session may be started in. Every directory the interface
// deals with is this one or something under it.
export const WORKSPACE_ROOT = "/workspace";

// Where sessions start unless the browser asks for somewhere else. The host sets it to the directory
// `npx totopo` ran in, so a browser session opens where the terminal session would; a hand-run
// `webterm <agent>` passes its own $PWD. Read raw here and checked by the server, which is what turns a
// value from outside the workspace into a log line rather than a silent oddity.
export const WEBTERM_CWD_RAW = process.env.WEBTERM_CWD || "";

/**
 * The absolute directory a raw value names, or null when it names nothing usable. Empty means the
 * workspace root, a relative value is read against it, and an absolute one has to already be inside it.
 * `root` is a parameter so this can be unit-tested against a temp dir.
 *
 * This is a scoping rule, not a security boundary: the container is the boundary, and an agent can cd
 * wherever it likes once it is running. What it buys is a picker that cannot quietly start a session
 * outside the workspace, or in a path that does not exist.
 */
export function resolveWorkspacePath(raw, root = WORKSPACE_ROOT) {
    const wanted = typeof raw === "string" ? raw.trim() : "";
    // resolve() takes both shapes: an absolute value is kept, a relative one is read against the root.
    const full = wanted === "" ? root : resolve(root, wanted);
    if (full !== root && !full.startsWith(root + sep)) return null;
    try {
        if (!statSync(full).isDirectory()) return null;
    } catch {
        return null; // Gone, or not readable.
    }
    return full;
}

/**
 * How a directory travels to the browser: relative to the workspace root, with "" for the root itself.
 * The one place that decides it, so the wire never carries an absolute container path and the client
 * never has to know where the workspace is mounted.
 */
export function workspaceLabel(absolute, root = WORKSPACE_ROOT) {
    return relative(root, absolute);
}

// The directory list the picker offers. A workspace can hold tens of thousands of directories, so the
// walk is bounded on every axis: how deep it goes, how many it returns, and what it never descends into.
// Depth 3 covers where work actually happens (apps/*/src, packages/*/lib) without listing a whole tree.
export const DIR_SCAN_DEPTH = 3;
export const DIR_SCAN_MAX = 400;
export const DIR_SCAN_SKIP = new Set(["node_modules"]);

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
// other agent (opencode, codex, a bare shell) is spawned verbatim - which is decided per session, since
// a bar can hold several agents at once. The flag is appended last, so it survives a --resume too. Lives
// here beside CONTEXT_FILE so it imports with no server side effects, which is what lets it be
// unit-tested without starting the server.
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
