// app.js - xterm.js terminal, the session bar, and the rich composer, all over one WebSocket.
//
// The session bar is mission control for this container: every live agent is a tab, this window drives
// one of them at a time, and none of them ends because a window closed or a laptop slept. The terminal
// renders the attached session's live TUI and forwards raw keystrokes and resizes. The composer handles
// typing, image paste/drop/upload, and dictation. Pasted images are uploaded and their container paths
// are inserted inline, so what you see in the box is what is sent; on Send the whole composer text goes
// as one {t:"paste"} frame the server wraps as a bracketed paste.

// --- Terminal ----------------------------------------------------------------------------------------------------------------------------

const term = new Terminal({
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

const tabbar = document.getElementById("tabbar");
const termEl = document.getElementById("term");
const overlay = document.getElementById("overlay");
const card = document.getElementById("card");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const attachBtn = document.getElementById("attach");
const fileInput = document.getElementById("file-input");
const note = document.getElementById("note");

// --- Page state --------------------------------------------------------------------------------------------------------------------------
// Declared up here, before the first fit: the fit pushes a resize, which reads this state, and a `let`
// read before its declaration throws rather than reading undefined.

// Everything the session bar draws comes from the server, so every window agrees on it.
let sessions = [];
let attachedSid = null;
let maxSessions = 8;
let agentName = "the agent";
let workspaceName = "";
// The session tab being renamed right now (its id), and the text in its editor. Kept in module state so a
// bar re-render (an incoming server frame, or the 60s age tick) rebuilds the editor without losing what
// was typed. `renameJustStarted` selects the whole default label the first time, so it can be typed over.
let editingSid = null;
let editingValue = "";
let renameJustStarted = false;
// True while the terminal shows the "no sessions" hint, so it is painted once and not on every frame.
let emptyPainted = false;

let connected = false;
let everConnected = false;

// Mount the terminal.
term.open(termEl);

// Fit the terminal to its container and push the size to the PTY. Called on load, after fonts
// settle, and on every (debounced) resize. Fitting only once too early leaves the last row
// clipped because the monospace metrics are not final yet.
function doFit() {
    try {
        fit.fit();
        sendResize();
    } catch {
        // A zero-size layout pass can throw; the next fit settles it.
    }
}

doFit();
// Re-fit after the web font and initial layout settle, which is when the early clipping cleared up.
window.addEventListener("load", doFit);
if (document.fonts?.ready) document.fonts.ready.then(doFit);
setTimeout(doFit, 250);

// Force a full repaint shortly after output settles. The DOM renderer can leave stale cells behind
// when a line is redrawn with wide glyphs (the statusline emoji), showing as gaps or doubled text
// until something - like selecting the text - forces those cells to repaint. A debounced full
// refresh does the same thing proactively. Debounced so streaming output stays cheap.
let refreshTimer = null;
function scheduleRefresh() {
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

// --- Session bar -------------------------------------------------------------------------------------------------------------------------

// Muted retro tones, one per session, assigned by the server as an index and rotated once every colour
// is in use. Keep the length in step with PALETTE_SIZE in sessions.js (a test pins it).
const SESSION_COLORS = [
    "#3fb950", // green - the same one the composer border uses when a session is live (--ok in styles.css)
    "#e0a458", // harvest gold
    "#d9764a", // burnt orange
    "#6fa8b3", // teal
    "#c98fa6", // dusty rose
    "#9a8fd8", // muted violet
];

// How often the ages on the session tabs are redrawn. Age is what makes a session parked for a week
// obvious, so it has to keep up without being a per-second timer.
const AGE_TICK_MS = 60_000;

function colorFor(entry) {
    return SESSION_COLORS[(entry.colorIndex ?? 0) % SESSION_COLORS.length];
}

function ageLabel(createdAt) {
    const minutes = Math.floor((Date.now() - createdAt) / 60_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

// The tab's name is either a static label or, while this tab is being renamed, an inline editor.

// Static: the custom name if one is set, else the default "agent N". Double-click turns it into the
// editor; a single click still selects the tab, so renaming never gets in the way of switching.
function staticName(entry) {
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name || entry.label;
    name.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        startRename(entry);
    });
    return name;
}

// Inline editor: seeded from editingValue so a mid-edit re-render keeps the text. Enter commits, Escape
// cancels, clicking away commits. Clicks inside must not bubble to the tab, which would switch session.
function renameEditor(entry) {
    const editor = document.createElement("input");
    editor.type = "text";
    editor.className = "rename";
    editor.value = editingValue;
    editor.spellcheck = false;
    // A soft cap for the field; the server trims to its own limit and strips control characters.
    editor.maxLength = 60;
    editor.addEventListener("click", (event) => event.stopPropagation());
    editor.addEventListener("dblclick", (event) => event.stopPropagation());
    editor.addEventListener("input", () => {
        editingValue = editor.value;
    });
    editor.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            commitRename(entry.id);
        } else if (event.key === "Escape") {
            event.preventDefault();
            cancelRename();
        }
    });
    // Enter and Escape clear editingSid before the re-render blurs this field, so this does not double up.
    editor.addEventListener("blur", () => {
        if (editingSid === entry.id) commitRename(entry.id);
    });
    return editor;
}

