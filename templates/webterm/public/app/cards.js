// cards.js - the overlay cards.
//
// One card shape for every decision: a title, an explanation, and buttons. Each button closes the card and then
// runs its action, so no card can be left open over a terminal you are typing into. Cards are for questions the
// user did not go looking for - a confirmation, a refusal - which is why they sit in the middle of the screen;
// anything opened on purpose from the bar is a panel anchored to what opened it.

import { sendFrame } from "./connection.js";
import { card, overlay } from "./dom.js";
import { agents, labelOf, maxSessions, sessions } from "./state.js";
import { ageLabel } from "./tabs.js";

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

// Asked when this window tries to open a session another window is driving.
export function takeoverCard(sid) {
    showCard(
        `${labelOf(sid, "That session")} is open in another browser window`,
        "A terminal has one size, so only one window drives a session at a time. Switching here disconnects the other " +
            "window - it keeps the conversation on screen and can take it back with one click.",
        [{ label: "Cancel" }, { label: "Switch to this window", kind: "primary", run: () => sendFrame({ t: "takeover", sid }) }],
    );
}

// Shown to the window that just lost a session to another one.
export function takenCard(sid) {
    showCard(
        `${labelOf(sid, "This session")} was taken over in another window`,
        "Nothing was lost: the conversation is still running, and the screen below is where it was. Take it back whenever you want.",
        [{ label: "Stay here" }, { label: "Take it back", kind: "primary", run: () => sendFrame({ t: "takeover", sid }) }],
    );
}

// The only close a user can ask for, so it names what dies and how long it has been alive.
export function closeCard(entry) {
    showCard(
        `End ${entry.label}?`,
        `The ${entry.agent} process is killed and this conversation stops. Sessions are never closed for you - ` +
            `this one has been running ${ageLabel(entry.createdAt)}.`,
        [{ label: "Cancel" }, { label: "End session", kind: "danger", run: () => sendFrame({ t: "close", sid: entry.id }) }],
    );
}

// The server refused the path, so nothing was started. It does not say which path back: the user just typed
// it, and the rule is what they need.
export function badDirCard() {
    showCard(
        "That directory is not in the workspace",
        "Nothing was started. The path has to be a directory that already exists inside the workspace - written " +
            'relative to its root, like "packages/api".',
        [{ label: "Got it", kind: "primary" }],
    );
}

// The server was asked for an agent it does not run. Only reachable from a stale page or a hand-made frame -
// the menu is built from what the server said it runs - so it says the rule and nothing more.
export function badAgentCard() {
    showCard(
        "That is not an agent this container runs",
        `Nothing was started. This interface runs ${agents.join(", ")}. Reload the page if the list above looks wrong.`,
        [{ label: "Got it", kind: "primary" }],
    );
}

export function capCard() {
    showCard(
        `${maxSessions} sessions is the limit`,
        "Each live agent holds a few hundred MB in the container, so the limit keeps one workspace from eating your " +
            "memory. End a session you are done with and this one will start.",
        [{ label: "Got it", kind: "primary" }],
    );
}

// Asked before the container goes down, because it takes everything with it - the browser sessions here,
// and any terminal session open in the same container.
export function stopCard() {
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
export function stopFailedCard() {
    showCard(
        "The container did not stop",
        "This container was created before totopo could stop one from the browser. Stop it from the host instead - " +
            "npx totopo, or docker stop - and the next container it creates will take the button.",
        [{ label: "Got it", kind: "primary" }],
    );
}
