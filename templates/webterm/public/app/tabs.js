// tabs.js - the session bar, which is mission control for this container.
//
// Every live agent in the container is a tab, this window drives one of them at a time, and none of them ends
// because a window closed or a laptop slept. Tabs are dragged to reorder them, and the order is the registry's,
// so every window agrees on it. A tab also says what its session is doing without being opened: a light travels
// round it while the agent works, and it holds lit until visited when an agent finished something nobody was
// there to see.
//
// The bar is rebuilt from scratch on every frame the server sends and on the age tick, so nothing in it is
// updated in place and nothing outside it may keep a reference to a tab.

import { bellButton, forgetChime } from "./alerts.js";
import { closeCard, stopCard } from "./cards.js";
import { sendFrame } from "./connection.js";
import { SVG_NS, tabbar } from "./dom.js";
import { repositionNewPop, toggleNewPop } from "./new-session.js";
import { agents, attachedSid, defaultAgent, defaultCwd, maxSessions, sessions, workspaceName } from "./state.js";
import { focusTerminal, term } from "./terminal.js";
import { colorFor } from "./theme.js";

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

// --- How old a session is ----------------------------------------------------------------------------------------------------------------

// How often the ages on the session tabs are redrawn. Age is what makes a session parked for a week
// obvious, so it has to keep up without being a per-second timer.
const AGE_TICK_MS = 60_000;

export function ageLabel(createdAt) {
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
// mid-drag and an alert that arrives then must still be able to flash. The chime reads the same stamps: an
// alert that is still standing a few seconds after it appeared is one nobody has come back to.
export const arrivedAt = new Map();

export function noteArrivals() {
    for (const entry of sessions) {
        if (entry.attention && !arrivedAt.has(entry.id)) arrivedAt.set(entry.id, Date.now());
    }
    // A session that is no longer waiting (visited, or gone from the bar) may flash again next time it finishes.
    for (const sid of [...arrivedAt.keys()]) {
        if (sessions.some((entry) => entry.id === sid && entry.attention)) continue;
        arrivedAt.delete(sid);
        // And sound again: the next finish is a new alert, not the one that was just spent.
        forgetChime(sid);
    }
}

function startArrival(tab, sid) {
    const elapsed = Date.now() - (arrivedAt.get(sid) ?? Date.now());
    // Long past: the tab just holds its lit state, which is the part that waits for you.
    if (elapsed >= ARRIVAL_MS) return;
    tab.classList.add("arriving");
    tab.style.animationDelay = `-${elapsed}ms`;
}

// --- One tab -----------------------------------------------------------------------------------------------------------------------------

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
    if (entry.attention) return " - finished, and not looked at since";
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

// --- The two drawn buttons ---------------------------------------------------------------------------------------------------------------

// Ending the day: one button, and it always asks first. Drawn rather than written, because the bar is
// tabs and this is not one of them - and drawn here rather than shipped in the page, since the bar is
// rebuilt from scratch on every frame.
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

function chevronIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "13");
    svg.setAttribute("height", "13");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const down = document.createElementNS(SVG_NS, "path");
    down.setAttribute("d", "M6 9l6 6 6-6");
    svg.append(down);
    return svg;
}

// --- The bar -----------------------------------------------------------------------------------------------------------------------------

export function renderBar() {
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

    // A split button: the left half starts a session the usual way in one click, and the chevron opens the
    // panel that asks which agent and which directory. Neither moves the default - the panel starts this one
    // session differently.
    const group = document.createElement("div");
    group.id = "newtab-group";
    const atCap = sessions.length >= maxSessions;

    const add = document.createElement("button");
    add.id = "newtab";
    add.type = "button";
    add.textContent = "+ New session";
    add.title = `Start another ${defaultAgent} in this container, in ${whereLabel(defaultCwd)}`;
    add.disabled = atCap;
    add.addEventListener("click", () => sendFrame({ t: "new" }));

    const more = document.createElement("button");
    more.id = "newtab-more";
    more.type = "button";
    more.append(chevronIcon());
    more.title = agents.length > 1 ? "Start a session with another agent or in another directory" : "Start a session in another directory";
    more.setAttribute("aria-label", more.title);
    more.setAttribute("aria-haspopup", "dialog");
    more.disabled = atCap;
    more.addEventListener("click", toggleNewPop);

    group.append(add, more);
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
    right.append(bellButton(), stopButton());
    tabbar.append(right);

    // The panel hangs off the body, so it survives this rebuild - but the button under it just moved.
    repositionNewPop();

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
