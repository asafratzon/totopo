// status-strip.js - the attached session's own numbers, in one line above the composer.
//
// In a terminal this is the Claude Code status line, and in a terminal it stays: totopo's web interface is one
// way into a container and not the only one. In a browser session the script that would draw it writes its
// snapshot and stops (it is told which kind of session it is through TOTOPO_WEB_SESSION), and the server turns
// that file into a frame instead. The reason is that a status line is redrawn inside the conversation, which in
// a browser means it scrolls away with the output and takes a slice of the terminal every prompt; here it sits
// still, outside the terminal, where it belongs.
//
// The strip is the attached session's: switching tabs switches the numbers, and a session with no snapshot has
// no strip at all. Only claude writes snapshots, so a codex tab is a terminal and a composer and nothing else -
// the server never sends a frame for one, which is what keeps the strip from flickering into existence empty.

import { sendFrame } from "./connection.js";
import { strip } from "./dom.js";
import { attachedSid } from "./state.js";

// The countdown to the quota recharge goes stale sitting still, and nothing else here does. A redraw is a
// handful of spans, so the whole strip is rebuilt rather than the one number patched.
const TICK_MS = 30_000;

// Where the bars change colour. The quota is an energy meter, so it warns as it drains; the context is a
// filling one, so it warns as it fills. Both say the same thing in the end - it is time to do something.
const QUOTA_WARN_AT = 50;
const QUOTA_LOW_AT = 20;
const CONTEXT_WARN_AT = 70;
const CONTEXT_FULL_AT = 90;

// sid -> the session's status, or null when it has none yet. Kept per session so switching tabs is a redraw
// rather than a round trip.
const statuses = new Map();

// Sessions this window has already asked about. The server pushes a session's status when the window lands on
// it, so asking is only for the frame that did not arrive - and a session that will never have one (any agent
// but claude) must not be asked again every time the bar redraws.
const asked = new Set();

/** The snapshot frame for a session: everything the strip draws, already normalised by the server. */
export function applySnapshot(msg) {
    if (typeof msg.sid !== "string") return;
    statuses.set(msg.sid, msg.status ?? null);
    if (msg.sid === attachedSid) render();
}

/** Sessions that are gone take their numbers with them. */
export function pruneStatuses(live) {
    for (const sid of [...statuses.keys()]) {
        if (!live.has(sid)) statuses.delete(sid);
    }
    for (const sid of [...asked]) {
        if (!live.has(sid)) asked.delete(sid);
    }
}

/** Draw the strip for whatever session this window is now on, asking for its numbers when it has none. */
export function refreshStrip() {
    if (attachedSid !== null && !statuses.has(attachedSid) && !asked.has(attachedSid)) {
        asked.add(attachedSid);
        sendFrame({ t: "snapshot" });
    }
    render();
}

// --- Saying a number ---------------------------------------------------------------------------------------------------------------------

/** 45.0k, 174k, 1M - a token count at a glance, never to the token. */
function short(value) {
    if (value >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
    if (value >= 100_000) return `${Math.round(value / 1000)}k`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return String(Math.round(value));
}

function trimZero(value) {
    const text = value.toFixed(1);
    return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/** How long until a moment: "2h 15m", "15m", or "now" once it has passed. */
function until(epochSeconds) {
    const seconds = Math.round(epochSeconds - Date.now() / 1000);
    if (seconds <= 0) return "now";
    if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

// --- Drawing -----------------------------------------------------------------------------------------------------------------------------

// The icons and the separator, written as escapes so this file stays plain ASCII: an emoji that arrives as a
// mojibake through some editor or pipe is a bug nobody sees until it is on screen.
const ROBOT = "\u{1F916}";
const BRAIN = "\u{1F9E0}";
const BOLT = "\u26A1";
const PLUG = "\u{1F50C}";
const DOT = "\u00B7";

function span(className, textContent) {
    const el = document.createElement("span");
    if (className) el.className = className;
    if (textContent !== undefined) el.textContent = textContent;
    return el;
}

/** One segment of the strip. Everything in it is text this interface wrote, so nothing here parses markup. */
function segment(...parts) {
    const seg = span("seg");
    seg.append(...parts);
    return seg;
}

/** A meter, filled to a percentage of itself. `tone` is what the fill says about that number. */
function bar(percent, tone) {
    const el = span(tone ? `bar ${tone}` : "bar");
    const fill = span("fill");
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    el.append(fill);
    return el;
}

function modelSegment(status) {
    if (status.model === null) return null;
    const parts = [span("icon", ROBOT), span("name", status.model)];
    if (status.effort !== null) parts.push(span("dim", status.effort));
    return segment(...parts);
}

// Tokens held, against the window they are held in. The window half is dropped when Claude Code did not say
// how big it is, and the bar with it - a bar with no scale is decoration.
function contextSegment(status) {
    if (status.tokens === null) return null;
    const parts = [span("icon", BRAIN), span("name", short(status.tokens))];
    if (status.windowSize !== null && status.windowSize > 0) parts.push(span("dim", `/ ${short(status.windowSize)}`));
    if (status.contextPct !== null) {
        const tone = status.contextPct >= CONTEXT_FULL_AT ? "low" : status.contextPct >= CONTEXT_WARN_AT ? "warn" : "";
        parts.push(bar(status.contextPct, tone), span("dim", `${Math.round(status.contextPct)}%`));
    }
    return segment(...parts);
}

// What is left of the five-hour window, and when it comes back. Absent on a free account and before the first
// answer of a session, which is why the whole segment goes rather than showing a full meter that is a guess.
function quotaSegment(status) {
    if (status.quotaPct === null) return null;
    const tone = status.quotaPct <= QUOTA_LOW_AT ? "low" : status.quotaPct <= QUOTA_WARN_AT ? "warn" : "";
    const parts = [span("icon", BOLT), bar(status.quotaPct, tone), span("name", `${Math.round(status.quotaPct)}%`)];
    if (status.quotaResetsAt !== null) parts.push(span("dim", `(${PLUG} ${until(status.quotaResetsAt)})`));
    return segment(...parts);
}

function versionSegment(status) {
    return status.version === null ? null : segment(span("dim", `Claude Code v${status.version}`));
}

function render() {
    const status = attachedSid === null ? null : (statuses.get(attachedSid) ?? null);
    const segments = status === null ? [] : [modelSegment(status), contextSegment(status), quotaSegment(status), versionSegment(status)];
    const shown = segments.filter((seg) => seg !== null);
    // A snapshot every field of which was missing says nothing, and an empty bar above the composer is worse
    // than no bar: it looks like something failed to load.
    strip.hidden = shown.length === 0;
    const line = [];
    for (const seg of shown) {
        if (line.length > 0) line.push(span("sep", DOT));
        line.push(seg);
    }
    strip.replaceChildren(...line);
}

setInterval(() => {
    if (!strip.hidden) render();
}, TICK_MS);
