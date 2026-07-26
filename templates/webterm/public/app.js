// app.js - xterm.js terminal, the session bar, and the rich composer, all over one WebSocket.
//
// The session bar is mission control for this container: every live agent is a tab, this window drives
// one of them at a time, and none of them ends because a window closed or a laptop slept. Tabs are dragged
// to reorder them, and the order is the registry's, so every window agrees on it. A tab also says what its
// session is doing without being opened: a light travels round it while the agent works, and it holds lit
// until visited when an agent finished something nobody was there to see - which the page title and the
// favicon repeat, for when the whole window is behind something else. The terminal renders the
// attached session's live TUI and forwards raw keystrokes and resizes. The composer handles typing, image
// paste/drop/upload, and dictation, and what is in it belongs to the attached session: switching tabs swaps
// the draft, and ending a session throws its draft away. Pasted images are uploaded and their container
// paths are inserted inline, so what you see in the box is what is sent; on Send the whole composer text
// goes as one {t:"paste"} frame the server wraps as a bracketed paste.
//
// Everything here rides on the key this window was handed in its URL: the socket, the uploads and the
// status probe all carry it, and without a valid one the page is never served in the first place.

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
const curtain = document.getElementById("curtain");
const curtainCard = document.getElementById("curtain-card");
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
// Where "+ New session" starts an agent, relative to the workspace root ("" is the root itself). The server
// owns it - it follows the directory totopo was last run in - and the picker opens on it.
let defaultCwd = "";
// The session tab being renamed right now (its id), and the text in its editor. Kept in module state so a
// bar re-render (an incoming server frame, or the 60s age tick) rebuilds the editor without losing what
// was typed. `renameJustStarted` selects the whole default label the first time, so it can be typed over.
let editingSid = null;
let editingValue = "";
let renameJustStarted = false;
// The session tab being dragged along the bar right now, and where it would land: `dropIndex` is the
// position it would hold in the list once it has been taken out of it, which is what the registry splices
// at. `barRenderPending` remembers a render that was skipped because a drag was in flight.
let draggingSid = null;
let dropIndex = null;
let barRenderPending = false;
// What the terminal is holding: either a live session's screen (`shownSid`), or a message where a session used
// to be (`shownMessage`). At most one of them is set. They are tracked because a session can end while this
// window is watching it - nothing replays over the dead screen then, and a dead screen looks exactly like a
// live one. The last screen of an agent that exited on its own is kept rather than replaced (it usually says
// why), so it counts as a message already delivered and no later bar update paints over it.
const EXITED_SCREEN = "exited";
let shownSid = null;
let shownMessage = null;

let connected = false;
let everConnected = false;

// The key that came with the URL. The server mints a new one every time it starts and refuses everything
// without it, so this is also what goes stale: a window left open across a restart still holds the old key,
// which is the case the curtain explains rather than reconnecting forever.
const WEB_KEY = new URLSearchParams(location.search).get("k") ?? "";
const KEY_QUERY = `?k=${encodeURIComponent(WEB_KEY)}`;

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

// Hand the keyboard back to the terminal. Clicking in the session bar blurs it - a tab is a plain div, so
// the click moves focus off the terminal, and "+ New session" is a button that takes focus itself - and
// while it is blurred both typing and Cmd+V have nowhere to land, which reads as the terminal ignoring the
// clipboard. Anything the user is deliberately typing in keeps focus: the composer, a rename editor, and
// the buttons on an open card.
function focusTerminal() {
    const active = document.activeElement;
    if (active === input || active?.classList.contains("rename")) return;
    if (overlay.classList.contains("show")) return;
    // Nothing types into a page that cannot answer.
    if (curtainKind) return;
    term.focus();
}

// --- Colour ------------------------------------------------------------------------------------------------------------------------------
//
// One palette, used for two different jobs.
//
// The workspace takes one slot of it and keeps it: the composer border, the terminal's edge, the active tab's
// edge and the buttons are all that one colour, so a window is recognisable across a screen full of them
// before a single word is read. The slot comes from the published port, which totopo assigns per workspace,
// so two containers open side by side are almost never the same colour and nothing has to be configured.
//
// The sessions inside that window then rotate through the slots the workspace did not take. That is what
// makes a tab's own dot mean "this session" rather than "this workspace", and it is why a dot can never come
// out the same colour as the window it lives in.

// Cyberpunk neons on a near-black bar, spaced around the wheel and deliberately free of yellow and orange -
// those read as a warning here, and the bar has enough to say without one. Keep the length one longer than
// PALETTE_SIZE in sessions.js (a test pins it): the workspace eats one slot, sessions rotate the rest.
const PALETTE = [
    "#2fe58a", // spring green
    "#1fe0cf", // turquoise
    "#f24bff", // magenta
    "#b45cff", // neon violet
    "#29b6ff", // azure
    "#ff2e88", // rose
];

// A stable number for this window when there is no port to read (a proxy, or the default 80/443). Not a
// hash worth defending - it only has to be the same on every reload of the same address.
function hostSeed() {
    let seed = 0;
    for (const ch of location.host) seed = (seed * 31 + ch.codePointAt(0)) % 100_000;
    return seed;
}

