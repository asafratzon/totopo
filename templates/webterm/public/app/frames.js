// frames.js - what to do with a frame the server sent.
//
// One function per frame kind and nothing else: every frame either moves this window to a session, writes to the
// terminal, redraws the bar, or opens a card. It is the one module that talks to all the others, so nothing else
// has to know what a frame looks like.

import { refreshBrowserTab, scheduleChime } from "./alerts.js";
import { badAgentCard, badDirCard, capCard, stopFailedCard, takenCard, takeoverCard } from "./cards.js";
import { writeReplay } from "./clipboard.js";
import { clearComposer, refreshComposer } from "./composer.js";
import { hideCurtain, LAST_SID_KEY, noteSocketAlive, resumeReconnects, stoppingCurtain } from "./connection.js";
import { stopDictation } from "./dictation.js";
import { captureDraft, dropDraft, dropHistory, persistDrafts, pruneDrafts, pruneHistory, restoreDraft } from "./drafts.js";
import { noteMsg } from "./note.js";
import { adoptSessionsFrame, attachedSid, defaultAgent, sessions, setAttachedSid } from "./state.js";
import { noteArrivals, renderBar } from "./tabs.js";
import { focusTerminal, scheduleRefresh, sendResize, term } from "./terminal.js";

// What the terminal is holding: either a live session's screen (`shownSid`), or a message where a session used
// to be (`shownMessage`). At most one of them is set. They are tracked because a session can end while this
// window is watching it - nothing replays over the dead screen then, and a dead screen looks exactly like a
// live one. The last screen of an agent that exited on its own is kept rather than replaced (it usually says
// why), so it counts as a message already delivered and no later bar update paints over it.
const EXITED_SCREEN = "exited";
let shownSid = null;
let shownMessage = null;

export function onFrame(msg) {
    // Any frame at all proves the socket works, which is what a wake probe is waiting to hear.
    noteSocketAlive();
    if (msg.t === "sessions") {
        applySessions(msg);
    } else if (msg.t === "replay") {
        // A replay for the session this window is already on is a reconnect or a session taken back, not a
        // switch, so the composer is left exactly as it is. A real switch parks the outgoing draft, ends
        // dictation, and loads the incoming session's draft once the screen is up.
        const switching = attachedSid !== msg.sid;
        if (switching) {
            captureDraft(attachedSid);
            persistDrafts();
            stopDictation();
        }
        setAttachedSid(msg.sid);
        sessionStorage.setItem(LAST_SID_KEY, msg.sid);
        shownSid = msg.sid;
        shownMessage = null;
        // Reset first: the buffer is the whole screen, so writing it without a reset would paint it on
        // top of whatever was there (the previous session, or this one before a reconnect).
        term.reset();
        // Through writeReplay, not term.write: a replayed screen still carries the OSC 52 of any copy made
        // in that session, and re-running it would rewrite the clipboard behind the user's back.
        writeReplay(msg.data);
        scheduleRefresh();
        // The click that got here (a tab, or "+ New session") left the terminal blurred.
        focusTerminal();
        // The PTY was last sized for whichever window had it; this one may be a different shape.
        sendResize();
        if (switching) restoreDraft(msg.sid);
        refreshComposer();
    } else if (msg.t === "out") {
        // Output from a session this window has already left; the window that has it is showing it.
        if (msg.sid !== attachedSid) return;
        term.write(msg.data);
        scheduleRefresh();
    } else if (msg.t === "busy") {
        takeoverCard(msg.sid);
    } else if (msg.t === "taken") {
        // The session is alive in the other window and can be taken back, so the draft is parked under it
        // rather than thrown away, and comes back with it.
        captureDraft(attachedSid);
        persistDrafts();
        clearComposer();
        setAttachedSid(null);
        takenCard(msg.sid);
        refreshComposer();
    } else if (msg.t === "exit") {
        if (msg.sid === attachedSid) {
            setAttachedSid(null);
            // The box was holding an unsent message for a conversation that no longer exists.
            clearComposer();
            term.write(`\r\n\x1b[90m[webterm] ${msg.agent || "the agent"} exited, so this session is gone.\x1b[0m\r\n`);
            shownSid = null;
            shownMessage = EXITED_SCREEN;
        }
        dropDraft(msg.sid);
        dropHistory(msg.sid);
        refreshComposer();
    } else if (msg.t === "stopping") {
        // Sent to every window, not just the one that asked: the container is about to take them all.
        stoppingCurtain();
    } else if (msg.t === "error") {
        if (msg.code === "cap") capCard();
        else if (msg.code === "cwd") badDirCard();
        else if (msg.code === "agent") badAgentCard();
        else if (msg.code === "stop") {
            // The container is still here after all, so the page goes back to being usable.
            resumeReconnects();
            hideCurtain();
            stopFailedCard();
        } else noteMsg(`could not start ${msg.agent || "the agent"} - check the webterm log in the container`, true);
    }
}

function applySessions(msg) {
    adoptSessionsFrame(msg);
    // Before the bar draws: its flash reads these timestamps, so an alert plays once instead of on every frame.
    noteArrivals();
    renderBar();
    // Said again where a window that is behind something else can still be heard.
    refreshBrowserTab();
    // And, twenty seconds from now, said out loud - if it is still true and nobody has come back by then.
    scheduleChime();
    // Sessions that are no longer in the bar take their unsent messages and their history with them.
    pruneDrafts();
    pruneHistory();
    refreshComposer();
    // A session can vanish from under this window: closed here, closed from another window, or the agent exited.
    // Where the server had a free session to move this window to, that session's replay has already painted over
    // it. Where it did not - every remaining session is being driven elsewhere - this is the only thing that says
    // the screen in front of the user is dead, and the alternative is a window that looks live and swallows
    // keystrokes. A screen this window is no longer driving but could take back is left alone: that is the
    // takeover case, and its card offers it back.
    if (!attachedSid && shownMessage !== EXITED_SCREEN) {
        const gone = shownSid !== null && !sessions.some((entry) => entry.id === shownSid);
        if (gone || shownSid === null) showMessage(idleMessage());
    }
}

// Why there is nothing to type into, and the way out of it. Neither line names the session that went away: it
// is gone from the bar, and what the user needs is the next step.
function idleMessage() {
    return sessions.length === 0
        ? `No sessions. Use "+ New session" above to start ${defaultAgent}.`
        : "Every session is open in another window - click one above to bring it here.";
}

// Replaces the terminal with that line. Only when it changes, so an ordinary bar update does not clear and
// redraw the screen underneath the user.
function showMessage(line) {
    if (line === shownMessage) return;
    shownSid = null;
    shownMessage = line;
    term.reset();
    term.write(`\r\n  \x1b[90m${line}\x1b[0m\r\n`);
}