function startRename(entry) {
    editingSid = entry.id;
    editingValue = entry.name || entry.label;
    renameJustStarted = true;
    renderBar();
}

function commitRename(sid) {
    const name = editingValue.trim();
    editingSid = null;
    editingValue = "";
    // Sent even when empty: the server reads that as "clear the name" and the tab falls back to its default.
    sendFrame({ t: "rename", sid, name });
    renderBar();
    term.focus();
}

function cancelRename() {
    editingSid = null;
    editingValue = "";
    renderBar();
    term.focus();
}

function tabFor(entry) {
    const tab = document.createElement("div");
    tab.className = "tab";
    if (entry.id === attachedSid) tab.classList.add("active");
    if (entry.unread) tab.classList.add("unread");
    tab.style.setProperty("--sc", colorFor(entry));
    // The tooltip keeps the default "agent N" even when a custom name is shown, so the number stays findable.
    tab.title = `${entry.label} - running ${ageLabel(entry.createdAt)} - double-click the name to rename`;

    const dot = document.createElement("span");
    dot.className = "dot";
    const name = entry.id === editingSid ? renameEditor(entry) : staticName(entry);
    const age = document.createElement("span");
    age.className = "age";
    age.textContent = ageLabel(entry.createdAt);
    tab.append(dot, name, age);

    // Another window is driving this one, so a takeover prompt on click is not a surprise.
    if (entry.attached && entry.id !== attachedSid) {
        const chip = document.createElement("span");
        chip.className = "elsewhere";
        chip.textContent = "in another window";
        tab.append(chip);
    }

    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.textContent = "×";
    close.title = "End this session";
    close.addEventListener("click", (event) => {
        // Without this the click also selects the tab, which is the last thing you want next to a kill.
        event.stopPropagation();
        closeCard(entry);
    });
    tab.append(close);

    tab.addEventListener("click", () => {
        if (entry.id === attachedSid) return;
        sendFrame({ t: "attach", sid: entry.id });
    });
    return tab;
}

