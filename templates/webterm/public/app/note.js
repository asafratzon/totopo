// note.js - transient status, shown as a pill floating over the bottom of the terminal.
//
// It floats rather than sitting in the layout because it comes and goes constantly - a copy says so on every
// drag - and a line that appears and disappears in the flow shifts everything under it each time.

import { note } from "./dom.js";

// A plain note is gone quickly; an error stays long enough to be read and acted on.
const NOTE_MS = 2500;
const NOTE_ERROR_MS = 5000;

export function noteMsg(text, isError) {
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
