// sessions.js - The session registry: what a session is, who drives it, and what ends it.
//
// A session is one live agent process (one PTY) that outlives every browser connection. Nothing here
// closes a session because a socket went away: a closed browser, a dropped wifi and a slept laptop are
// indistinguishable from the server, and killing a conversation on any of them is what made the
// interface lossy. A session ends only when the user ends it or the agent exits on its own; the rest
// die with the container.
//
// The PTY is injected (`spawn`) so this file needs no node-pty and can be unit-tested, and all socket
// I/O belongs to the caller: the registry only reports what happened through `onEvent`.

import { randomBytes } from "node:crypto";

// How many distinct colours the browser cycles through when labelling sessions. The palette itself is
// presentation and lives in the client; the registry only hands out the index, so every window that
// renders the same session agrees on its colour.
export const PALETTE_SIZE = 6;

// Longest a user-chosen session name may be. The bar is one row, so a name that ran on would push the
// tabs around; past this it is cut. Sanitising lives here so every window agrees on the stored name.
export const MAX_NAME_LENGTH = 40;

// Turn a raw name from the client into what gets stored: control characters (newlines, tabs, the lot)
// stripped so a name is always one clean line, trimmed, and cut to the cap. An empty result means
// "no name" - the session falls back to its default label. Filtering by code point rather than a regex
// keeps the source free of literal control characters.
export function cleanName(raw) {
    if (typeof raw !== "string") return null;
    let kept = "";
    for (const ch of raw) {
        const code = ch.codePointAt(0);
        // Drop C0 control characters (below space) and DEL; keep everything printable, emoji included.
        if (code >= 0x20 && code !== 0x7f) kept += ch;
    }
    const cleaned = kept.trim().slice(0, MAX_NAME_LENGTH).trim();
    return cleaned || null;
}

// WebSocket.OPEN. The registry has to tell a live socket from a dead one to know whether taking a
// session over needs to ask first; 1 is the protocol-level constant, not a ws-library detail.
const SOCKET_OPEN = 1;

function isOpen(socket) {
    return Boolean(socket) && socket.readyState === SOCKET_OPEN;
}

/**
 * Create the session registry.
 *
 * - `spawn()` returns a PTY-like object: { onData, onExit, write, resize, kill }.
 * - `maxSessions` caps how many agents may be alive at once. This is about memory, not correctness.
 * - `agent` is the relayed agent's name; sessions are labelled "<agent> <n>".
 * - `maxBuffer` caps the replay buffer kept per session (bytes).
 * - `onEvent(event)` is called with { t: "replay" | "out" | "taken" | "exit" | "changed", ... }.
 *   Events that target one window carry that window's socket as `client`; "changed" means the session
 *   list moved and every window needs to hear about it.
 */