// The workspace's slot in the palette. Ports are handed out lowest-free-first per workspace, so neighbours
// land on different colours.
const WORKSPACE_SLOT = (Number(location.port) || hostSeed()) % PALETTE.length;
const WORKSPACE_COLOR = PALETTE[WORKSPACE_SLOT];
// Every slot except the workspace's own, in palette order. A session index maps into this, so "never the
// workspace colour" is a property of the list rather than a rule someone has to remember.
const SESSION_COLORS = PALETTE.filter((_, slot) => slot !== WORKSPACE_SLOT);

// Handed to the stylesheet once, before anything is drawn: everything that carries the window's identity
// reads it from there, so there is one line in the page that decides what colour this workspace is.
document.documentElement.style.setProperty("--ws", WORKSPACE_COLOR);

function colorFor(entry) {
    return SESSION_COLORS[(entry.colorIndex ?? 0) % SESSION_COLORS.length];
}

// --- Session bar -------------------------------------------------------------------------------------------------------------------------

// How often the ages on the session tabs are redrawn. Age is what makes a session parked for a week
// obvious, so it has to keep up without being a per-second timer.
const AGE_TICK_MS = 60_000;

function ageLabel(createdAt) {
    const minutes = Math.floor((Date.now() - createdAt) / 60_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

// --- Animations that outlive a render ----------------------------------------------------------------------------------------------------
//
// The bar is rebuilt from scratch on every frame the server sends, and both of the moving states last longer
// than the gap between frames. A CSS animation on a brand new element starts from zero, so left alone the
// travelling light would jump back to the start of its lap and the "it finished" flash would replay - or
// worse, be cut off half way and never seen. Both are fixed the same way: work out how far in the animation
// should already be and hand that to the browser as a negative delay, so a fresh element carries on mid-stride.

// One lap of the travelling light, and how long the arrival flash lasts. Both must match styles.css.
const TRACE_MS = 4_000;
const ARRIVAL_MS = 1_400;

// The travelling light, in its own clipped layer: the light rides the layer's edge and turns the corners, so
// the part of it that hangs past a corner has to be cut off rather than drawn over the neighbouring tab.
// Every light in the bar shares one phase (the wall clock), so several working sessions move as one.
function traceLayer() {
    const layer = document.createElement("span");
    layer.className = "trace";
    const comet = document.createElement("i");
    comet.className = "comet";
    comet.style.animationDelay = `-${Date.now() % TRACE_MS}ms`;
    layer.append(comet);
    return layer;
}

// When each waiting session's alert first appeared, so the tab flash plays once per alert rather than once per
// frame. Stamped from the incoming frame rather than while the bar is drawn, because a bar render is skipped
// mid-drag and an alert that arrives then must still be able to flash.
const arrivedAt = new Map();

function noteArrivals() {
    for (const entry of sessions) {
        if (entry.attention && !arrivedAt.has(entry.id)) arrivedAt.set(entry.id, Date.now());
    }
    // A session that is no longer waiting (visited, or gone from the bar) may flash again next time it finishes.
    for (const sid of [...arrivedAt.keys()]) {
        if (!sessions.some((entry) => entry.id === sid && entry.attention)) arrivedAt.delete(sid);
    }
}

function startArrival(tab, sid) {
    const elapsed = Date.now() - (arrivedAt.get(sid) ?? Date.now());
    // Long past: the tab just holds its lit state, which is the part that waits for you.
    if (elapsed >= ARRIVAL_MS) return;
    tab.classList.add("arriving");
    tab.style.animationDelay = `-${elapsed}ms`;
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

// What a tab is saying about its session right now, for the tooltip. The colours say it at a glance; this is
// for the moment someone wonders what the light means.
function stateNote(entry) {
    if (entry.working) return " - working";
    if (entry.attention) return " - finished while you were elsewhere";
    return "";
}

// How a directory reads in a sentence. The root has no path worth printing, so it gets a name.
function whereLabel(cwd) {
    return cwd === "" ? "the workspace root" : cwd;
}

// Where the session runs, when that is worth saying: sessions in the workspace root (the usual case) show
// nothing, so the chip means "this one is somewhere else" without every tab carrying a path.
function dirChip(entry) {
    const chip = document.createElement("span");
    chip.className = "dir";
    chip.textContent = entry.cwd;
    return chip;
}

function tabFor(entry) {
    const tab = document.createElement("div");
    tab.className = "tab";
    if (entry.id === attachedSid) tab.classList.add("active");
    if (entry.unread) tab.classList.add("unread");
    if (entry.working) tab.classList.add("working");
    if (entry.attention) tab.classList.add("attention");
    tab.style.setProperty("--sc", colorFor(entry));
    // The tooltip keeps the default "agent N" even when a custom name is shown, so the number stays findable.
    const where = entry.cwd ? ` in ${entry.cwd}` : "";
    tab.title = `${entry.label}${where} - running ${ageLabel(entry.createdAt)}${stateNote(entry)} - double-click the name to rename`;

    if (entry.working) tab.append(traceLayer());
    if (entry.attention) startArrival(tab, entry.id);

    const dot = document.createElement("span");
    dot.className = "dot";
    const name = entry.id === editingSid ? renameEditor(entry) : staticName(entry);
    const age = document.createElement("span");
    age.className = "age";
    age.textContent = ageLabel(entry.createdAt);
    tab.append(dot, name, age);
    if (entry.cwd) tab.append(dirChip(entry));

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
        // The click itself blurred the terminal, so the keyboard goes back to it either way - switching
        // sessions and clicking the session you are already in both leave you able to type and paste.
        focusTerminal();
        if (entry.id === attachedSid) return;
        sendFrame({ t: "attach", sid: entry.id });
    });

    makeDraggable(tab, entry);
    return tab;
}

// --- Reordering the bar ------------------------------------------------------------------------------------------------------------------
//
// The order of the tabs belongs to the registry, so a drag ends as one "reorder" frame and the new order
// arrives back as an ordinary bar broadcast - every window moves together, and nothing is sorted locally on
// the way. Dragging is mouse and trackpad only: this is the browser's own drag and drop, which touch does
// not fire.

// Where the dragged session would land if it were dropped on `entry`. Counted in the list with the dragged
// session already taken out, so it is the same index the registry splices at. Null over the dragged tab
// itself, which is not a move.
function dropIndexFor(entry, after) {
    const others = sessions.filter((session) => session.id !== draggingSid);
    const at = others.findIndex((session) => session.id === entry.id);
    if (at === -1) return null;
    return after ? at + 1 : at;
}

function clearDropMarks() {
    for (const el of tabbar.querySelectorAll(".tab")) el.classList.remove("drop-before", "drop-after");
}

// The line showing where the tab would go, drawn in the gap on one side of a tab.
function markDrop(tab, after) {
    clearDropMarks();
    tab.classList.add(after ? "drop-after" : "drop-before");
}

function makeDraggable(tab, entry) {
    // A tab being renamed is not draggable: it holds a text field, and a draggable ancestor stops the
    // pointer from selecting the text inside it.
    tab.draggable = entry.id !== editingSid;

    tab.addEventListener("dragstart", (event) => {
        draggingSid = entry.id;
        dropIndex = null;
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            // Firefox starts no drag at all without a payload. It is never read back: the dragged session
            // is the one in draggingSid, and only a drag started in this bar is honoured.
            event.dataTransfer.setData("text/plain", entry.id);
        }
        tab.classList.add("dragging");
    });

    tab.addEventListener("dragover", (event) => {
        if (!draggingSid) return;
        event.preventDefault();
        const box = tab.getBoundingClientRect();
        const after = event.clientX > box.left + box.width / 2;
        dropIndex = dropIndexFor(entry, after);
        if (dropIndex === null) clearDropMarks();
        else markDrop(tab, after);
    });

    tab.addEventListener("drop", (event) => {
        if (!draggingSid) return;
        event.preventDefault();
        commitDrag();
    });

    tab.addEventListener("dragend", endDrag);
}

