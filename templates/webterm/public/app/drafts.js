// drafts.js - the two stores this window keeps per session: what has not been sent, and what already was.
//
// Both belong to the browser window rather than to the container, both are keyed by session id, and both go
// when their session does - so they are one module and share the pruning that ends them.

import { autoGrow, imageCounter, pendingImages, setImageCounter } from "./composer.js";
import { input } from "./dom.js";
import { noteMsg } from "./note.js";
import { attachedSid, labelOf, sessions } from "./state.js";

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

export function persistDrafts() {
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

export function schedulePersist() {
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
export function captureDraft(sid) {
    if (!sid) return;
    if (input.value) drafts.set(sid, { text: input.value, images: [...pendingImages], counter: imageCounter });
    else drafts.delete(sid);
}

export function restoreDraft(sid) {
    const draft = drafts.get(sid);
    input.value = draft?.text ?? "";
    pendingImages.clear();
    for (const [token, path] of draft?.images ?? []) pendingImages.set(token, path);
    setImageCounter(draft?.counter ?? 0);
    // Each session has its own history, so a walk never carries across a switch.
    endHistoryWalk();
    autoGrow();
}

// The session is gone, so its unsent message goes with it.
export function dropDraft(sid) {
    if (sid && drafts.delete(sid)) persistDrafts();
}

// Drop everything this window is holding for a session that is no longer in the bar, and say whether anything went.
// Shared by the two stores kept per session - the unsent message and the history below - because both end the same
// way at the same moment. This is what covers a session closed from another window, which arrives as a bar without
// it rather than as an exit.
function pruneBySession(store) {
    if (store.size === 0) return false;
    const live = new Set(sessions.map((session) => session.id));
    let removed = false;
    for (const sid of [...store.keys()]) {
        if (live.has(sid)) continue;
        store.delete(sid);
        removed = true;
    }
    return removed;
}

export function pruneDrafts() {
    if (pruneBySession(drafts)) persistDrafts();
}

// The window moved on before an upload finished. The token still belongs to the session the image was
// attached to, so it goes onto that session's draft, numbered by that draft's own counter.
export function addImageToDraft(sid, path) {
    const draft = drafts.get(sid) ?? { text: "", images: [], counter: 0 };
    const counter = draft.counter + 1;
    const token = `[Image #${counter}]`;
    const lead = draft.text && !draft.text.endsWith(" ") && !draft.text.endsWith("\n") ? " " : "";
    drafts.set(sid, { text: `${draft.text}${lead}${token} `, images: [...draft.images, [token, path]], counter });
    persistDrafts();
    noteMsg(`image added to ${labelOf(sid, "the session it was attached to")}`);
}

// --- What you already sent ---------------------------------------------------------------------------------------------------------------
//
// Up in an empty box brings back the last message, the way a shell does. The composer exists so a long message can be
// written properly, and the messages worth having back are exactly the long ones: a prompt that needed one more
// sentence, a path that was almost right, a question worth asking again of a different session.
//
// Two rules keep it out of the way of ordinary typing. It only starts from an empty box, so Up can never snatch away
// something half-written. And once it has started, Up and Down only step on from the first and last line of what is
// showing, so the arrows still walk around a recalled message the way they walk around any other text - a shell with
// a multi-line buffer behaves the same, and anything else is a trap. Typing ends the walk: what is in the box is
// yours again, and the arrows go back to being arrows.
//
// What is stored is what was actually sent, image tokens already expanded. A recalled message has to mean the same
// thing the second time, and [Image #1] means nothing once the box that numbered it has been emptied.
//
// The history is this window's, like the drafts above, and it holds what went through this box - not what was typed
// straight into the terminal, which the agent's own history already has.

const HISTORY_KEY = "webterm-history";
// Long enough to cover a working session, short enough that this never becomes somewhere data quietly accumulates.
const HISTORY_MAX = 50;

// sid -> [oldest, ..., newest].
const histories = new Map();
// How far back the walk has got in the attached session's history, or null when the box holds the user's own text.
export let historyAt = null;

function persistHistory() {
    try {
        sessionStorage.setItem(HISTORY_KEY, JSON.stringify([...histories]));
    } catch {
        // Storage that will not take it costs the recall after a reload and nothing else.
    }
}

try {
    const stored = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? "[]");
    if (Array.isArray(stored)) {
        for (const pair of stored) {
            const [sid, list] = Array.isArray(pair) ? pair : [];
            if (typeof sid !== "string" || !Array.isArray(list)) continue;
            histories.set(
                sid,
                list.filter((line) => typeof line === "string"),
            );
        }
    }
} catch {
    // Nothing to recall.
}

window.addEventListener("pagehide", persistHistory);

// The same message twice running is one entry: sending something again is normal, and a history filled with it is
// not worth walking through.
export function rememberSent(sid, text) {
    if (!sid || !text) return;
    const list = histories.get(sid) ?? [];
    if (list[list.length - 1] !== text) list.push(text);
    while (list.length > HISTORY_MAX) list.shift();
    histories.set(sid, list);
    persistHistory();
}

// The session is gone, and everything said to it goes too.
export function dropHistory(sid) {
    if (sid && histories.delete(sid)) persistHistory();
}

export function pruneHistory() {
    if (pruneBySession(histories)) persistHistory();
}

// Where the caret is, in lines. The arrows only reach for history from the edges of what is in the box.
export function atFirstLine() {
    return !input.value.slice(0, input.selectionStart ?? 0).includes("\n");
}

export function atLastLine() {
    return !input.value.slice(input.selectionEnd ?? input.value.length).includes("\n");
}

// Put an entry in the box, caret at the end of it - which is where you carry on typing from. It becomes the session's
// draft like anything else in the box, so switching away and back does not lose a message you went and fetched.
export function showRecalled(text) {
    input.value = text;
    autoGrow();
    const end = input.value.length;
    input.setSelectionRange(end, end);
    captureDraft(attachedSid);
    schedulePersist();
}

// Typing makes the box yours again.
export function endHistoryWalk() {
    historyAt = null;
}

// One step through the attached session's history; `back` is Up. Says whether it moved, so a step that had nowhere
// to go leaves the keypress to the browser instead of swallowing it.
export function walkHistory(back) {
    const list = histories.get(attachedSid) ?? [];
    if (list.length === 0) return false;
    if (back) {
        // The oldest entry is the end of the road rather than a wrap back to the newest: a list that loops has no
        // end, and you would never know you had seen all of it.
        historyAt = historyAt === null ? list.length - 1 : Math.max(0, historyAt - 1);
        showRecalled(list[historyAt]);
        return true;
    }
    if (historyAt === null) return false;
    // Forward past the newest is the empty box the walk started from, not the newest all over again.
    if (historyAt >= list.length - 1) {
        endHistoryWalk();
        showRecalled("");
        return true;
    }
    historyAt += 1;
    showRecalled(list[historyAt]);
    return true;
}
