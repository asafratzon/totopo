// new-session.js - what the next session should be.
//
// Two things make a session and neither can be changed later: which agent runs, and where it runs. One server runs
// every agent it knows, one per session, so the bar can hold claude and codex side by side, each in its own directory.
//
// So both are asked in one panel rather than one control each. Two controls could not be combined - "codex, over
// there" was not sayable - and the pair of them made the bar read like a toolbar for something that is really one
// question. The plain button still answers it the usual way in one click; the chevron beside it is where the question
// gets asked in full, and neither moves the default. `webterm <agent>` in the container is what moves that.
//
// It is anchored under the button rather than shown as a card in the middle of the screen: this is the one panel that
// opens on the way to something routine, and a centred card would send the pointer across the window and back for a
// choice that is usually two clicks. It hangs off the body all the same, because the bar is rebuilt from scratch on
// every frame and on the age tick, which would take the open panel with it.
//
// Nothing typed here is trusted: the server resolves whatever path arrives and refuses what is not a directory in the
// workspace, and it refuses an agent it does not run.

import { sendFrame } from "./connection.js";
import { noteMsg } from "./note.js";
import { agents, defaultAgent, defaultCwd, KEY_QUERY } from "./state.js";
import { focusTerminal } from "./terminal.js";

const DIR_LIST_ID = "dirlist";

let newPopEl = null;

function closeNewPop() {
    if (!newPopEl) return;
    newPopEl.remove();
    newPopEl = null;
    document.removeEventListener("pointerdown", onNewPopOutside, true);
}

// Put an open panel back under its button after the bar was rebuilt. A frame arrives whenever anything in the
// container moves, and a panel that closed itself every time one did would be unusable; a button that is gone
// (the session limit) takes it with it. Clamped to the window, since the bar can be scrolled far to the right.
export function repositionNewPop() {
    if (!newPopEl) return;
    const anchor = document.getElementById("newtab-more");
    if (!anchor) {
        closeNewPop();
        return;
    }
    const box = anchor.getBoundingClientRect();
    const width = newPopEl.offsetWidth;
    const left = Math.min(box.right - width, window.innerWidth - width - 8);
    newPopEl.style.top = `${Math.round(box.bottom + 6)}px`;
    newPopEl.style.left = `${Math.round(Math.max(8, left))}px`;
}

function onNewPopOutside(event) {
    // The button itself is left alone: its own click handler toggles, and closing here first would reopen it.
    if (newPopEl?.contains(event.target) || event.target.closest?.("#newtab-more")) return;
    closeNewPop();
}

// Fill the picker's suggestions from the container. Fetched when the panel opens rather than kept around, so
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
    // The panel may have been closed while this was in flight.
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

// The agent half: one chip per agent, the usual one already chosen, so the panel can be opened for the directory
// alone and closed with Enter. A container that runs a single agent has nothing to ask and gets no row.
function agentRow(state) {
    const row = document.createElement("div");
    row.className = "agentrow";
    row.setAttribute("role", "radiogroup");
    row.setAttribute("aria-label", "Agent for the new session");
    for (const name of agents) {
        const choice = document.createElement("button");
        choice.type = "button";
        choice.className = "agentchoice";
        choice.textContent = name;
        choice.setAttribute("role", "radio");
        choice.setAttribute("aria-checked", String(name === state.agent));
        choice.classList.toggle("chosen", name === state.agent);
        choice.addEventListener("click", () => {
            state.agent = name;
            for (const other of row.children) {
                const on = other.textContent === name;
                other.classList.toggle("chosen", on);
                other.setAttribute("aria-checked", String(on));
            }
        });
        row.append(choice);
    }
    return row;
}

function popLabel(text) {
    const label = document.createElement("span");
    label.className = "poplabel";
    label.textContent = text;
    return label;
}

export function toggleNewPop() {
    if (newPopEl) {
        closeNewPop();
        return;
    }
    const state = { agent: defaultAgent };
    const pop = document.createElement("div");
    pop.id = "newpop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Start a session");

    if (agents.length > 1) pop.append(popLabel("Agent"), agentRow(state));

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
    pop.append(popLabel("Directory"), field, list);

    const start = () => {
        closeNewPop();
        sendFrame({ t: "new", cwd: field.value.trim(), agent: state.agent });
    };
    const row = document.createElement("div");
    row.className = "poprow";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
        closeNewPop();
        focusTerminal();
    });
    const go = document.createElement("button");
    go.type = "button";
    go.className = "btn primary";
    go.textContent = "Start session";
    go.addEventListener("click", start);
    row.append(cancel, go);
    pop.append(row);

    field.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        start();
    });

    document.body.append(pop);
    newPopEl = pop;
    repositionNewPop();
    field.focus();
    field.select();
    fillDirList(list);
    // Capture, so a click on a tab closes this before that tab switches session.
    document.addEventListener("pointerdown", onNewPopOutside, true);
}

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !newPopEl) return;
    closeNewPop();
    focusTerminal();
});