// The bar past the last tab - the empty space and the "+ New session" button - means "put it at the end".
// The bar reads as one row, so a drop anywhere along it should land rather than being thrown away.
tabbar.addEventListener("dragover", (event) => {
    if (!draggingSid) return;
    // A tab does its own half-and-half hit test; this is only the space around them.
    if (event.target instanceof Element && event.target.closest(".tab")) return;
    event.preventDefault();
    const tabs = tabbar.querySelectorAll(".tab");
    const last = tabs[tabs.length - 1];
    dropIndex = Math.max(0, sessions.length - 1);
    if (last) markDrop(last, true);
});

tabbar.addEventListener("drop", (event) => {
    // A drop on a tab has already been handled and cleared the drag, so this only catches the space around
    // them.
    if (!draggingSid) return;
    event.preventDefault();
    commitDrag();
});

function commitDrag() {
    if (draggingSid && dropIndex !== null) sendFrame({ t: "reorder", sid: draggingSid, index: dropIndex });
    endDrag();
}

// Every drag ends here, dropped or abandoned, so none can leave the bar marked up or frozen mid-render.
function endDrag() {
    draggingSid = null;
    dropIndex = null;
    clearDropMarks();
    tabbar.querySelector(".tab.dragging")?.classList.remove("dragging");
    if (barRenderPending) {
        barRenderPending = false;
        renderBar();
    }
}

// Ending the day: one button, and it always asks first. Drawn rather than written, because the bar is
// tabs and this is not one of them - and drawn here rather than shipped in the page, since the bar is
// rebuilt from scratch on every frame.
const SVG_NS = "http://www.w3.org/2000/svg";

function stopButton() {
    const button = document.createElement("button");
    button.id = "stopbtn";
    button.type = "button";
    button.title = "Stop the container - ends every session in it";
    button.setAttribute("aria-label", "Stop the container");
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    const arc = document.createElementNS(SVG_NS, "path");
    arc.setAttribute("d", "M18.36 6.64a9 9 0 1 1-12.73 0");
    const stem = document.createElementNS(SVG_NS, "line");
    stem.setAttribute("x1", "12");
    stem.setAttribute("y1", "2");
    stem.setAttribute("x2", "12");
    stem.setAttribute("y2", "12");
    svg.append(arc, stem);
    button.append(svg);
    button.addEventListener("click", stopCard);
    return button;
}

