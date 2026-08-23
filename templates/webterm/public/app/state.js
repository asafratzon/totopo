// state.js - what the server last told this window, and the key the window was opened with.
//
// Everything the session bar draws comes from the server, so every window agrees on it. It lives here because
// most of the page reads it and only the frame router writes it: the readers import it as a live binding, so
// there is one copy of the truth, and the writing is in one place rather than wherever a frame arrived.

// Everything the session bar draws comes from the server, so every window agrees on it.
export let sessions = [];
export let attachedSid = null;
export let maxSessions = 8;
// Which agent "+ New session" starts, and every agent this container will run. A session's own agent is on
// its entry - several can be live at once - so these two are only about starting the next one.
export let defaultAgent = "the agent";
export let agents = [];
export let workspaceName = "";
// Where "+ New session" starts an agent, relative to the workspace root ("" is the root itself). The server
// owns it - it follows the directory totopo was last run in - and the picker opens on it.
export let defaultCwd = "";

// A whole `sessions` frame, taken in one go. The frame router calls this and then redraws everything that
// reads it; nothing else writes any of it.
export function adoptSessionsFrame(msg) {
    sessions = Array.isArray(msg.list) ? msg.list : [];
    attachedSid = msg.attachedSid ?? null;
    maxSessions = msg.max ?? maxSessions;
    defaultAgent = msg.agent || defaultAgent;
    if (Array.isArray(msg.agents)) agents = msg.agents;
    workspaceName = msg.workspace || "";
    defaultCwd = msg.defaultCwd ?? "";
}

// Which session this window is driving, or null for none. Moved by the frames that move it: a replay lands on
// one, a takeover or an exit leaves the window on nothing at all.
export function setAttachedSid(sid) {
    attachedSid = sid;
}

// The label a session tab is showing, for a sentence about a session that may already be gone.
export function labelOf(sid, fallback) {
    return sessions.find((entry) => entry.id === sid)?.label ?? fallback;
}

// The key that came with the URL. The server mints a new one every time it starts and refuses everything
// without it, so this is also what goes stale: a window left open across a restart still holds the old key,
// which is the case the curtain explains rather than reconnecting forever.
const WEB_KEY = new URLSearchParams(location.search).get("k") ?? "";
export const KEY_QUERY = `?k=${encodeURIComponent(WEB_KEY)}`;