function renderBar() {
    tabbar.textContent = "";
    for (const entry of sessions) {
        tabbar.append(tabFor(entry));
    }

    const add = document.createElement("button");
    add.id = "newtab";
    add.type = "button";
    add.textContent = "+ New session";
    add.title = `Start another ${agentName} in this container`;
    add.disabled = sessions.length >= maxSessions;
    add.addEventListener("click", () => sendFrame({ t: "new" }));
    tabbar.append(add);

    // The workspace name sits at the far right so several open containers are told apart at a glance. The
    // session count that used to live here was redundant - the tabs show how many there are, and
    // "+ New session" disables at the limit - so the name gets the space to itself.
    if (workspaceName) {
        const right = document.createElement("div");
        right.id = "barright";
        const ws = document.createElement("span");
        ws.className = "ws";
        ws.textContent = workspaceName;
        right.append(ws);
        tabbar.append(right);
    }

    // Keep focus in the rename editor across re-renders. The first render after a double-click selects the
    // whole label so it can be typed over; a later render (an incoming frame) only restores the caret.
    const editor = tabbar.querySelector("input.rename");
    if (editor) {
        editor.focus();
        if (renameJustStarted) {
            editor.select();
            renameJustStarted = false;
        } else {
            const end = editor.value.length;
            editor.setSelectionRange(end, end);
        }
    }

    // The terminal carries the attached session's colour too, so it says where you are on its own.
    const attached = sessions.find((entry) => entry.id === attachedSid);
    termEl.style.borderLeftColor = attached ? colorFor(attached) : "transparent";

    // Name the workspace in the browser tab, so several open containers are told apart at a glance.
    document.title = workspaceName ? `totopo@${workspaceName}` : "totopo";
}

setInterval(renderBar, AGE_TICK_MS);

// --- Overlay cards -----------------------------------------------------------------------------------------------------------------------

// One card shape for every decision: a title, an explanation, and buttons. Each button closes the card
// and then runs its action, so no card can be left open over a terminal you are typing into.
function showCard(title, body, buttons) {
    card.textContent = "";
    const heading = document.createElement("h2");
    heading.textContent = title;
    const text = document.createElement("p");
    text.textContent = body;
    const row = document.createElement("div");
    row.className = "row";
    for (const spec of buttons) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = spec.kind ? `btn ${spec.kind}` : "btn";
        button.textContent = spec.label;
        button.addEventListener("click", () => {
            hideCard();
            spec.run?.();
        });
        row.append(button);
    }
    card.append(heading, text, row);
    overlay.classList.add("show");
}

function hideCard() {
    overlay.classList.remove("show");
    card.textContent = "";
}

function labelOf(sid, fallback) {
    return sessions.find((entry) => entry.id === sid)?.label ?? fallback;
}

// Asked when this window tries to open a session another window is driving.
function takeoverCard(sid) {
    showCard(
        `${labelOf(sid, "That session")} is open in another browser window`,
        "A terminal has one size, so only one window drives a session at a time. Switching here disconnects the other " +
            "window - it keeps the conversation on screen and can take it back with one click.",
        [{ label: "Cancel" }, { label: "Switch to this window", kind: "primary", run: () => sendFrame({ t: "takeover", sid }) }],
    );
}

// Shown to the window that just lost a session to another one.
function takenCard(sid) {
    showCard(
        `${labelOf(sid, "This session")} was taken over in another window`,
        "Nothing was lost: the conversation is still running, and the screen below is where it was. Take it back whenever you want.",
        [{ label: "Stay here" }, { label: "Take it back", kind: "primary", run: () => sendFrame({ t: "takeover", sid }) }],
    );
}

// The only close a user can ask for, so it names what dies and how long it has been alive.
function closeCard(entry) {
    showCard(
        `End ${entry.label}?`,
        `The ${agentName} process is killed and this conversation stops. Sessions are never closed for you - ` +
            `this one has been running ${ageLabel(entry.createdAt)}.`,
        [{ label: "Cancel" }, { label: "End session", kind: "danger", run: () => sendFrame({ t: "close", sid: entry.id }) }],
    );
}

function capCard() {
    showCard(
        `${maxSessions} sessions is the limit`,
        "Each live agent holds a few hundred MB in the container, so the limit keeps one workspace from eating your " +
            "memory. End a session you are done with and this one will start.",
        [{ label: "Got it", kind: "primary" }],
    );
}

// --- Connection --------------------------------------------------------------------------------------------------------------------------

