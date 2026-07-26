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
export const PALETTE_SIZE = 5;

// --- Is the agent working? ---------------------------------------------------------------------------------------------------------------
//
// Nothing tells us directly: a PTY carries bytes, not "thinking" and "waiting". What it does carry is a
// rhythm. An agent at work redraws constantly (a spinner, a tool line, streamed text); an agent waiting for
// you writes nothing at all. So a stretch of output means working, and going quiet for WORK_QUIET_MS means it
// stopped. This stays agent-agnostic on purpose - no output is parsed, so nothing here breaks when a CLI
// changes its spinner, and a plain shell behaves sensibly too.
//
// A stretch, though, not a byte. An idle TUI is not perfectly silent: a session left alone still emits the
// odd small redraw, and reading one of those as "working" is what makes a tab flicker at a user who is
// waiting for their turn to type. So a stretch has to keep streaming for WORK_WARMUP_MS before it counts,
// which no lone redraw ever does.
//
// The other thing that is not the agent is the user. What you type comes straight back as echo, and a TUI
// answers each keystroke by redrawing its whole input box - plenty of output, none of it work. Output within
// ECHO_MS of a keystroke on that session is therefore left out of the rhythm entirely.
//
// One threshold decides both halves of this. A stretch that outlasted the warm-up and then stopped is what
// raises the "it finished" alert, with nothing extra asked of it. An earlier version wanted a longer stretch
// before a tab could light up, on the theory that short work is not worth interrupting anyone for - but that
// can only ever withhold the ending of a signal already on screen, since anything long enough to alert has
// been showing as working since the warm-up. Work between the two lengths turned the tab on and then off
// again with nothing to close it. Whatever is worth showing as work is worth reporting the end of.
//
// The length of the stretch, that is. How long the quiet has to last is a separate question, and the two
// states answer it differently. The tab light is a live reading and can be wrong for a moment - it goes out
// the instant the output does, and comes back when it comes back. "It finished and is waiting for you" is a
// claim about the turn being over, so it needs more than a gap: an agent pauses mid-turn (a slow first token,
// a tool that prints nothing while it runs) and carries straight on. So going quiet only starts a countdown,
// and the alert is raised at the end of it, if the session is still quiet and did not go back to work. Work
// that resumes takes the countdown with it and is never reported as finished at all. The cost is that a real
// ending is announced a few seconds late, which nobody is there to notice: the alert is for a window that is
// not in front of the user.

/** No output for this long means the agent stopped working. */
export const WORK_QUIET_MS = 1_500;

/** How long output has to keep coming before the session is shown as working. */
export const WORK_WARMUP_MS = 1_200;

/** How long a session has to stay stopped before the stop counts as the end of the turn. */
export const ALERT_SETTLE_MS = 4_000;

/** Output this soon after the user typed is the echo of their own keystroke, not the agent. */
export const ECHO_MS = 500;

/** How often tick() should be called. Fine enough that the thresholds above land where they say. */
export const WORK_TICK_MS = 300;

// What an unnamed session is called, with its number after it. Deliberately not the relayed agent's name: one
// server relays one agent, so "claude" on every tab said nothing that the rest of the page did not, and a bar
// full of it read as noise. Rename a tab and this is what clearing the name falls back to.
export const DEFAULT_LABEL = "Agent";

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
 * - `spawn({ cwd })` returns a PTY-like object: { onData, onExit, write, resize, kill }.
 * - `maxSessions` caps how many agents may be alive at once. This is about memory, not correctness.
 * - `maxBuffer` caps the replay buffer kept per session (bytes).
 * - `onEvent(event)` is called with { t: "replay" | "out" | "taken" | "exit" | "changed", ... }.
 *   Events that target one window carry that window's socket as `client`; "changed" means the session
 *   list moved and every window needs to hear about it.
 */
