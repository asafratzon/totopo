// alerts.js - what the interface says when nobody is looking at it: the browser's own tab, and a sound.
//
// Everything the session bar does is invisible when the window is behind something else, and that is exactly
// when an agent finishing matters most - one browser tab per workspace, the user in an editor or in another
// workspace. So the same two facts are said again in the only places a hidden window can speak.

import { SVG_NS } from "./dom.js";
import { sessions, workspaceName } from "./state.js";
import { arrivedAt, renderBar } from "./tabs.js";
import { focusTerminal } from "./terminal.js";
import { WORKSPACE_COLOR } from "./theme.js";

// --- The browser's own tab ---------------------------------------------------------------------------------------------------------------
//
// The icon is drawn here rather than shipped as a file because it has to carry live state. It keeps the chip
// (that is the product's mark, and its gold is the chip's own, not the interface's palette) and adds a thin
// frame in the workspace colour, so a row of pinned tabs is readable at a glance. On top of that it carries the
// state of the container in one mark:
//
//   nothing                       - nothing is happening in here
//   white bar across the bottom   - an agent is working, with a lit segment sweeping along it
//   green dot in the top corner   - an agent finished and is waiting for you, pulsing until you go and look
//
// One mark at a time, and the two are told apart by where they sit before any colour is read: working owns the
// bottom edge, waiting owns the top-right corner. That was the lesson of the first version, where both were a
// dot in the same corner - at 16px, which is the only size that really matters here, a blue dot and a green dot
// are the same dot. Green outranks white, since something that wants you matters more than something still going.
//
// Working is white rather than a colour on purpose. Every hue in this interface belongs to a workspace or to a
// session, and the frame around this very icon is one of six of them - so a blue mark sat inside a blue frame in
// one workspace out of six and stopped reading as a mark at all. White belongs to nobody, and it leaves green as
// the only hue in the icon that means anything, which is what makes the pair read as a traffic light.
//
// Both marks move, and neither leans on a particular frame to be understood. A hidden tab is exactly the tab this
// icon exists for, and a browser slows a hidden tab's timers to a second and then to one a minute, so whatever
// frame the animation stalls on has to say what the rest of them say: waiting pulses between a bright dot and a
// dim one rather than between a dot and nothing, and the working segment is the lit part of a bar that is drawn
// whole underneath it. The worst a throttled tab does is move slowly, or stop - and stopped still reads.

const faviconLink = document.querySelector('link[rel="icon"]');
// Drawn at 2x the nominal 32px so the downscale to 16px stays crisp.
const ICON_SIZE = 64;
const ICON_UNITS = 32;
// One step of the icon's own clock, which runs only while the icon has something to say. Everything that moves is
// a multiple of this, so the whole icon is one timer and one counter rather than an animation each.
const ICON_TICK_MS = 240;
// The waiting dot's bright-to-dim step, in ticks. Slow enough to read as a pulse rather than a flicker.
const PULSE_TICKS = 3;
// One out-and-back of the working segment, in ticks - about two seconds each way, which is a sweep and not a dash.
const SWEEP_TICKS = 16;
const DONE_COLOR = "#2fe58a";
const BUSY_COLOR = "#e6edf3";

let iconCanvas = null;
let iconTimer = null;
let iconFrame = 0;

// What the dot should say right now, or null for no dot. Read fresh on every paint rather than passed in, so a
// paint from anywhere - an incoming bar, or the pulse - draws what is true now.
function dotColor() {
    if (sessions.some((entry) => entry.attention)) return DONE_COLOR;
    if (sessions.some((entry) => entry.working)) return BUSY_COLOR;
    return null;
}

// Where the waiting pulse is in its cycle: bright, then dim, then bright again.
function pulseDim() {
    return Math.floor(iconFrame / PULSE_TICKS) % 2 === 1;
}

// Where the working segment is on its track - 0 at one end, 1 at the other, and back down again. A triangle
// rather than a saw, so the segment sweeps back instead of jumping to the start.
function sweepAt() {
    const half = SWEEP_TICKS / 2;
    const step = iconFrame % SWEEP_TICKS;
    return (step < half ? step : SWEEP_TICKS - step) / half;
}