const LAST_SID_KEY = "webterm-last-session";
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5_000;
// How long a woken window waits for an answer before treating the socket as dead. A live loopback socket
// answers in milliseconds; one the OS has not yet noticed is gone answers never.
const PROBE_TIMEOUT_MS = 3_000;

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
let ws = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let probeTimer = null;

function sendFrame(frame) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function sendResize() {
    if (connected && attachedSid) sendFrame({ t: "resize", cols: term.cols, rows: term.rows });
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

function connect() {
    dropSocket();
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        connected = true;
        everConnected = true;
        reconnectDelay = RECONNECT_MIN_MS;
        // Ask for the session this window was last looking at. The server decides whether it can have
        // it back, and picks something sensible when it cannot.
        // The last session this window drove: the server hands it back when no other window is on it.
        sendFrame({ t: "hello", sid: sessionStorage.getItem(LAST_SID_KEY) ?? "" });
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
        refreshComposer();
        scheduleReconnect();
    };

    ws.onerror = () => {
        // onclose follows and does the work.
    };
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function reconnectNow() {
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

function onFrame(msg) {
    // Any frame at all proves the socket works, which is what a wake probe is waiting to hear.
    if (probeTimer) {
        clearTimeout(probeTimer);
        probeTimer = null;
    }
    if (msg.t === "sessions") {
        applySessions(msg);
    } else if (msg.t === "replay") {
        attachedSid = msg.sid;
        sessionStorage.setItem(LAST_SID_KEY, msg.sid);
        emptyPainted = false;
        // Reset first: the buffer is the whole screen, so writing it without a reset would paint it on
        // top of whatever was there (the previous session, or this one before a reconnect).
        term.reset();
        if (msg.data) term.write(msg.data);
        scheduleRefresh();
        // The PTY was last sized for whichever window had it; this one may be a different shape.
        sendResize();
        refreshComposer();
    } else if (msg.t === "out") {
        // Output from a session this window has already left; the window that has it is showing it.
        if (msg.sid !== attachedSid) return;
        term.write(msg.data);
        scheduleRefresh();
    } else if (msg.t === "busy") {
        takeoverCard(msg.sid);
    } else if (msg.t === "taken") {
        attachedSid = null;
        takenCard(msg.sid);
        refreshComposer();
    } else if (msg.t === "exit") {
        if (msg.sid === attachedSid) {
            attachedSid = null;
            term.write(`\r\n\x1b[90m[webterm] ${agentName} exited, so this session is gone.\x1b[0m\r\n`);
        }
        refreshComposer();
    } else if (msg.t === "error") {
        if (msg.code === "cap") capCard();
        else noteMsg(`could not start ${agentName} - check the webterm log in the container`, true);
    }
}

function applySessions(msg) {
    sessions = Array.isArray(msg.list) ? msg.list : [];
    attachedSid = msg.attachedSid ?? null;
    maxSessions = msg.max ?? maxSessions;
    agentName = msg.agent || agentName;
    workspaceName = msg.workspace || "";
    renderBar();
    refreshComposer();
    // Nothing is running: say so, rather than leaving the last session's screen up as if it were live.
    if (sessions.length === 0 && !emptyPainted) {
        emptyPainted = true;
        term.reset();
        term.write(`\r\n  \x1b[90mNo sessions. Use "+ New session" above to start ${agentName}.\x1b[0m\r\n`);
    }
}

// --- Composer ----------------------------------------------------------------------------------------------------------------------------

// Connection and attachment state show on the composer's border and in its placeholder rather than a
// separate status line: green when keystrokes have somewhere to go, amber when they do not, with the
// reason in the placeholder.
const INPUT_PLACEHOLDER = "Type a message. Paste or drop an image, or use the buttons. Enter sends, Shift+Enter for a newline.";

function refreshComposer() {
    const live = connected && Boolean(attachedSid);
    input.classList.toggle("online", live);
    input.classList.toggle("waiting", !live);
    input.disabled = !live;
    if (!connected) input.placeholder = everConnected ? "Reconnecting... your session kept running." : "Connecting...";
    else if (live) input.placeholder = INPUT_PLACEHOLDER;
    else if (sessions.length === 0) input.placeholder = `No sessions. Use "+ New session" above to start ${agentName}.`;
    else input.placeholder = "Pick a session above to type in it.";
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

// Transient status, shown as a pill floating over the bottom of the terminal. It floats rather than
// sitting in the layout because it comes and goes constantly - a copy says so on every drag - and a line
// that appears and disappears in the flow shifts everything under it each time.
// A plain note is gone quickly; an error stays long enough to be read and acted on.
const NOTE_MS = 2500;
const NOTE_ERROR_MS = 5000;

function noteMsg(text, isError) {
    note.textContent = text;
    note.classList.toggle("error", Boolean(isError));
    if (text) {
        setTimeout(
            () => {
                // Only clear the note if no newer message replaced it in the meantime.
                if (note.textContent === text) note.textContent = "";
            },
            isError ? NOTE_ERROR_MS : NOTE_MS,
        );
    }
}

function autoGrow() {
    input.style.height = "auto";
    // Floor at the default height (112px, enough for the stacked buttons) so the box never shrinks
    // behind them; grow with content up to a cap.
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 112), 200)}px`;
}
input.addEventListener("input", autoGrow);

// Insert text into the composer at the current caret position (surrounded by spaces so a path
// does not fuse with adjacent words), then place the caret right after it.
function insertAtCursor(text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const lead = before && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "";
    const trail = after && !after.startsWith(" ") && !after.startsWith("\n") ? " " : " ";
    const piece = lead + text + trail;
    input.value = before + piece + after;
    const caret = before.length + piece.length;
    input.setSelectionRange(caret, caret);
    autoGrow();
    input.focus();
}

// A friendly placeholder token is shown in the composer for each attached image (like claude's own
// [Image #N]); the real container path is swapped in only at send time. Keyed by the visible token.
const pendingImages = new Map();
let imageCounter = 0;

// Upload one image blob; on success insert a friendly [Image #N] token inline where the caret was,
// and remember which container path it maps to.
async function uploadImage(blob) {
    // Capture the caret now - the upload is async and the user may click elsewhere meanwhile.
    const at = input.selectionStart ?? input.value.length;
    try {
        const res = await fetch("/upload", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const token = `[Image #${++imageCounter}]`;
        pendingImages.set(token, data.path);
        input.setSelectionRange(at, at);
        insertAtCursor(token);
    } catch (err) {
        noteMsg(`upload failed: ${err.message}`, true);
    }
}

