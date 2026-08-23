// clipboard.js - copy and paste, which have two paths because a TUI can own the mouse.
//
// - The agent owns it. claude turns on mouse tracking, so xterm switches its own selection off and the
//   highlight you drag belongs to the agent, not to the terminal. The agent then hands that text to the
//   terminal with OSC 52, exactly as it would in a native one - so the OSC 52 handler below is what makes
//   a drag in claude reach the clipboard at all.
// - The terminal owns it (a plain shell, or an agent that leaves the mouse alone). Then the selection is
//   xterm's, and the copy shortcut below copies it.
//
// Either way the page writes the clipboard itself and says what it did in the status pill: the browser's
// own path through xterm only fires when the terminal has focus and a live selection, and says nothing
// when it does not fire. Ctrl+C is deliberately left alone - interrupting the agent must never depend on
// whether something happens to be selected.
//
// There is one clipboard - the machine's - and it changes only when the user copies something in the
// window they are looking at. Nothing else here may write it: not a screen being replayed, not a session
// running in the background. Anything less stops feeling like a clipboard.

import { connected, sendFrame } from "./connection.js";
import { noteMsg } from "./note.js";
import { attachedSid } from "./state.js";
import { term } from "./terminal.js";

// Shortcut hints follow the platform, so the pill only ever teaches keys that work here.
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const COPY_HINT = IS_MAC ? "Cmd+C" : "Ctrl+Shift+C";
const PASTE_HINT = IS_MAC ? "Cmd+V" : "Ctrl+V";
// The modifier that takes the mouse back from an app that is tracking it, so the browser gets the drag
// and the selection is xterm's again (xterm's shouldForceSelection: Alt on macOS, Shift everywhere else).
const FORCE_SELECT_KEY = IS_MAC ? "Alt" : "Shift";

// True while a TUI is tracking the mouse, which is also when xterm has no selection of its own to give.
function agentOwnsMouse() {
    return term.modes.mouseTrackingMode !== "none";
}

// Last-resort clipboard write, for when the async clipboard API is missing or refuses (a non-localhost
// origin is not a secure context; an editor's embedded browser blocks it). execCommand only works inside
// the click or keypress that asked for the copy, which is why this stays synchronous.
function copyByExecCommand(text) {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.readOnly = true;
    // Off-screen rather than hidden: a display:none field cannot be selected, so it cannot be copied.
    scratch.style.position = "fixed";
    scratch.style.top = "-1000px";
    document.body.append(scratch);
    scratch.select();
    let copied = false;
    try {
        copied = document.execCommand("copy");
    } catch {
        // Blocked outright; the caller reports it.
    }
    scratch.remove();
    term.focus();
    return copied;
}

async function copyToClipboard(text) {
    // No async clipboard at all: go straight to the fallback while the user gesture is still current.
    if (!navigator.clipboard?.writeText) return copyByExecCommand(text);
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return copyByExecCommand(text);
    }
}

// Silence is what made this feel broken, so every outcome says so.
async function copyText(text) {
    if (!text) {
        noteMsg("nothing is selected in the terminal - drag over the text you want first");
        return false;
    }
    if (await copyToClipboard(text)) {
        const lines = text.split("\n").length;
        noteMsg(`copied ${lines} line${lines === 1 ? "" : "s"}`);
        return true;
    }
    noteMsg("this browser would not give the page clipboard access", true);
    return false;
}

// Text an agent handed over with OSC 52 that has not reached the clipboard yet - the browser refused the
// write, or this window was not the one in front. It arrives just after the drag rather than inside it,
// and Safari only allows a clipboard write inside the gesture that asked for one, so it is kept here and
// the copy shortcut - a real gesture, in this window - can finish the job. Nothing is lost either way.
let pendingOscText = "";

// A replay is the attached session's own past output, so it can still contain the OSC 52 an agent sent
// when something was copied in that session earlier. Writing it into the terminal re-runs that sequence,
// which put stale text on the clipboard on every attach - a session switch, a reload, a reconnect after
// sleep - and that is what made each session tab look like it carried a clipboard of its own. So the
// clipboard is left alone while a replay is being parsed.
//
// A counter rather than a flag because two replays can be in flight (a switch, then an immediate
// reconnect). xterm runs each write's callback once that chunk is parsed and before it parses anything
// written after it, so output that arrives while a replay is still parsing copies normally. The gate does
// cover anything already queued and not yet parsed when the replay lands, which in practice is nothing: a
// copy and a session switch are both done by hand, and the parser is never that far behind.
let pendingReplays = 0;

export function writeReplay(data) {
    if (!data) return;
    pendingReplays++;
    term.write(data, () => {
        pendingReplays--;
    });
}

