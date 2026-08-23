// connection.js - the one socket everything on this page rides on, and the curtain for when it is not there.
//
// The socket carries the key this window was handed in its URL, the reconnect loop heals a blip on its own, and
// the curtain is the one state that says "this window cannot do anything at all". They live together because
// they are the same subject read from two ends: what the socket is doing, and what the user is told about it.

import { refreshComposer } from "./composer.js";
import { curtain, curtainCard } from "./dom.js";
import { onFrame } from "./frames.js";
import { attachedSid, KEY_QUERY, sessions } from "./state.js";
import { term } from "./terminal.js";

// Whether the socket is up right now, and whether it has ever been up on this page. The second one is what
// tells an opened page from a reconnected one, which the server treats differently.
export let connected = false;
export let everConnected = false;

// --- The curtain -------------------------------------------------------------------------------------------------------------------------
//
// One state for "this window cannot do anything at all", drawn over the whole page - bar, terminal and
// composer alike. It replaces disabling each control on its own, which is what used to leave a dead page
// looking alive: tabs that still hovered, and an X that opened an end-session prompt nothing would answer.
//
// Four reasons a window ends up here, and they are not the same to the user:
//   down     - nothing answers. The container is stopped or gone; keeps reconnecting, so it heals itself.
//   locked   - the relay answered and refused this window's key. The interface restarted and minted a new
//              one, so this URL is spent; reconnecting is pointless and stops.
//   stopping - the user just stopped the container from here. Same end state as "down", but it is not a
//              failure and must not read like one.
//   stopped  - it has gone. The one curtain that replaces another rather than appearing on its own: stopping
//              is a wait, and a wait that never resolves is indistinguishable from a page that hung.
//
// A dropped socket is routine (a sleeping laptop, a wifi blip), so the curtain waits out a short grace and
// usually never appears. What does happen immediately is the page going inert, because a click landing on
// a control whose answer goes nowhere is the actual bug.
const CURTAIN_DELAY_MS = 3_000;

let curtainKind = null;
let curtainTimer = null;
// Set for the two states nothing on this page can recover from: no more reconnecting, no more probing.
let halted = false;

// Whether a curtain is up, which is what makes the page inert - nothing types into a page that cannot answer.
export function isCurtainUp() {
    return curtainKind !== null;
}

// The container is still here after all, so this window may go back to reconnecting.
export function resumeReconnects() {
    halted = false;
}

// Three dots that say a curtain is waiting for something rather than reporting a state that has settled. Three
// elements with staggered fades rather than an animated `content`, which not every engine interpolates.
function pendingDots() {
    const dots = document.createElement("span");
    dots.className = "dots";
    for (let i = 0; i < 3; i++) {
        const dot = document.createElement("i");
        dot.style.animationDelay = `${i * 180}ms`;
        dots.append(dot);
    }
    return dots;
}

function showCurtain(kind, title, body, action) {
    curtainKind = kind;
    curtainCard.textContent = "";
    const heading = document.createElement("h2");
    heading.textContent = title;
    // One of these states is a wait rather than a report: the container is on its way down and this page is
    // watching for it to land. The dots say so, and they are gone the moment it has.
    if (kind === "stopping") heading.append(pendingDots());
    const text = document.createElement("p");
    text.textContent = body;
    curtainCard.append(heading, text);
    if (action) {
        const row = document.createElement("div");
        row.className = "row";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn primary";
        button.textContent = action.label;
        button.addEventListener("click", action.run);
        row.append(button);
        curtainCard.append(row);
    }
    curtain.classList.add("show");
    // The terminal keeps focus through everything else, so without this the keyboard would still be typing
    // into a session behind the curtain.
    term.blur();
}

export function hideCurtain() {
    curtainKind = null;
    curtain.classList.remove("show");
    curtainCard.textContent = "";
}

// Nothing answers. Held back by the grace delay, since most disconnects are over before it fires.
function armDownCurtain() {
    if (curtainTimer || curtainKind || halted) return;
    curtainTimer = setTimeout(() => {
        curtainTimer = null;
        if (connected || halted) return;
        showCurtain(
            "down",
            "Can't reach the container",
            "It is stopped, or still coming back. Nothing was lost: sessions live in the container, and this window " +
                "picks them up again the moment it answers.",
            { label: "Try again", run: reconnectNow },
        );
    }, CURTAIN_DELAY_MS);
}

function clearCurtainTimer() {
    if (!curtainTimer) return;
    clearTimeout(curtainTimer);
    curtainTimer = null;
}

// The relay is up and refused this window. Shown at once - a spent key does not heal, and the wait would
// only delay telling the user where the current URL is.
function lockedCurtain() {
    halted = true;
    clearCurtainTimer();
    showCurtain(
        "locked",
        "This link is no longer valid",
        "The web interface issues a new key every time it starts, and this window is holding the old one. Get the " +
            "current URL from the session greeting, or by running webterm <agent> in the container.",
    );
}

// The user asked for this one, so it says so rather than reporting a failure. It is also the only curtain that is
// still waiting on something: the container takes a moment to go, and a page cannot see that from inside itself.
// So this is the first half of a pair, and it deliberately says nothing yet about what to do next - the container
// has not gone, and a container that turns out not to stop at all recovers this page instead.
export function stoppingCurtain() {
    halted = true;
    clearCurtainTimer();
    showCurtain("stopping", "Stopping the container", "Every session in it is ending.");
}