// The chip, on the panel dark, with the workspace frame, and the state mark on top of it.
function paintFavicon() {
    if (!faviconLink) return;
    iconCanvas ??= document.createElement("canvas");
    // Setting the size clears the canvas and resets the transform, so every paint starts from nothing.
    iconCanvas.width = ICON_SIZE;
    iconCanvas.height = ICON_SIZE;
    const ctx = iconCanvas.getContext("2d");
    if (!ctx) return;
    const badgeColor = dotColor();
    // Only one mark is ever drawn, so both phases can be handed over and the drawing picks the one it needs.
    try {
        drawIcon(ctx, badgeColor, badgeColor === DONE_COLOR && pulseDim(), sweepAt());
    } catch {
        // A drawing call this browser does not have (roundRect is recent) must not reach the frame handler
        // that got here: the shipped favicon.svg stays, and everything else on the page carries on.
        return;
    }
    faviconLink.type = "image/png";
    faviconLink.href = iconCanvas.toDataURL("image/png");
}

function drawIcon(ctx, badgeColor, dim, sweep) {
    ctx.scale(ICON_SIZE / ICON_UNITS, ICON_SIZE / ICON_UNITS);

    // Panel, and the frame that says which workspace this tab belongs to.
    ctx.fillStyle = "#0d1117";
    ctx.beginPath();
    ctx.roundRect(0, 0, 32, 32, 7);
    ctx.fill();
    ctx.strokeStyle = WORKSPACE_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(1, 1, 30, 30, 6);
    ctx.stroke();

    // The chip: a rounded triangle, stroked as well as filled so it nearly fills the icon and still reads at
    // 16px. Same geometry and gradient as favicon.svg, which is what a browser without canvas still gets.
    const chip = ctx.createLinearGradient(0, 0, 0, 32);
    chip.addColorStop(0, "#f0c078");
    chip.addColorStop(1, "#d08a3c");
    ctx.fillStyle = chip;
    ctx.strokeStyle = chip;
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(16, 7);
    ctx.lineTo(26, 24);
    ctx.lineTo(6, 24);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Toasted salt, so it reads as a chip rather than a triangle.
    ctx.fillStyle = "rgba(138, 90, 34, 0.5)";
    for (const [x, y] of [
        [13.5, 18],
        [18.5, 20.4],
    ]) {
        ctx.beginPath();
        ctx.arc(x, y, 1.2, 0, Math.PI * 2);
        ctx.fill();
    }

    // Working: a bar across the bottom, with a lit segment sweeping from end to end. The bottom edge is the far
    // side of the icon from the corner waiting owns, which is what tells the two states apart at 16px - a thin
    // line down the right edge, which is what this used to be, reads as a scrollbar rather than as anything the
    // container is doing. The track is 20 wide and the segment 8, so the segment travels the 12 between them.
    // Every mark is punched out of the icon first, so it stays legible over the chip's shoulder and the frame.
    if (badgeColor === BUSY_COLOR) {
        ctx.fillStyle = "#0d1117";
        ctx.beginPath();
        ctx.roundRect(4.5, 24, 23, 6, 3);
        ctx.fill();
        // Drawn whole, at a quarter strength, so the bar is there whatever frame a throttled tab stalls on.
        ctx.fillStyle = badgeColor;
        ctx.globalAlpha = 0.25;
        ctx.beginPath();
        ctx.roundRect(6, 25.5, 20, 3.5, 1.75);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.roundRect(6 + sweep * 12, 25.5, 8, 3.5, 1.75);
        ctx.fill();
        return;
    }

    // Waiting: a dot in the top-right corner, pulsing between bright and dim. The punch-out never changes size,
    // so the pulse moves the dot and nothing else.
    if (badgeColor) {
        ctx.fillStyle = "#0d1117";
        ctx.beginPath();
        ctx.arc(24, 8, 6.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = badgeColor;
        ctx.globalAlpha = dim ? 0.45 : 1;
        ctx.beginPath();
        ctx.arc(24, 8, dim ? 3.4 : 4.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
    }
}

// The clock runs only while the icon has a mark to draw, and stops the moment it does not. It re-checks the state
// itself rather than trusting the bar that started it, so a session visited in this window (or in another one)
// puts the icon back to a plain chip without waiting for anything else to happen.
function tickIcon() {
    iconTimer = null;
    if (!dotColor()) {
        iconFrame = 0;
        paintFavicon();
        return;
    }
    // Riding the one timer that is already running for exactly as long as something is happening. A hidden tab's
    // own timers are throttled hard, so the chime is better off not depending on any single one of them.
    maybeChime();
    iconFrame++;
    paintFavicon();
    iconTimer = setTimeout(tickIcon, ICON_TICK_MS);
}

// Title and icon together, from the sessions the server last sent. The count goes in the title because that
// is what a window list and a taskbar show; the dot does the work in a tab strip too narrow for words.
export function refreshBrowserTab() {
    // Just the workspace, no product name: a tab strip gives you a few characters, and the icon already says
    // this is totopo. What the title is for is which workspace, and how many sessions want you.
    const waiting = sessions.filter((entry) => entry.attention);
    const name = workspaceName || "totopo";
    document.title = waiting.length > 0 ? `(${waiting.length}) ${name}` : name;

    // Painted from the state every time, moving or not. Starting the clock is guarded by the timer rather than by
    // what the sessions are doing: an alert arriving next to one already up is the same state, and restarting the
    // cycle on every frame the server sends would make the mark stutter.
    paintFavicon();
    if (!dotColor()) {
        if (iconTimer) clearTimeout(iconTimer);
        iconTimer = null;
        iconFrame = 0;
        return;
    }
    if (!iconTimer) iconTimer = setTimeout(tickIcon, ICON_TICK_MS);
}

// --- A sound, for the session you are not at ---------------------------------------------------------------------------------------------
//
// The fourth thing the "an agent finished" alert does, and the only one that reaches a window behind an editor.
// Everything above this - the tab, the title, the icon - has to be looked at to be read, so all three fire on every
// ending whoever is watching. A sound cannot be taken back and reaches you in the next room, so it is the one that asks
// whether you are there.
//
// It asks it by waiting. An alert stands until someone touches that session, so an alert still standing a few seconds
// after the turn ended is one nobody has come back to, and that is the whole test - touch it inside the hold, by
// typing, clicking or scrolling, and the sound is called off before it is ever heard. Deliberately not by whether this
// window has focus, which is what this used to do: focus varies by browser and platform, has to be re-reported on every
// reconnect, and each hole in it fails towards silence.
//
// Nothing before the ending counts, the prompt that started the turn included. Sitting and watching a reply arrive is
// not using the session, and a rule that treated it as such is what made a short turn silent for good.
//
// It is synthesised rather than played from a file, for the same reason the favicon above is drawn rather than shipped:
// nothing to fetch, nothing to license, and the whole sound is legible right here as three numbers times three.

// How long an alert has to keep standing before it is worth a sound. On top of the registry's own settle, so a chime
// always means "this finished a few seconds ago and nobody has been near it", never "it went quiet for a moment".
// Short on purpose: this is the only thing between a finish and your ears, and a finish you hear about a minute late
// is one you have already given up on.
const CHIME_HOLD_MS = 10_000;
// A floor between chimes, for alerts that come due a moment apart rather than together.
const CHIME_GAP_MS = 2_000;
// How long one window's chime speaks for every window of this workspace. Two of them left open on the same container
// both see the same alert, and one sound is the entire point.
const CHIME_CLAIM_MS = 3_000;
const SOUND_KEY = "webterm-sound";
const CHIME_CLAIM_KEY = "webterm-chime-claim";

// A glass tap. A struck object is a handful of sine partials, each fading at its own rate, and the inharmonic ones
// (2.7 and 5.2 rather than 2 and 3) are what stop it sounding like an organ note. [ratio of the base note, how loud
// against the fundamental, how long it takes to fade].
const CHIME_PARTIALS = [
    [1, 1, 0.7],
    [2.7, 0.25, 0.35],
    [5.2, 0.08, 0.2],
];
const CHIME_FREQ = 1568;
const CHIME_ATTACK = 0.002;
// How hard it is struck, and how loud the room plays it back. Kept apart because the first is the instrument and the
// second is the volume knob.
const CHIME_PEAK = 0.4;
const CHIME_VOLUME = 0.35;

// Muting is remembered for this browser and this workspace - one container, one port, one origin - so it survives a
// reload and covers every window of the same container without touching any other workspace. On by default: a
// notification nobody discovers is not a notification, and the bell is right there to turn off.
let soundOn = readSoundPref();

function readSoundPref() {
    try {
        return localStorage.getItem(SOUND_KEY) !== "off";
    } catch {
        // A browser with storage turned off still gets the sound; it just cannot remember being told not to.
        return true;
    }
}

let audioCtx = null;
let chimeDry = null;
let chimeWet = null;

// A small room, made of noise that fades out. A convolver needs an impulse and this is the cheapest honest one; it is
// what makes the tap sound like it happened somewhere rather than inside your head.
function buildRoom(ctx) {
    const length = Math.floor(ctx.sampleRate * 1.8);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
        const data = impulse.getChannelData(channel);
        for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3.2;
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = impulse;
    return convolver;
}

// Built on first use and kept. A browser will not let a page make a sound before the page has been interacted with, so
// this can be called at any moment and simply not be running yet.
function audio() {
    if (!audioCtx) {
        const Ctor = window.AudioContext ?? window.webkitAudioContext;
        if (!Ctor) return null;
        audioCtx = new Ctor();
        const master = audioCtx.createGain();
        master.gain.value = CHIME_VOLUME;
        // Takes the edge off the top partial. Something you might hear all day should not be bright.
        const soften = audioCtx.createBiquadFilter();
        soften.type = "lowpass";
        soften.frequency.value = 9000;
        soften.Q.value = 0.4;
        chimeDry = audioCtx.createGain();
        chimeDry.gain.value = 0.78;
        chimeWet = audioCtx.createGain();
        chimeWet.gain.value = 0.42;
        chimeDry.connect(soften);
        chimeWet.connect(buildRoom(audioCtx)).connect(soften);
        soften.connect(master).connect(audioCtx.destination);
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
}

// One tap. Breaks nothing when it cannot play: a sound is never the only thing carrying the alert.
function playChime() {
    const ctx = audio();
    // Blocked until this page has been clicked or typed into. Nearly never true here - you click the terminal to type -
    // and the tab, the title and the icon are all still saying it either way.
    if (!ctx || ctx.state !== "running") return;
    const at = ctx.currentTime + 0.02;
    for (const [ratio, level, decay] of CHIME_PARTIALS) {
        const osc = ctx.createOscillator();
        osc.frequency.value = CHIME_FREQ * ratio;
        const env = ctx.createGain();
        // Exponential, and never to zero, which is the one value an exponential ramp cannot reach.
        env.gain.setValueAtTime(0.0001, at);
        env.gain.exponentialRampToValueAtTime(Math.max(0.0002, level * CHIME_PEAK), at + CHIME_ATTACK);
        env.gain.exponentialRampToValueAtTime(0.0001, at + CHIME_ATTACK + decay);
        osc.connect(env);
        env.connect(chimeDry);
        env.connect(chimeWet);
        osc.start(at);
        osc.stop(at + CHIME_ATTACK + decay + 0.05);
    }
}

// The earliest honest moment to open the audio context. The interface is interacted with immediately - the terminal is
// clicked or typed into before anything interesting happens - so by the time an agent has finished a turn this has run.
function unlockAudio() {
    audio();
}

document.addEventListener("pointerdown", unlockAudio, { once: true });
document.addEventListener("keydown", unlockAudio, { once: true });

// Alerts that have already been sounded, so one finish makes one sound however many frames the server sends. Pruned
// alongside arrivedAt, which is what lets a session that finishes, is visited, and finishes again sound both times.
const chimed = new Set();
let chimeTimer = null;
let lastChimeAt = 0;

// A session has stopped waiting, so the alert it sounded for is spent and the next finish is a new one. Called from
// the bar's arrival bookkeeping, which is where a session stops waiting is noticed.
export function forgetChime(sid) {
    chimed.delete(sid);
}

// Alerts that have stood long enough to be worth hearing about. Still standing is the answer to "did anyone come
// back": a touch puts the alert out at the server, and it drops out of here on the next frame.
function dueAlerts() {
    const now = Date.now();
    return sessions.filter((entry) => entry.attention && !chimed.has(entry.id) && now - (arrivedAt.get(entry.id) ?? now) >= CHIME_HOLD_MS);
}

// One window speaks for the workspace. Best effort - two windows racing on the same millisecond both chime, which is
// exactly what would have happened without this.
function claimChime() {
    try {
        const previous = Number(localStorage.getItem(CHIME_CLAIM_KEY) ?? 0);
        if (Date.now() - previous < CHIME_CLAIM_MS) return false;
        localStorage.setItem(CHIME_CLAIM_KEY, String(Date.now()));
    } catch {
        // Nowhere to share the claim, so this window speaks for itself. One window chiming is still right.
    }
    return true;
}

// Called from the two clocks already running: an incoming frame schedules the exact moment, and the icon's own
// clock - which ticks for as long as anything is working or waiting and no longer - catches it when a hidden tab's
// timers are being throttled. Whichever arrives first plays; the other finds the alert already spent.
function maybeChime() {
    const due = dueAlerts();
    if (due.length === 0) return;
    // Spent whether or not it is heard, so a muted window does not save up its chimes for whenever the bell is
    // unmuted - nothing new would have happened by then.
    for (const entry of due) chimed.add(entry.id);
    if (!soundOn) return;
    const now = Date.now();
    if (now - lastChimeAt < CHIME_GAP_MS) return;
    if (!claimChime()) return;
    lastChimeAt = now;
    // Several alerts coming due together are one sound. The message is "come back", not "come back twice".
    playChime();
}

// One timer for the whole bar, set to the next alert that comes due, and re-armed on every frame - so an alert spent
// in the meantime takes its timer with it rather than firing on nothing.
export function scheduleChime() {
    if (chimeTimer) {
        clearTimeout(chimeTimer);
        chimeTimer = null;
    }
    const now = Date.now();
    let soonest = Number.POSITIVE_INFINITY;
    for (const entry of sessions) {
        if (!entry.attention || chimed.has(entry.id)) continue;
        soonest = Math.min(soonest, (arrivedAt.get(entry.id) ?? now) + CHIME_HOLD_MS);
    }
    if (soonest === Number.POSITIVE_INFINITY) return;
    chimeTimer = setTimeout(maybeChime, Math.max(0, soonest - now));
}

// Sound off, and back on. It lives beside the power button because both are about this window and this container
// rather than any one session - with a little distance between them, since a harmless toggle should not share an edge
// with the one control that ends everything.
export function bellButton() {
    const button = document.createElement("button");
    button.id = "bellbtn";
    button.type = "button";
    button.classList.toggle("muted", !soundOn);
    button.title = soundOn
        ? "Sound on - a chime when an agent finishes in a session you have not touched in a while. Click to mute."
        : "Sound muted - click for a chime when an agent finishes in a session you have not touched in a while.";
    button.setAttribute("aria-label", soundOn ? "Mute the finish sound" : "Unmute the finish sound");
    button.setAttribute("aria-pressed", String(soundOn));
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const bell = document.createElementNS(SVG_NS, "path");
    bell.setAttribute("d", "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9");
    const clapper = document.createElementNS(SVG_NS, "path");
    clapper.setAttribute("d", "M13.73 21a2 2 0 0 1-3.46 0");
    svg.append(bell, clapper);
    // Struck through when muted, so the state is a shape and not only a shade.
    if (!soundOn) {
        const slash = document.createElementNS(SVG_NS, "line");
        slash.setAttribute("x1", "3");
        slash.setAttribute("y1", "3");
        slash.setAttribute("x2", "21");
        slash.setAttribute("y2", "21");
        svg.append(slash);
    }
    button.append(svg);
    button.addEventListener("click", toggleSound);
    return button;
}

function toggleSound() {
    soundOn = !soundOn;
    try {
        localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off");
    } catch {
        // Not remembered past this page, but the toggle still works for as long as it is open.
    }
    renderBar();
    // The click landed on a button, which took the keyboard off the terminal.
    focusTerminal();
    // Turning it on plays it once, so the first time it happens behind your editor it is a sound you have already
    // agreed to. Turning it off says nothing, which is the whole point of turning it off.
    if (soundOn) playChime();
}