function copySelection() {
    const text = term.getSelection();
    if (text) {
        copyText(text);
        return;
    }
    // A copy that did not land when the agent pushed it - refused, or this window was not in front. This
    // keypress is the gesture it was waiting for, in the window that asked for it.
    if (pendingOscText) {
        const pending = pendingOscText;
        pendingOscText = "";
        copyText(pending);
        return;
    }
    // No terminal selection because the agent has the mouse: say what does work instead of "nothing here".
    if (agentOwnsMouse()) {
        noteMsg(`the agent is handling the mouse - dragging copies on its own, or hold ${FORCE_SELECT_KEY} while dragging to select here`);
        return;
    }
    copyText("");
}

// Paste the clipboard into the attached session, as one paste frame the server wraps in bracketed-paste
// markers - the same path Send uses, so a multi-line paste arrives as a paste and not as a burst of
// Enter presses. Reading the clipboard needs permission, which the browser asks for once.
async function pasteIntoTerminal() {
    if (!connected || !attachedSid) return;
    if (!navigator.clipboard?.readText) {
        noteMsg(`this browser will not let the page read the clipboard - press ${PASTE_HINT} in the terminal instead`, true);
        return;
    }
    try {
        const text = await navigator.clipboard.readText();
        if (text) sendFrame({ t: "paste", data: text });
    } catch {
        noteMsg(`clipboard read was blocked - press ${PASTE_HINT} in the terminal instead`, true);
    }
}

// Both handlers hang off the terminal, so they are installed from the entry rather than when this module is
// loaded - the terminal is put on the page there, in order, and a module that reached for it while the page
// was still loading would be reaching into something half-built.
export function installClipboard() {
    // OSC 52 is how a program in the terminal puts text on the clipboard - it is what claude sends when you
    // drag-select in its own UI. Nothing handled it here before, so those selections went nowhere.
    term.parser.registerOscHandler(52, (payload) => {
        // Payload is "<target>;<base64>": the target picks a clipboard (c: system, p: primary), which the
        // browser does not distinguish, so it is dropped.
        const split = payload.indexOf(";");
        const data = split === -1 ? "" : payload.slice(split + 1);
        // "?" asks the terminal to hand the clipboard back. It is never answered: the clipboard belongs to the
        // host, and a process in the container must not be able to read it out through the relay. An empty
        // payload is a clipboard clear, which is also not worth acting on.
        if (!data || data === "?") return true;
        // Replayed output, not something the user just did. Ignored outright: it is a copy that already
        // happened, and the clipboard has moved on since.
        if (pendingReplays > 0) return true;
        let text = "";
        try {
            // Base64 to bytes to UTF-8. Decoding with atob alone yields latin-1, which mangles every
            // non-ASCII character - the bug the upstream xterm clipboard addon shipped with.
            text = new TextDecoder().decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)));
        } catch {
            // A malformed payload is the sending program's problem, not something to report here.
            return true;
        }
        // Only the window in front may write the clipboard. A background window - a second tab, or this one
        // while the user is in another app - would replace what they copied there, so the text waits for a
        // copy shortcut here instead of taking a clipboard it was not asked for.
        if (!document.hasFocus()) {
            pendingOscText = text;
            return true;
        }
        // Not awaited: the parser reads the rest of the agent's output while the clipboard write settles.
        // Chrome allows this write without a fresh click (the tab is focused and holds the permission); where
        // it is refused, the text is kept so the copy shortcut can finish it.
        copyText(text).then((copied) => {
            pendingOscText = copied ? "" : text;
            if (!copied) noteMsg(`press ${COPY_HINT} to finish copying the agent's selection`, true);
        });
        return true;
    });

    // Taken before xterm sees the key. Cmd+C would otherwise depend on the browser's copy event reaching
    // xterm, and the ctrl+shift pair is worse than nothing today: xterm maps ctrl+letter ignoring shift, so
    // Ctrl+Shift+C sends ^C and interrupts the agent. Plain Cmd+V / Ctrl+V is left to the browser's own
    // paste event, which carries the clipboard with it and needs no permission.
    term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;

        // Shift+Enter is a newline here too, so one habit works in both boxes on this page. A terminal has no such key
        // of its own - Enter is a carriage return whatever else is held down, which is why an agent's own answer to
        // "give me a newline" is Alt+Enter, ESC followed by CR. That is exactly what this sends, so this is a second
        // key onto a sequence the agent already understands rather than anything new for it to support. Alt+Enter is
        // untouched and still works, for the fingers that already know it.
        if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            if (connected && attachedSid) sendFrame({ t: "in", data: "\x1b\r" });
            return false;
        }

        const cmd = event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
        const ctrlShift = event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
        const key = event.key.toLowerCase();
        if ((cmd || ctrlShift) && key === "c") {
            event.preventDefault();
            copySelection();
            return false;
        }
        if (ctrlShift && key === "v") {
            event.preventDefault();
            pasteIntoTerminal();
            return false;
        }
        return true;
    });
}