// Send the whole composer text as one paste. Each [Image #N] token is expanded to its real path
// (in place, so order is preserved) just before sending, so the agent receives the actual file paths.
function send() {
    if (!connected || !attachedSid) return;

    let text = input.value;
    for (const [token, path] of pendingImages) {
        text = text.split(token).join(path);
    }
    text = text.trim();
    if (!text) return;

    sendFrame({ t: "paste", data: text });

    input.value = "";
    pendingImages.clear();
    imageCounter = 0;
    autoGrow();
    term.focus();
}

sendBtn.addEventListener("click", send);

// Enter sends; Shift+Enter inserts a newline. Ctrl+C clears the composer (when nothing is selected,
// so a real copy still works), mirroring claude's "Ctrl+C clears the input line" behavior.
input.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
        if (input.selectionStart === input.selectionEnd) {
            e.preventDefault();
            input.value = "";
            pendingImages.clear();
            imageCounter = 0;
            autoGrow();
        }
        return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
    }
});

// Paste an image straight into the composer.
input.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
        if (item.type.startsWith("image/")) {
            const blob = item.getAsFile();
            if (blob) {
                e.preventDefault();
                uploadImage(blob);
            }
        }
    }
});

// Drag and drop images onto the composer.
["dragover", "drop"].forEach((type) => {
    input.addEventListener(type, (e) => {
        e.preventDefault();
        if (type === "drop") {
            for (const file of e.dataTransfer?.files || []) {
                if (file.type.startsWith("image/")) uploadImage(file);
            }
        }
    });
});