export function createRegistry({ spawn, maxSessions, agent, maxBuffer, onEvent }) {
    // Insertion-ordered, so iteration is always oldest session first.
    const sessions = new Map();
    // Monotonic: numbers are never reused, so "claude 7" means the same session in every window for as
    // long as it lives, and its colour (derived from the same counter) is predictable.
    let seq = 0;

    function emit(event) {
        onEvent?.(event);
    }

    // --- Reading the registry ------------------------------------------------------------------------------------------------------------

    function wireEntry(session) {
        return {
            id: session.id,
            label: session.label,
            name: session.name,
            colorIndex: session.colorIndex,
            createdAt: session.createdAt,
            attached: isOpen(session.client),
            unread: session.unread,
        };
    }

    // What the browser needs to draw the session bar. The replay buffer is deliberately not in here.
    function list() {
        return [...sessions.values()].map(wireEntry);
    }

    function count() {
        return sessions.size;
    }

    // Sessions a window is actually watching right now. This is what the host asks about before it
    // offers to stop the container.
    function attachedCount() {
        let total = 0;
        for (const session of sessions.values()) {
            if (isOpen(session.client)) total += 1;
        }
        return total;
    }

    function get(sid) {
        return sessions.get(sid);
    }

    // The session a given window is driving, if any. One window drives at most one session.
    function sessionFor(client) {
        for (const session of sessions.values()) {
            if (session.client === client) return session;
        }
        return undefined;
    }

    function attachedSid(client) {
        return sessionFor(client)?.id ?? null;
    }

    // --- Who may drive a session ---------------------------------------------------------------------------------------------------------

    /**
     * True when this window can take the session without asking. The live socket holding it is the only
     * thing that decides: a dead holder is the sleep case, and a closed one is the reload case, neither of
     * which is someone else's conversation. A window identifier deliberately does not get a say - browsers
     * copy sessionStorage into a duplicated tab, so any id the page can hold is shared by the duplicate,
     * and trusting it would let that duplicate silently take a live session and then fight over the one
     * PTY's size. Erring towards one extra prompt is the safe direction.
     */
    function available(session, client) {
        const holder = session.client;
        return holder === client || !isOpen(holder);
    }

    /**
     * Where a freshly connected window should land: the session it was last looking at when it can have
     * it back, else the oldest one nobody is watching, else nothing - every session is being driven
     * elsewhere, so the user picks from the bar (and takes over deliberately).
     */
    function pickForClient(client, wantSid) {
        const wanted = wantSid ? sessions.get(wantSid) : undefined;
        if (wanted && available(wanted, client)) return wanted.id;
        for (const session of sessions.values()) {
            if (available(session, client)) return session.id;
        }
        return null;
    }

    // --- Attaching and detaching ---------------------------------------------------------------------------------------------------------

    function bind(session, client) {
        // A window drives one session at a time, so joining this one leaves whatever it held before.
        const previous = sessionFor(client);
        if (previous && previous !== session) previous.client = null;
        session.client = client;
        session.unread = false;
        // Replay is emitted before anything else can reach this socket, so the window resets its
        // terminal and repaints the session exactly once - never on top of what was already there.
        emit({ t: "replay", sid: session.id, client, data: session.buffer });
        emit({ t: "changed" });
    }

    /** "attached" | "busy" | "gone". "busy" is the only case the browser has to ask the user about. */
    function attach(sid, client) {
        const session = sessions.get(sid);
        if (!session) return "gone";
        if (!available(session, client)) return "busy";
        bind(session, client);
        return "attached";
    }

    /** Take a session over from the window that holds it. The displaced window is told, and can take it back. */
    function takeover(sid, client) {
        const session = sessions.get(sid);
        if (!session) return "gone";
        const displaced = available(session, client) ? null : session.client;
        bind(session, client);
        if (displaced) emit({ t: "taken", sid: session.id, client: displaced });
        return "attached";
    }

    /**
     * A window went away. This clears the attachment and does nothing else - no timer, no kill.
     * The agent keeps running and keeps buffering, which is what makes a session survive sleep.
     */
    function detach(client) {
        const session = sessionFor(client);
        if (!session) return;
        session.client = null;
        emit({ t: "changed" });
    }

    // --- Lifecycle -----------------------------------------------------------------------------------------------------------------------

    function onData(session, data) {
        session.buffer += data;
        if (session.buffer.length > maxBuffer) {
            session.buffer = session.buffer.slice(session.buffer.length - maxBuffer);
        }
        if (isOpen(session.client)) {
            emit({ t: "out", sid: session.id, client: session.client, data });
            return;
        }
        // Nobody is watching: remember that this session has something new to show and say so once,
        // on the flip rather than on every chunk, so a busy background agent is not a broadcast storm.
        if (!session.unread) {
            session.unread = true;
            emit({ t: "changed" });
        }
    }

    // The agent exited by itself (/exit, a crash). There is nothing left to reattach to, so the session
    // goes away - which is the one close the user did not ask for, and the only one that needs no confirm.
    function onExit(session) {
        // close() removes the session before killing the PTY, so this is reached only by a real exit.
        if (sessions.get(session.id) !== session) return;
        sessions.delete(session.id);
        // The display name (custom, else the default) is what the server names it by in the log.
        emit({ t: "exit", sid: session.id, label: session.name || session.label });
        emit({ t: "changed" });
    }

    /** { ok: true, session } or { ok: false, error: "cap" } when the limit is reached. */
    function create() {
        if (sessions.size >= maxSessions) return { ok: false, error: "cap" };
        seq += 1;
        const session = {
            id: randomBytes(6).toString("hex"),
            seq,
            label: `${agent} ${seq}`,
            // A user-chosen label, or null to fall back to `label`. The number in `label` is always kept,
            // so clearing the name shows "claude 7" again and the tooltip can still surface it.
            name: null,
            colorIndex: (seq - 1) % PALETTE_SIZE,
            createdAt: Date.now(),
            term: null,
            buffer: "",
            client: null,
            unread: false,
        };
        session.term = spawn();
        session.term.onData((data) => onData(session, data));
        session.term.onExit(() => onExit(session));
        sessions.set(session.id, session);
        emit({ t: "changed" });
        return { ok: true, session };
    }

    /**
     * Where a window goes when the session it was driving is closed: the next session along the bar, else
     * the one before it, skipping any that another window is watching. `index` is the position the closed
     * session held, so from the caller's point of view this is "the closest tab that is free".
     */
    function neighbourFor(index, client) {
        const remaining = [...sessions.values()];
        // The session at `index` is now the one that was to its right.
        for (let i = index; i < remaining.length; i++) {
            if (available(remaining[i], client)) return remaining[i];
        }
        for (let i = index - 1; i >= 0; i--) {
            if (available(remaining[i], client)) return remaining[i];
        }
        return null;
    }

    /** End one session on purpose. Returns false when it was already gone. */
    function close(sid) {
        const session = sessions.get(sid);
        if (!session) return false;
        const index = [...sessions.keys()].indexOf(sid);
        // Whoever was driving it is about to be left looking at a dead screen, so remember them.
        const orphan = isOpen(session.client) ? session.client : null;
        // Removed first so the PTY's own exit callback knows this was deliberate and stays quiet.
        sessions.delete(sid);
        try {
            session.term?.kill();
        } catch {
            // Already gone.
        }
        // Move that window to the closest session it can have, the way closing a browser tab lands you on
        // its neighbour. This covers the window that asked for the close and any other window that
        // happened to be watching the same session.
        const next = orphan ? neighbourFor(index, orphan) : null;
        if (next) bind(next, orphan);
        else emit({ t: "changed" });
        return true;
    }

    /**
     * Relabel a session. `rawName` is sanitised here (the one place that decides what a name is); an empty
     * result clears the name, so the session shows its default `label` again. Renaming touches nothing but
     * the label - not who drives it, not the buffer - and every window hears the new bar. False if gone.
     */
    function rename(sid, rawName) {
        const session = sessions.get(sid);
        if (!session) return false;
        session.name = cleanName(rawName);
        emit({ t: "changed" });
        return true;
    }

    return {
        attach,
        attachedCount,
        attachedSid,
        close,
        count,
        create,
        detach,
        get,
        list,
        pickForClient,
        rename,
        sessionFor,
        takeover,
    };
}