// The relay went while the container was on its way down, which is the container going: nothing else takes the
// server with it at that moment. This is the half that says it is over and what to do next - "Stopping the
// container" left up for good reads as a page that got stuck halfway through, which is exactly what it looks like
// when the thing it was waiting for happened seconds ago.
function stoppedCurtain() {
    halted = true;
    clearCurtainTimer();
    showCurtain(
        "stopped",
        "The container is stopped",
        "Every session in it has ended, and nothing on disk was touched. Start your next one with npx totopo on the " +
            "host - it comes back with a fresh URL, since the key goes with the container.",
    );
}

// --- The socket --------------------------------------------------------------------------------------------------------------------------

export const LAST_SID_KEY = "webterm-last-session";
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5_000;
// How long a woken window waits for an answer before treating the socket as dead. A live loopback socket
// answers in milliseconds; one the OS has not yet noticed is gone answers never.
const PROBE_TIMEOUT_MS = 3_000;

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws${KEY_QUERY}`;
let ws = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let probeTimer = null;

export function sendFrame(frame) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

// Any frame at all proves the socket works, which is what a wake probe is waiting to hear. Called by the frame
// router, since every frame counts and only it sees them all.
export function noteSocketAlive() {
    if (probeTimer) {
        clearTimeout(probeTimer);
        probeTimer = null;
    }
}

// Retire the current socket before replacing it, handlers first: a late close or error from the socket
// being abandoned must not schedule a second reconnect or overwrite the new one's state.
function dropSocket() {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
        ws.close();
    } catch {
        // Already closing.
    }
    ws = null;
}

export function connect() {
    dropSocket();
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        // Read before the flag is set: this is the page's first socket, as opposed to a reconnect. It is
        // what tells the server whether an empty container should get a session - opening the page means
        // "put me somewhere", coming back from a blip means "give me back what I had", empty bar included.
        const fresh = !everConnected;
        connected = true;
        everConnected = true;
        reconnectDelay = RECONNECT_MIN_MS;
        // Whatever was wrong is over: the page comes back to life before anything else is sent.
        clearCurtainTimer();
        hideCurtain();
        document.body.classList.remove("offline");
        // Ask for the session this window was last looking at. The server decides whether it can have
        // it back, and picks something sensible when it cannot.
        // The last session this window drove: the server hands it back when no other window is on it.
        sendFrame({ t: "hello", sid: sessionStorage.getItem(LAST_SID_KEY) ?? "", fresh });
        refreshComposer();
    };

    ws.onmessage = (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            return;
        }
        onFrame(msg);
    };

    // A dropped socket says nothing about the session on the other side, so the screen stays exactly as
    // it is and the window just reconnects. This is what makes closing the lid harmless.
    ws.onclose = () => {
        connected = false;
        // Immediately, ahead of any curtain: every control on the page is answered over this socket, so
        // while it is down they must stop taking clicks.
        document.body.classList.add("offline");
        refreshComposer();
        // The container was on its way down and the relay has now gone with it. That is the confirmation the
        // stopping curtain is waiting for, and there is nothing to diagnose: this close was the point.
        if (curtainKind === "stopping") {
            stoppedCurtain();
            return;
        }
        diagnose();
    };

    ws.onerror = () => {
        // onclose follows and does the work.
    };
}

// Why the socket went away, asked of the one route that can answer without one. A refusal means the relay
// is alive and this window's key is not the live one any more - a different thing from a container that is
// gone, and the only one reconnecting cannot fix. Anything else (an answer, or nothing at all) goes back
// through the reconnect loop, so a blip heals silently and a stopped container heals when it comes back.
// Run on every close, not just the first: it is also what notices a relay that came back with a new key.
async function diagnose() {
    if (halted) return;
    try {
        const res = await fetch(`/status${KEY_QUERY}`, { cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (res.status === 403) {
            lockedCurtain();
            return;
        }
    } catch {
        // Nothing answered, which is the ordinary "container is down" case.
    }
    scheduleReconnect();
    armDownCurtain();
}

function scheduleReconnect() {
    if (halted || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function reconnectNow() {
    if (halted) return;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    reconnectDelay = RECONNECT_MIN_MS;
    connect();
}

// Waking up is the case a plain reconnect loop misses: after a sleep the socket can look OPEN for
// minutes while the other end is long gone. So the window asks, and reconnects when nothing answers.
function probeConnection() {
    if (halted) return; // Nothing to wake up to: this window's way back is a new URL, not a new socket.
    if (!connected) {
        reconnectNow();
        return;
    }
    if (probeTimer) return;
    probeTimer = setTimeout(() => {
        probeTimer = null;
        reconnectNow();
    }, PROBE_TIMEOUT_MS);
    sendFrame({ t: "ping" });
}

window.addEventListener("online", probeConnection);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) probeConnection();
});

// --- Telling the server you are here -----------------------------------------------------------------------------------------------------
//
// The server cannot see the user, and one thing depends on it: whether an alert that is standing has been answered,
// which is what calls off the sound waiting behind it. A touch is anything deliberate - a key, a click, a scroll.
// Bare mouse movement is not one: a pointer crossing the window on its way somewhere else says nothing about who is
// reading it.
//
// Only ever sent while the session in front of you is actually waiting on you. Nothing else is listening for it, so
// the quiet case - which is nearly all of the time - costs no traffic at all, and there is nothing to throttle.
function noteSeen() {
    if (!attachedSid) return;
    const entry = sessions.find((session) => session.id === attachedSid);
    if (!entry?.attention) return;
    sendFrame({ t: "seen" });
}

document.addEventListener("pointerdown", noteSeen, { passive: true });
document.addEventListener("keydown", noteSeen);
document.addEventListener("wheel", noteSeen, { passive: true });