// Attach button -> file picker.
attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
    for (const file of fileInput.files || []) {
        if (file.type.startsWith("image/")) uploadImage(file);
    }
    fileInput.value = "";
});

// --- Clipboard (copy and paste) ----------------------------------------------------------------------------------------------------------
//
// Copying has two paths, because a TUI can own the mouse:
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

// Text an agent handed over with OSC 52 that the browser then refused to copy. It arrives just after the
// drag rather than inside it, and Safari only allows a clipboard write inside the gesture that asked for
// one, so it is kept here and the copy shortcut - a real gesture - can finish the job.
let pendingOscText = "";

function copySelection() {
    const text = term.getSelection();
    if (text) {
        copyText(text);
        return;
    }
    // A copy the browser turned down when the agent pushed it: this keypress is the gesture it wanted.
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
    let text = "";
    try {
        // Base64 to bytes to UTF-8. Decoding with atob alone yields latin-1, which mangles every
        // non-ASCII character - the bug the upstream xterm clipboard addon shipped with.
        text = new TextDecoder().decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)));
    } catch {
        // A malformed payload is the sending program's problem, not something to report here.
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

// Taken before xterm sees the key. Cmd+C would otherwise depend on the browser's copy event reaching
// xterm, and the ctrl+shift pair is worse than nothing today: xterm maps ctrl+letter ignoring shift, so
// Ctrl+Shift+C sends ^C and interrupts the agent. Plain Cmd+V / Ctrl+V is left to the browser's own
// paste event, which carries the clipboard with it and needs no permission.
term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
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

// --- Dictation (Web Speech API, best-effort) ---------------------------------------------------------------------------------------------
// Note: this needs a real Chromium browser (Chrome/Edge/Brave/Arc). Embedded webviews such as the
// VS Code / Codium "Simple Browser" have no microphone access, so dictation cannot work there.

const micBtn = document.getElementById("mic");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const MIC_HELP = "dictation needs a real browser (Chrome/Edge) with mic access - it cannot work in the editor's embedded browser";
let recognition = null;
let recording = false;

if (!SpeechRecognition) {
    micBtn.disabled = true;
    micBtn.title = "Dictation not supported in this browser";
} else {
    recognition = new SpeechRecognition();
    recognition.interimResults = false;
    recognition.continuous = true;

    recognition.onresult = (e) => {
        let transcript = "";
        for (let i = e.resultIndex; i < e.results.length; i++) transcript += e.results[i][0].transcript;
        if (transcript) insertAtCursor(transcript.trim());
    };
    recognition.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
            noteMsg(MIC_HELP, true);
        } else if (e.error === "no-speech") {
            noteMsg("dictation: no speech detected", true);
        } else {
            noteMsg(`dictation: ${e.error}`, true);
        }
    };
    recognition.onend = () => {
        recording = false;
        micBtn.classList.remove("recording");
    };

    // Prime the mic permission via getUserMedia first: SpeechRecognition on its own often fails
    // straight to "not-allowed" without prompting. In an embedded webview getUserMedia is missing
    // or blocked, so we surface the "use a real browser" hint.
    async function startDictation() {
        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                noteMsg(MIC_HELP, true);
                return;
            }
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            for (const track of stream.getTracks()) track.stop();
        } catch {
            noteMsg(MIC_HELP, true);
            return;
        }
        try {
            recognition.start();
            recording = true;
            micBtn.classList.add("recording");
            input.focus();
        } catch {
            // start() throws if already running; ignore.
        }
    }

    micBtn.addEventListener("click", () => {
        if (recording) {
            recognition.stop();
            return;
        }
        startDictation();
    });
}

// --- Go ----------------------------------------------------------------------------------------------------------------------------------

refreshComposer();
renderBar();
connect();
term.focus();