// The directory picker, drawn in the same line style as the power button: a folder says "choose where"
// far better than a caret, which reads as "more options".
function folderIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "13");
    svg.setAttribute("height", "13");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const folder = document.createElementNS(SVG_NS, "path");
    folder.setAttribute("d", "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z");
    svg.append(folder);
    return svg;
}

function renderBar() {
    // A drag is in flight, so the bar holds still: rebuilding it would replace the element being dragged,
    // which cancels the drag outright. Both the age tick and any incoming frame can land mid-drag. The bar
    // catches up the moment the drag ends.
    if (draggingSid) {
        barRenderPending = true;
        return;
    }
    tabbar.textContent = "";
    for (const entry of sessions) {
        tabbar.append(tabFor(entry));
    }

    // One control, two ways in: the button starts a session in the default directory (the common case, and
    // one click, the way it always was), the folder asks which directory first.
    const group = document.createElement("div");
    group.id = "newtab-group";
    const atCap = sessions.length >= maxSessions;

    const add = document.createElement("button");
    add.id = "newtab";
    add.type = "button";
    add.textContent = "+ New session";
    add.title = `Start another ${agentName} in this container, in ${whereLabel(defaultCwd)}`;
    add.disabled = atCap;
    add.addEventListener("click", () => sendFrame({ t: "new" }));

    const pick = document.createElement("button");
    pick.id = "newtab-pick";
    pick.type = "button";
    pick.append(folderIcon());
    pick.title = "Start a session in another directory";
    pick.setAttribute("aria-label", "Start a session in another directory");
    pick.disabled = atCap;
    pick.addEventListener("click", newSessionCard);

    group.append(add, pick);
    tabbar.append(group);

    // The far right of the bar: which container this is, and the way to end it. The session count that used
    // to live here was redundant - the tabs show how many there are, and "+ New session" disables at the
    // limit - so the name and the power button get the space.
    const right = document.createElement("div");
    right.id = "barright";
    if (workspaceName) {
        const ws = document.createElement("span");
        ws.className = "ws";
        ws.textContent = workspaceName;
        right.append(ws);
    }
    right.append(stopButton());
    tabbar.append(right);

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
}

setInterval(renderBar, AGE_TICK_MS);

// --- The browser's own tab ----------------------------------------------------------------------------------------------------------------
//
// Everything the session bar does is invisible when the window is behind something else, and that is exactly
// when an agent finishing matters most - one browser tab per workspace, the user in an editor or in another
// workspace. So the same two facts are said again in the only two places a hidden window can speak: the title
// and the icon.
//
// The icon is drawn here rather than shipped as a file because it has to carry live state. It keeps the chip
// (that is the product's mark, and its gold is the chip's own, not the interface's palette) and adds a thin
// frame in the workspace colour, so a row of pinned tabs is readable at a glance. On top of that it carries the
// state of the container in one mark - a dot in the top-right:
//
//   nothing                        - nothing is happening in here
//   blue bar down the right edge   - an agent is working
//   green dot in the top corner    - an agent finished and is waiting for you, pulsing until you go and look
//
// One mark at a time, and the two are told apart by where they sit and what shape they are - not by colour. Hue
// alone was not enough: a blue dot and a green dot in the same corner were nearly the same dot at 16px, which is
// the only size that really matters here. Green outranks blue, since something that wants you matters more than
// something still going, and because only one mark is ever drawn the two are free to share the same corner.
//
// The colours are fixed rather than taken from the palette: this is a traffic light, and it only reads at a
// glance if green means the same thing in every workspace. Which session it was is the session bar's job. Blue
// rather than orange for working, because the chip itself is orange and a mark has to be a different thing from
// the icon it sits on.
//
// Waiting pulses for as long as it is waiting - that is the state you have to come back for, so it keeps asking.
// It pulses between a bright dot and a dim one, never between a dot and nothing: a hidden tab is exactly the tab
// this icon exists for, and a browser slows a hidden tab's timers to a second and then to one a minute, so a
// blink that went dark could sit dark for a minute with the alert up. Two visible states cannot lose it - the
// worst a throttled tab does is pulse slowly, or stall on the dim dot, which still says green.

const faviconLink = document.querySelector('link[rel="icon"]');
// Drawn at 2x the nominal 32px so the downscale to 16px stays crisp.
const ICON_SIZE = 64;
const ICON_UNITS = 32;
// One step of the waiting pulse. Slow enough to read as a pulse rather than a flicker in a tab strip.
const PULSE_MS = 700;
const DONE_COLOR = "#2fe58a";
const BUSY_COLOR = "#3b9dff";

let iconCanvas = null;
let pulseTimer = null;
let pulseDim = false;

// What the dot should say right now, or null for no dot. Read fresh on every paint rather than passed in, so a
// paint from anywhere - an incoming bar, or the pulse - draws what is true now.
function dotColor() {
    if (sessions.some((entry) => entry.attention)) return DONE_COLOR;
    if (sessions.some((entry) => entry.working)) return BUSY_COLOR;
    return null;
}