export function createRegistry({ spawn, maxSessions, maxBuffer, onEvent }) {
    // Insertion-ordered, so iteration is always oldest session first.
    const sessions = new Map();
    // Windows that have told us they are not in front of the user - behind another browser tab, or another app.
    // Only the "it finished" alert reads this; a window that is not being looked at still drives its session.
    // Weak, so a socket that goes away takes its entry with it and nothing has to remember to clean up.
    const awayClients = new WeakSet();
    // Monotonic: numbers are never reused, so "Agent 7" means the same session in every window for as
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
            // Relative to the workspace root, so "" reads as "the usual place" and the bar shows nothing.
            cwd: session.cwdLabel,
            attached: isOpen(session.client),
            unread: session.unread,
            working: session.working,
            // "It finished something and you were not there to see it" - the one state the bar shouts about.
            attention: session.attention,
        };
    }

    // What the browser needs to draw the session bar. The replay buffer is deliberately not in here.
    function list() {
        return [...sessions.values()].map(wireEntry);
    }

    function count() {
        return sessions.size;
    }

    /**
     * True when someone is actually looking at this session: a live socket that has not said it is away. An open
     * socket is not enough - a window behind another browser tab or another app is driving its session and would
     * see nothing, which is exactly who the alert is for. Anything unknown counts as looking, so a client that
     * never reports (an older page, a non-browser client) behaves the way it did before.
     */
    function watched(session) {
        return isOpen(session.client) && !awayClients.has(session.client);
    }

    /**
     * A window said whether it is in front of the user. Coming back is a visit: whatever it is driving has been
     * seen, so its alert is spent, the same as clicking the tab.
     */
    function away(client, isAway) {
        if (isAway) {
            awayClients.add(client);
            return;
        }
        awayClients.delete(client);
        const session = sessionFor(client);
        if (!session?.attention) return;
        session.attention = false;
        emit({ t: "changed" });
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
        // Visiting the session is what the alert was asking for, so it is spent the moment you arrive.
        session.attention = false;
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
        const now = Date.now();
        // Record the rhythm, but only for output the agent produced of its own accord - the echo of a
        // keystroke is the user's, and counting it would put a tab to work while its owner types into it.
        if (now - session.lastInputAt >= ECHO_MS) {
            // A gap this long ended the previous stretch, so this byte starts a new one.
            if (now - session.lastOutputAt >= WORK_QUIET_MS) session.streamSince = now;
            session.lastOutputAt = now;
        }
        if (isOpen(session.client)) {
            emit({ t: "out", sid: session.id, client: session.client, data });
        } else if (!session.unread) {
            // Nobody is watching: remember that this session has something new to show, once, on the flip
            // and not on every chunk - a chatty background agent would otherwise be a broadcast storm.
            session.unread = true;
            emit({ t: "changed" });
        }
    }

    /**
     * Move every session's working state on by one step, and raise the alert on the ones that just stopped.
     * Called on a timer by the server rather than driven by a timer per session: the state is a function of
     * "how long output has been running", so one sweep answers it for every session, and a registry with no
     * timers of its own stays testable by calling this by hand. Every flip is announced here, so the whole
     * sweep costs at most one broadcast however many sessions moved.
     *
     * The alert is only for sessions nobody is looking at - see watched(). A session in front of the user is
     * already on screen, and lighting up the tab you are looking at would be telling you what you can see.
     */
    function tick() {
        const now = Date.now();
        let changed = false;
        for (const session of sessions.values()) {
            // Length of the current stretch, measured to its last byte rather than to now: the quiet period
            // is how we noticed it ended, not part of the work.
            const streamed = session.lastOutputAt - session.streamSince;
            const working = now - session.lastOutputAt < WORK_QUIET_MS && streamed >= WORK_WARMUP_MS;
            if (working !== session.working) {
                session.working = working;
                // Going quiet is a candidate ending, so it starts the countdown rather than raising the alert.
                // No length test on the work itself: reaching this line at all means the session had been
                // showing as working, so the warm-up has already vouched for the stretch. Starting up again
                // takes the countdown with it, and makes any earlier "it finished" stale.
                session.stoppedAt = working ? 0 : now;
                if (working) session.attention = false;
                changed = true;
            }
            // The stop held: the turn really is over, and this is the moment worth interrupting the user for.
            // Still-quiet is checked again here because a session can be off the light and yet be producing
            // output - a stretch that has not reached the warm-up - and saying "it finished" over the top of
            // output arriving is the mistake this whole countdown is here to avoid. A session someone is
            // looking at spends the countdown on nothing, the same as it always did.
            if (session.stoppedAt && now - session.stoppedAt >= ALERT_SETTLE_MS && now - session.lastOutputAt >= WORK_QUIET_MS) {
                session.stoppedAt = 0;
                if (!watched(session)) {
                    session.attention = true;
                    changed = true;
                }
            }
        }
        if (changed) emit({ t: "changed" });
    }

    /**
     * The user typed into a session. The write to the PTY belongs to the caller; this is only the timestamp
     * that keeps the echo coming back out of the working rhythm. Broadcasts nothing: typing changes no state
     * a bar renders, and a frame per keystroke is exactly what this file avoids everywhere else.
     */
    function typed(sid) {
        const session = sessions.get(sid);
        if (session) session.lastInputAt = Date.now();
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

    /**
     * Start a session in `cwd` (absolute) and show it as `cwdLabel` (relative to the workspace).
     * Both are handed in rather than worked out here: which directories exist and how one is written for
     * the browser belongs to the server, and the registry only carries the two values - the path to the
     * PTY, the label to the bar.
     *
     * { ok: true, session } or { ok: false, error: "cap" } when the limit is reached.
     */
    function create({ cwd, cwdLabel } = {}) {
        if (sessions.size >= maxSessions) return { ok: false, error: "cap" };
        seq += 1;
        const session = {
            id: randomBytes(6).toString("hex"),
            seq,
            label: `${DEFAULT_LABEL} ${seq}`,
            // A user-chosen label, or null to fall back to `label`. The number in `label` is always kept,
            // so clearing the name shows "Agent 7" again and the tooltip can still surface it.
            name: null,
            colorIndex: (seq - 1) % PALETTE_SIZE,
            createdAt: Date.now(),
            // Where the agent runs, and how that reads in the bar ("" for the workspace root).
            cwd,
            cwdLabel: cwdLabel ?? "",
            term: null,
            buffer: "",
            client: null,
            unread: false,
            // The working rhythm: when the last byte arrived, when this stretch of output started, when the
            // user last typed (so the echo can be skipped), whether it is still going, when it stopped (0
            // once that stop has been answered, either by the alert or by work starting again), and whether
            // the end of it is still waiting to be seen.
            lastOutputAt: 0,
            streamSince: 0,
            lastInputAt: 0,
            working: false,
            stoppedAt: 0,
            attention: false,
        };
        session.term = spawn({ cwd });
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

    /**
     * Move a session to a new place in the bar. Order is registry state, not a per-window preference: every
     * window draws the same bar, so a drag has to move it here or the next broadcast would put it back.
     * `index` is the position the session should end up at in the resulting list, and is clamped rather than
     * rejected - a window whose bar moved under it mid-drag should still land somewhere sensible. Only the
     * order changes: not the label, not the colour, not who drives it. False when nothing moved.
     */
    function reorder(sid, index) {
        if (!sessions.has(sid)) return false;
        const order = [...sessions.keys()];
        const from = order.indexOf(sid);
        const wanted = Number.isInteger(index) ? index : from;
        const to = Math.max(0, Math.min(wanted, order.length - 1));
        if (from === to) return false;
        order.splice(from, 1);
        order.splice(to, 0, sid);
        // A Map keeps insertion order and cannot reorder in place, so it is rebuilt in the new order. The
        // session objects are the same ones, so PTYs, buffers and attachments come along untouched.
        const moved = order.map((id) => [id, sessions.get(id)]);
        sessions.clear();
        for (const [id, session] of moved) sessions.set(id, session);
        emit({ t: "changed" });
        return true;
    }

    return {
        attach,
        attachedCount,
        away,
        attachedSid,
        close,
        count,
        create,
        detach,
        get,
        list,
        pickForClient,
        rename,
        reorder,
        sessionFor,
        takeover,
        tick,
        typed,
    };
}
