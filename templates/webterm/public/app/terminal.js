// terminal.js - the terminal itself: the attached session's live TUI, and the keystrokes that go back.
//
// xterm.js and its fit addon come from the page as globals (they are plain scripts under /vendor), so this is
// the one module that reaches for something it did not import.

import { connected, isCurtainUp, sendFrame } from "./connection.js";
import { input, overlay, termEl } from "./dom.js";
import { attachedSid } from "./state.js";

export const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    // A touch lighter than pure black, matching --term-bg in the stylesheet.
    theme: { background: "#12161d" },
    // An agent that turns on mouse reporting takes the mouse away from selection entirely. Alt+drag is
    // then the way to select anyway, so text stays copyable whatever the TUI does with the mouse.
    macOptionClickForcesSelection: true,
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);

// Put the terminal on the page and size it. Called from the entry rather than here, because a mounted
// terminal is the first step of a page that is being started rather than a side effect of loading a module.
export function mountTerminal() {
    term.open(termEl);
    doFit();
}

// Fit the terminal to its container and push the size to the PTY. Called on load, after fonts
// settle, and on every (debounced) resize. Fitting only once too early leaves the last row
// clipped because the monospace metrics are not final yet.
export function doFit() {
    try {
        fit.fit();
        sendResize();
    } catch {
        // A zero-size layout pass can throw; the next fit settles it.
    }
}

// Re-fit after the web font and initial layout settle, which is when the early clipping cleared up.
window.addEventListener("load", doFit);
if (document.fonts?.ready) document.fonts.ready.then(doFit);
setTimeout(doFit, 250);

export function sendResize() {
    if (connected && attachedSid) sendFrame({ t: "resize", cols: term.cols, rows: term.rows });
}

// Force a full repaint shortly after output settles. The DOM renderer can leave stale cells behind
// when a line is redrawn with wide glyphs (the statusline emoji), showing as gaps or doubled text
// until something - like selecting the text - forces those cells to repaint. A debounced full
// refresh does the same thing proactively. Debounced so streaming output stays cheap.
let refreshTimer = null;
export function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        try {
            term.refresh(0, term.rows - 1);
        } catch {
            // Refresh is best-effort; a transient bad state must not break output.
        }
    }, 50);
}

// Hand the keyboard back to the terminal. Clicking in the session bar blurs it - a tab is a plain div, so
// the click moves focus off the terminal, and "+ New session" is a button that takes focus itself - and
// while it is blurred both typing and Cmd+V have nowhere to land, which reads as the terminal ignoring the
// clipboard. Anything the user is deliberately typing in keeps focus: the composer, a rename editor, and
// the buttons on an open card.
export function focusTerminal() {
    const active = document.activeElement;
    if (active === input || active?.classList.contains("rename")) return;
    if (overlay.classList.contains("show")) return;
    // Nothing types into a page that cannot answer.
    if (isCurtainUp()) return;
    term.focus();
}

// Raw keystrokes typed directly into the terminal go straight to the attached session's PTY.
term.onData((data) => {
    if (connected && attachedSid) sendFrame({ t: "in", data });
});

// Keep the PTY's window size in step with the rendered terminal. Debounced: a resize storm
// (layout settling, pane drag) collapses to one fit + one resize, which cuts down the redraw
// artifacts the TUI shows when width changes mid-render.
let resizeTimer = null;
const resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        try {
            fit.fit();
            sendResize();
        } catch {
            // Layout can fire a zero-size pass; ignore and let the next one settle.
        }
    }, 80);
});
resizeObserver.observe(termEl);