// The chip, on the panel dark, with the workspace frame, and the state dot on top of it.
function paintFavicon() {
    if (!faviconLink) return;
    iconCanvas ??= document.createElement("canvas");
    // Setting the size clears the canvas and resets the transform, so every paint starts from nothing.
    iconCanvas.width = ICON_SIZE;
    iconCanvas.height = ICON_SIZE;
    const ctx = iconCanvas.getContext("2d");
    if (!ctx) return;
    const badgeColor = dotColor();
    // Only the waiting mark pulses. Work is a steady state and a second thing moving would just be noise.
    try {
        drawIcon(ctx, badgeColor, badgeColor === DONE_COLOR && pulseDim);
    } catch {
        // A drawing call this browser does not have (roundRect is recent) must not reach the frame handler
        // that got here: the shipped favicon.svg stays, and everything else on the page carries on.
        return;
    }
    faviconLink.type = "image/png";
    faviconLink.href = iconCanvas.toDataURL("image/png");
}

function drawIcon(ctx, badgeColor, dim) {
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

    // Working: a bar down the right edge. Its own length is what makes it a different mark from the dot below,
    // and the right edge is the one place a long mark does not have to compete with the frame it runs beside.
    // Static, unlike the dot: a browser slows a hidden tab's timers to a second and then to a minute, so anything
    // that moves has to still read when frozen - and two marks moving in a 16px icon is noise, not information.
    // Every mark is punched out of the icon first, so it stays legible over the chip's shoulder and the frame.
    if (badgeColor === BUSY_COLOR) {
        ctx.fillStyle = "#0d1117";
        ctx.beginPath();
        ctx.roundRect(23.5, 8, 7, 17, 3.5);
        ctx.fill();
        ctx.fillStyle = badgeColor;
        ctx.beginPath();
        ctx.roundRect(25, 9.5, 4, 14, 2);
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

// The pulse runs only while something is waiting, and stops the moment nothing is. It re-checks the state itself
// rather than trusting the bar that started it, so a session visited in this window (or in another one) puts the
// icon back to a steady dot without waiting for anything else to happen.
function pulseBadge() {
    pulseTimer = null;
    if (!sessions.some((entry) => entry.attention)) {
        pulseDim = false;
        paintFavicon();
        return;
    }
    pulseDim = !pulseDim;
    paintFavicon();
    pulseTimer = setTimeout(pulseBadge, PULSE_MS);
}

// Title and icon together, from the sessions the server last sent. The count goes in the title because that
// is what a window list and a taskbar show; the dot does the work in a tab strip too narrow for words.
function refreshBrowserTab() {
    // Just the workspace, no product name: a tab strip gives you a few characters, and the icon already says
    // this is totopo. What the title is for is which workspace, and how many sessions want you.
    const waiting = sessions.filter((entry) => entry.attention);
    const name = workspaceName || "totopo";
    document.title = waiting.length > 0 ? `(${waiting.length}) ${name}` : name;

    // Painted from the state every time, pulse or no pulse. Starting the pulse is guarded by the timer rather
    // than by which sessions are waiting: an alert arriving next to one already up is the same state, and
    // restarting the cycle on every frame the server sends would make the dot stutter.
    paintFavicon();
    if (waiting.length === 0) {
        if (pulseTimer) clearTimeout(pulseTimer);
        pulseTimer = null;
        pulseDim = false;
        return;
    }
    if (!pulseTimer) pulseTimer = setTimeout(pulseBadge, PULSE_MS);
}

// --- Overlay cards -----------------------------------------------------------------------------------------------------------------------

// One card shape for every decision: a title, an explanation, buttons, and - where the decision needs one -
// a field between the two. Each button closes the card and then runs its action, so no card can be left open
// over a terminal you are typing into.
function showCard(title, body, buttons, field) {
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
    card.append(heading, text);
    if (field) card.append(field);
    card.append(row);
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

// --- Starting a session somewhere else ---------------------------------------------------------------------------------------------------
//
// A session runs in one directory for its whole life, so this is asked once, up front. The field is the
// authority - anything can be typed into it - and the list beside it is only there so the common case is a
// click. Neither is trusted: the server resolves whatever arrives and refuses what is not a directory in the
// workspace.

const DIR_LIST_ID = "dirlist";

// Fill the picker's suggestions from the container. Fetched when the card opens rather than kept around, so
// a directory created a minute ago is in the list. Failures are silent on purpose: the field still works,
// and a suggestion list that did not load is not worth a card of its own.
async function fillDirList(list) {
    let payload;
    try {
        const res = await fetch(`/dirs${KEY_QUERY}`, { cache: "no-store" });
        if (!res.ok) return;
        payload = await res.json();
    } catch {
        return;
    }
    // The card may have been closed while this was in flight.
    if (!list.isConnected) return;
    const dirs = Array.isArray(payload?.dirs) ? payload.dirs : [];
    // "/" is how the root is written here: a path everyone recognises, and the one value the server reads
    // back as the workspace root itself.
    for (const dir of ["/", ...dirs]) {
        const option = document.createElement("option");
        option.value = dir;
        if (dir === "/") option.label = "workspace root";
        list.append(option);
    }
    // The scan is capped, so say when the list is partial instead of letting it look complete.
    if (payload?.truncated) noteMsg("the directory list is partial - deeper paths can still be typed in");
}

function newSessionCard() {
    const field = document.createElement("input");
    field.type = "text";
    field.className = "path";
    field.value = defaultCwd;
    field.placeholder = "workspace root";
    field.spellcheck = false;
    field.autocomplete = "off";
    field.setAttribute("list", DIR_LIST_ID);
    field.setAttribute("aria-label", "Directory for the new session, relative to the workspace root");
    const list = document.createElement("datalist");
    list.id = DIR_LIST_ID;
    const wrap = document.createElement("div");
    wrap.className = "field";
    wrap.append(field, list);

    const start = () => sendFrame({ t: "new", cwd: field.value.trim() });
    field.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            hideCard();
            start();
        } else if (event.key === "Escape") {
            event.preventDefault();
            hideCard();
            focusTerminal();
        }
    });

    showCard(
        "Start a session somewhere else",
        `New sessions start in ${whereLabel(defaultCwd)}. Pick another directory, or type one relative to the workspace ` +
            `root - the ${agentName} runs there for the life of the session, and its tab says where.`,
        [{ label: "Cancel" }, { label: "Start session", kind: "primary", run: start }],
        wrap,
    );
    field.focus();
    field.select();
    fillDirList(list);
}

