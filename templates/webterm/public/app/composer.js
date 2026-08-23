// composer.js - the box under the terminal: a message written properly, and the images that go with it.
//
// What is in it belongs to the attached session (see drafts.js), and on Send the whole text goes as one paste
// frame the server wraps in bracketed-paste markers, so a multi-line message arrives as one message.

import { connected, everConnected, sendFrame } from "./connection.js";
import { attachBtn, fileInput, input, sendBtn } from "./dom.js";
import {
    addImageToDraft,
    atFirstLine,
    atLastLine,
    captureDraft,
    dropDraft,
    endHistoryWalk,
    historyAt,
    persistDrafts,
    rememberSent,
    schedulePersist,
    showRecalled,
    walkHistory,
} from "./drafts.js";
import { noteMsg } from "./note.js";
import { attachedSid, defaultAgent, KEY_QUERY, sessions } from "./state.js";
import { term } from "./terminal.js";

// Connection and attachment state show on the composer's border and in its placeholder rather than a
// separate status line: lit in the workspace colour when keystrokes have somewhere to go, grey when they do
// not, with the reason in the placeholder.
const INPUT_PLACEHOLDER = "Type a message. Paste or drop an image. Enter sends, Shift+Enter for a newline, Up recalls the last one.";

export function refreshComposer() {
    const live = connected && Boolean(attachedSid);
    input.classList.toggle("online", live);
    input.classList.toggle("waiting", !live);
    input.disabled = !live;
    if (!connected) input.placeholder = everConnected ? "Reconnecting... your session kept running." : "Connecting...";
    else if (live) input.placeholder = INPUT_PLACEHOLDER;
    else if (sessions.length === 0) input.placeholder = `No sessions. Use "+ New session" above to start ${defaultAgent}.`;
    else input.placeholder = "Pick a session above to type in it.";
}

export function autoGrow() {
    input.style.height = "auto";
    // Floor at the default height (112px, enough for the stacked buttons) so the box never shrinks
    // behind them; grow with content up to a cap.
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 112), 200)}px`;
}
input.addEventListener("input", () => {
    autoGrow();
    // A recalled message that has been edited is a new message, so the arrows stop stepping through history.
    endHistoryWalk();
    // Kept up to date as you type, so a reload mid-sentence or a session taken away in another window does
    // not lose it. The write itself is debounced.
    captureDraft(attachedSid);
    schedulePersist();
});

// Insert text into the composer at the current caret position (surrounded by spaces so a path
// does not fuse with adjacent words), then place the caret right after it.
export function insertAtCursor(text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const lead = before && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "";
    const trail = after && !after.startsWith(" ") && !after.startsWith("\n") ? " " : " ";
    const piece = lead + text + trail;
    // Attaching an image to a recalled message makes it a new message.
    endHistoryWalk();
    input.value = before + piece + after;
    const caret = before.length + piece.length;
    input.setSelectionRange(caret, caret);
    autoGrow();
    input.focus();
}

// A friendly placeholder token is shown in the composer for each attached image (like claude's own
// [Image #N]); the real container path is swapped in only at send time. Keyed by the visible token.
export const pendingImages = new Map();
export let imageCounter = 0;

// The counter belongs to the box, and a draft carries its own: switching sessions puts that session's counter
// back, so [Image #1] in one session can never resolve to another session's file.
export function setImageCounter(value) {
    imageCounter = value;
}

// Empty the box, and the image tokens with it: a token whose text is gone points at nothing.
export function clearComposer() {
    input.value = "";
    pendingImages.clear();
    imageCounter = 0;
    endHistoryWalk();
    autoGrow();
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

// --- Sending -----------------------------------------------------------------------------------------------------------------------------

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
    // Stored expanded, exactly as the agent received it, so recalling and sending again says the same thing.
    rememberSent(sid, text);
    clearComposer();
    dropDraft(sid);
    term.focus();
}

sendBtn.addEventListener("click", send);

// Enter sends; Shift+Enter inserts a newline. Ctrl+C clears the composer (when nothing is selected,
// so a real copy still works), mirroring claude's "Ctrl+C clears the input line" behavior.
// Up and Down walk back through what this session was already sent - see drafts.js for when they
// are a recall and when they are just the caret moving.
input.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
        if (input.selectionStart === input.selectionEnd) {
            e.preventDefault();
            clearComposer();
            dropDraft(attachedSid);
        }
        return;
    }
    const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.key === "ArrowUp" && plain) {
        // Only from the top of the box, and only into an empty one unless a walk is already under way.
        if (!atFirstLine()) return;
        if (historyAt === null && input.value !== "") return;
        if (walkHistory(true)) e.preventDefault();
        return;
    }
    if (e.key === "ArrowDown" && plain) {
        if (historyAt === null || !atLastLine()) return;
        if (walkHistory(false)) e.preventDefault();
        return;
    }
    // Escape puts the box back the way the walk found it: empty, and typing into it again.
    if (e.key === "Escape" && historyAt !== null) {
        e.preventDefault();
        endHistoryWalk();
        showRecalled("");
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