// The server refused the path, so nothing was started. It does not say which path back: the user just typed
// it, and the rule is what they need.
function badDirCard() {
    showCard(
        "That directory is not in the workspace",
        "Nothing was started. The path has to be a directory that already exists inside the workspace - written " +
            'relative to its root, like "packages/api".',
        [{ label: "Got it", kind: "primary" }],
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

// Asked before the container goes down, because it takes everything with it - the browser sessions here,
// and any terminal session open in the same container.
function stopCard() {
    const ends =
        sessions.length === 0
            ? "No agent sessions are running here. Stopping it also ends any terminal session open in the same container."
            : `This ends ${sessions.length === 1 ? "the 1 agent session" : `all ${sessions.length} agent sessions`} in it, ` +
              "and any terminal session open in it too.";
    showCard("Stop the container?", `${ends} Nothing on disk is touched, and your next totopo session starts the container back up.`, [
        { label: "Cancel" },
        { label: "Stop container", kind: "danger", run: () => sendFrame({ t: "stop" }) },
    ]);
}

// Shown when the container was asked to stop and did not - a container started before totopo gave its
// keep-alive a TERM trap cannot be stopped from inside itself.
function stopFailedCard() {
    showCard(
        "The container did not stop",
        "This container was created before totopo could stop one from the browser. Stop it from the host instead - " +
            "npx totopo, or docker stop - and the next container it creates will take the button.",
        [{ label: "Got it", kind: "primary" }],
    );
}

// --- The curtain -------------------------------------------------------------------------------------------------------------------------
//
// One state for "this window cannot do anything at all", drawn over the whole page - bar, terminal and
// composer alike. It replaces disabling each control on its own, which is what used to leave a dead page
// looking alive: tabs that still hovered, and an X that opened an end-session prompt nothing would answer.
//
// Three reasons a window ends up here, and they are not the same to the user:
//   down     - nothing answers. The container is stopped or gone; keeps reconnecting, so it heals itself.
//   locked   - the relay answered and refused this window's key. The interface restarted and minted a new
//              one, so this URL is spent; reconnecting is pointless and stops.
//   stopping - the user just stopped the container from here. Same end state as "down", but it is not a
//              failure and must not read like one.
//
// A dropped socket is routine (a sleeping laptop, a wifi blip), so the curtain waits out a short grace and
// usually never appears. What does happen immediately is the page going inert, because a click landing on
// a control whose answer goes nowhere is the actual bug.
const CURTAIN_DELAY_MS = 3_000;

let curtainKind = null;
let curtainTimer = null;
// Set for the two states nothing on this page can recover from: no more reconnecting, no more probing.
let halted = false;

function showCurtain(kind, title, body, action) {
    curtainKind = kind;
    curtainCard.textContent = "";
    const heading = document.createElement("h2");
    heading.textContent = title;
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

function hideCurtain() {
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

// The user asked for this one, so it says so rather than reporting a failure.
function stoppingCurtain() {
    halted = true;
    clearCurtainTimer();
    showCurtain(
        "stopping",
        "Stopping the container",
        "Every session in it is ending. Start your next one with npx totopo on the host - it comes back with a fresh " +
            "URL, since the key goes with the container.",
    );
}

// --- Connection --------------------------------------------------------------------------------------------------------------------------

const LAST_SID_KEY = "webterm-last-session";
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
        // Straight after hello, so a window that reconnects while it is behind something else is not mistaken
        // for one being watched. A reconnect is a new socket, and the server knows nothing about it yet.
        reportPresence();
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
    reportPresence();
});

// The server cannot see whether this window is in front of the user, and it has to know: a session that finishes
// while nobody is looking is the one worth an alert, and until this is reported an open socket looks like a pair
// of eyes. Hidden and unfocused both count as away - a window behind another browser tab and a window behind an
// editor are the same thing from here. Coming back is a visit, so the server spends the alert on whatever this
// window is driving.
function reportPresence() {
    sendFrame({ t: "away", on: document.visibilityState === "hidden" || !document.hasFocus() });
}

window.addEventListener("focus", reportPresence);
window.addEventListener("blur", reportPresence);

function onFrame(msg) {
    // Any frame at all proves the socket works, which is what a wake probe is waiting to hear.
    if (probeTimer) {
        clearTimeout(probeTimer);
        probeTimer = null;
    }
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
        attachedSid = msg.sid;
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
        attachedSid = null;
        takenCard(msg.sid);
        refreshComposer();
    } else if (msg.t === "exit") {
        if (msg.sid === attachedSid) {
            attachedSid = null;
            // The box was holding an unsent message for a conversation that no longer exists.
            clearComposer();
            term.write(`\r\n\x1b[90m[webterm] ${agentName} exited, so this session is gone.\x1b[0m\r\n`);
            shownSid = null;
            shownMessage = EXITED_SCREEN;
        }
        dropDraft(msg.sid);
        refreshComposer();
    } else if (msg.t === "stopping") {
        // Sent to every window, not just the one that asked: the container is about to take them all.
        stoppingCurtain();
    } else if (msg.t === "error") {
        if (msg.code === "cap") capCard();
        else if (msg.code === "cwd") badDirCard();
        else if (msg.code === "stop") {
            // The container is still here after all, so the page goes back to being usable.
            halted = false;
            hideCurtain();
            stopFailedCard();
        } else noteMsg(`could not start ${agentName} - check the webterm log in the container`, true);
    }
}

function applySessions(msg) {
    sessions = Array.isArray(msg.list) ? msg.list : [];
    attachedSid = msg.attachedSid ?? null;
    maxSessions = msg.max ?? maxSessions;
    agentName = msg.agent || agentName;
    workspaceName = msg.workspace || "";
    defaultCwd = msg.defaultCwd ?? "";
    // Before the bar draws: its flash reads these timestamps, so an alert plays once instead of on every frame.
    noteArrivals();
    renderBar();
    // Said again where a window that is behind something else can still be heard.
    refreshBrowserTab();
    // Sessions that are no longer in the bar take their unsent messages with them.
    pruneDrafts();
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
        ? `No sessions. Use "+ New session" above to start ${agentName}.`
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

// --- Composer ----------------------------------------------------------------------------------------------------------------------------

// Connection and attachment state show on the composer's border and in its placeholder rather than a
// separate status line: lit in the workspace colour when keystrokes have somewhere to go, grey when they do
// not, with the reason in the placeholder.
const INPUT_PLACEHOLDER = "Type a message. Paste or drop an image. Enter sends, Shift+Enter for a newline.";

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
input.addEventListener("input", () => {
    autoGrow();
    // Kept up to date as you type, so a reload mid-sentence or a session taken away in another window does
    // not lose it. The write itself is debounced.
    captureDraft(attachedSid);
    schedulePersist();
});

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

// Empty the box, and the image tokens with it: a token whose text is gone points at nothing.
function clearComposer() {
    input.value = "";
    pendingImages.clear();
    imageCounter = 0;
    autoGrow();
}

// --- Per-session drafts ------------------------------------------------------------------------------------------------------------------
//
// A half-written message belongs to the conversation it was written for, so the box is swapped when you
// switch tabs and emptied when the session ends. Three things move together: the text, the image tokens in
// it, and the counter those tokens come from - a token only means something next to the map that expands it,
// so one shared map would let [Image #1] in one session resolve to another session's file.
//
// The draft is this window's. It survives a switch, a reload and a reconnect after sleep (sessionStorage,
// where the last attached session is already remembered), but it does not follow the session into another
// browser window: an unsent message stays where it was typed.

const DRAFTS_KEY = "webterm-drafts";
// How long after the last keystroke the drafts reach storage. Every switch, send and close writes at once,
// so this only covers reloading mid-sentence.
const DRAFT_PERSIST_MS = 500;

// sid -> { text, images: [[token, path], ...], counter }. Images are pairs rather than a Map so a draft is
// plain JSON.
const drafts = new Map();
let draftTimer = null;

function persistDrafts() {
    if (draftTimer) {
        clearTimeout(draftTimer);
        draftTimer = null;
    }
    try {
        sessionStorage.setItem(DRAFTS_KEY, JSON.stringify([...drafts]));
    } catch {
        // A disabled or full store must not break typing; the drafts still work for this page's lifetime.
    }
}

function schedulePersist() {
    if (draftTimer) return;
    draftTimer = setTimeout(() => {
        draftTimer = null;
        persistDrafts();
    }, DRAFT_PERSIST_MS);
}

// Storage is a convenience: anything unreadable or malformed just means the composer starts empty.
try {
    const stored = JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? "[]");
    if (Array.isArray(stored)) {
        for (const pair of stored) {
            const [sid, draft] = Array.isArray(pair) ? pair : [];
            if (typeof sid === "string" && draft && typeof draft.text === "string") drafts.set(sid, draft);
        }
    }
} catch {
    // Nothing to restore.
}

// A reload keeps what was typed rather than eating it, including the last few keystrokes.
window.addEventListener("pagehide", persistDrafts);

// The composer as it stands now, stored under the session it was typed for. An empty box stores nothing, so
// clicking through sessions does not pile up empty drafts. Callers decide whether the write is urgent.
function captureDraft(sid) {
    if (!sid) return;
    if (input.value) drafts.set(sid, { text: input.value, images: [...pendingImages], counter: imageCounter });
    else drafts.delete(sid);
}

function restoreDraft(sid) {
    const draft = drafts.get(sid);
    input.value = draft?.text ?? "";
    pendingImages.clear();
    for (const [token, path] of draft?.images ?? []) pendingImages.set(token, path);
    imageCounter = draft?.counter ?? 0;
    autoGrow();
}

// The session is gone, so its unsent message goes with it.
function dropDraft(sid) {
    if (sid && drafts.delete(sid)) persistDrafts();
}

// A session that is no longer in the bar took its draft with it. This is what covers a session closed from
// another window, which arrives as a bar without it rather than as an exit.
function pruneDrafts() {
    if (drafts.size === 0) return;
    const live = new Set(sessions.map((session) => session.id));
    let removed = false;
    for (const sid of [...drafts.keys()]) {
        if (!live.has(sid)) {
            drafts.delete(sid);
            removed = true;
        }
    }
    if (removed) persistDrafts();
}

// The window moved on before an upload finished. The token still belongs to the session the image was
// attached to, so it goes onto that session's draft, numbered by that draft's own counter.
function addImageToDraft(sid, path) {
    const draft = drafts.get(sid) ?? { text: "", images: [], counter: 0 };
    const counter = draft.counter + 1;
    const token = `[Image #${counter}]`;
    const lead = draft.text && !draft.text.endsWith(" ") && !draft.text.endsWith("\n") ? " " : "";
    drafts.set(sid, { text: `${draft.text}${lead}${token} `, images: [...draft.images, [token, path]], counter });
    persistDrafts();
    noteMsg(`image added to ${labelOf(sid, "the session it was attached to")}`);
}

// --- Images ------------------------------------------------------------------------------------------------------------------------------

// Upload one image blob; on success insert a friendly [Image #N] token inline where the caret was,
// and remember which container path it maps to.
async function uploadImage(blob) {
    // The upload is async: the caret can move and the window can switch sessions before it lands, so both
    // are read now and the token goes where the image was actually attached.
    const sid = attachedSid;
    const at = input.selectionStart ?? input.value.length;
    try {
        const res = await fetch(`/upload${KEY_QUERY}`, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (sid && sid !== attachedSid) {
            addImageToDraft(sid, data.path);
            return;
        }
        const token = `[Image #${++imageCounter}]`;
        pendingImages.set(token, data.path);
        input.setSelectionRange(at, at);
        insertAtCursor(token);
        captureDraft(attachedSid);
        persistDrafts();
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

    const sid = attachedSid;
    clearComposer();
    dropDraft(sid);
    term.focus();
}

sendBtn.addEventListener("click", send);

// Enter sends; Shift+Enter inserts a newline. Ctrl+C clears the composer (when nothing is selected,
// so a real copy still works), mirroring claude's "Ctrl+C clears the input line" behavior.
input.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
        if (input.selectionStart === input.selectionEnd) {
            e.preventDefault();
            clearComposer();
            dropDraft(attachedSid);
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
        // Only a file drag is ours. Without this the composer accepts any drag at all - including a session
        // tab on its way along the bar, which would end as a drop on the box instead of a reorder.
        if (!e.dataTransfer?.types?.includes("Files")) return;
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
//
// There is one clipboard - the machine's - and it changes only when the user copies something in the
// window they are looking at. Nothing else here may write it: not a screen being replayed, not a session
// running in the background. Anything less stops feeling like a clipboard.

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

function writeReplay(data) {
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
// The session dictation was started in. Recognition results arrive a moment after the speech, so a switch in
// between would otherwise drop a sentence meant for one agent into another one's box.
let dictationSid = null;

// Dictation is this window talking, not session state, so switching sessions ends it rather than carrying a
// half-finished transcript into the next conversation.
function stopDictation() {
    if (!recording || !recognition) return;
    try {
        recognition.stop();
    } catch {
        // Not running after all; onend clears the flag either way.
    }
}

if (!SpeechRecognition) {
    micBtn.disabled = true;
    micBtn.title = "Dictation not supported in this browser";
} else {
    recognition = new SpeechRecognition();
    recognition.interimResults = false;
    recognition.continuous = true;

    recognition.onresult = (e) => {
        // A result that outlived the session it was dictated for is dropped rather than misfiled.
        if (dictationSid && dictationSid !== attachedSid) return;
        let transcript = "";
        for (let i = e.resultIndex; i < e.results.length; i++) transcript += e.results[i][0].transcript;
        if (!transcript) return;
        insertAtCursor(transcript.trim());
        captureDraft(attachedSid);
        schedulePersist();
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
        dictationSid = null;
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
            dictationSid = attachedSid;
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
// Before the first frame arrives, so the icon carries this workspace's frame from the moment the page loads.
refreshBrowserTab();
connect();
term.focus();
