import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { pathToFileURL } from "node:url";

// The registry ships inside the image as plain JS (the container runs it with the baked node-pty), so it
// is loaded here the same way the server loads it. The PTY is injected, which is what makes it testable:
// no node-pty on the host, and no real agent processes started by the test run.
const WEBTERM_DIR = join(import.meta.dirname, "..", "templates", "webterm");

type Registry = {
    away: (client: FakeSocket, isAway: boolean) => void;
    tick: () => void;
    typed: (sid: string) => void;
    attach: (sid: string, client: FakeSocket) => "attached" | "busy" | "gone";
    attachedCount: () => number;
    attachedSid: (client: FakeSocket) => string | null;
    close: (sid: string) => boolean;
    count: () => number;
    create: () => { ok: true; session: Session } | { ok: false; error: string };
    detach: (client: FakeSocket) => void;
    get: (sid: string) => Session | undefined;
    list: () => WireEntry[];
    pickForClient: (client: FakeSocket, wantSid?: string) => string | null;
    rename: (sid: string, rawName: string) => boolean;
    reorder: (sid: string, index: number) => boolean;
    sessionFor: (client: FakeSocket) => Session | undefined;
    takeover: (sid: string, client: FakeSocket) => "attached" | "gone";
};
type Session = { id: string; label: string; name: string | null; colorIndex: number; buffer: string; term: FakeTerm };
type WireEntry = {
    id: string;
    label: string;
    name: string | null;
    colorIndex: number;
    createdAt: number;
    attached: boolean;
    unread: boolean;
    working: boolean;
    attention: boolean;
};
type Event = { t: string; sid?: string; client?: FakeSocket; data?: string; label?: string };

const { createRegistry, PALETTE_SIZE, MAX_NAME_LENGTH, cleanName, WORK_QUIET_MS, WORK_WARMUP_MS, WORK_TICK_MS, ECHO_MS, MIN_WORK_MS } =
    (await import(pathToFileURL(join(WEBTERM_DIR, "sessions.js")).href)) as {
        createRegistry: (options: {
            spawn: () => FakeTerm;
            maxSessions: number;
            maxBuffer: number;
            onEvent: (event: Event) => void;
        }) => Registry;
        PALETTE_SIZE: number;
        MAX_NAME_LENGTH: number;
        cleanName: (raw: unknown) => string | null;
        WORK_QUIET_MS: number;
        WORK_WARMUP_MS: number;
        WORK_TICK_MS: number;
        ECHO_MS: number;
        MIN_WORK_MS: number;
    };

// A browser window: the registry only ever asks whether its socket is still open (1 = WebSocket.OPEN).
class FakeSocket {
    readyState = 1;
    die() {
        this.readyState = 3;
    }
}

// A PTY that records what it was told, so a test can assert a kill happened - or, more importantly, did not.
class FakeTerm {
    killed = false;
    written: string[] = [];
    #data: (chunk: string) => void = () => {};
    #exit: () => void = () => {};

    onData(fn: (chunk: string) => void) {
        this.#data = fn;
    }
    onExit(fn: () => void) {
        this.#exit = fn;
    }
    write(chunk: string) {
        this.written.push(chunk);
    }
    resize() {}
    kill() {
        this.killed = true;
    }

    /** The agent printed something. */
    say(chunk: string) {
        this.#data(chunk);
    }
    /** The agent exited on its own (/exit, a crash). */
    quit() {
        this.#exit();
    }
}

function setup(maxSessions = 8) {
    const events: Event[] = [];
    const terms: FakeTerm[] = [];
    const registry = createRegistry({
        spawn: () => {
            const term = new FakeTerm();
            terms.push(term);
            return term;
        },
        maxSessions,
        maxBuffer: 64,
        onEvent: (event) => events.push(event),
    });
    return { events, registry, terms };
}

// Create a session and fail loudly rather than returning a union the tests would have to narrow.
function start(registry: Registry): Session {
    const created = registry.create();
    assert.ok(created.ok, "create() should have succeeded here");
    return created.session;
}

function entryFor(registry: Registry, sid: string): WireEntry {
    const entry = registry.list().find((e) => e.id === sid);
    assert.ok(entry, `session ${sid} should be in the list`);
    return entry;
}

// ---- Persistence: what does and does not end a session ----------------------------------------------------------------------------------
// This is the whole point of the session model. A closed browser, dropped wifi and a slept laptop are
// indistinguishable from the server, so none of them may end a conversation.

describe("a session outlives the browser", () => {
    test("a window going away leaves the agent running and buffering", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, window);

        registry.detach(window);

        assert.equal(session.term.killed, false, "the agent must not be killed because a browser went away");
        assert.equal(registry.count(), 1);
        assert.equal(registry.attachedCount(), 0, "but nothing is watching it");
        assert.equal(entryFor(registry, session.id).attached, false);
    });

    test("what the agent said while nobody watched is replayed on the next connect", () => {
        const { events, registry } = setup();
        const first = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, first);
        registry.detach(first);

        session.term.say("what is 2+2?");

        const later = new FakeSocket();
        assert.equal(registry.attach(session.id, later), "attached");
        const replay = events.filter((e) => e.t === "replay").at(-1);
        assert.equal(replay?.client, later);
        assert.equal(replay?.data, "what is 2+2?", "the question asked before the laptop slept is still there");
    });

    test("the replay buffer keeps the tail once it is full", () => {
        const { events, registry } = setup();
        const session = start(registry);
        session.term.say("x".repeat(60));
        session.term.say("TAIL");

        registry.attach(session.id, new FakeSocket());

        const replay = events.filter((e) => e.t === "replay").at(-1);
        assert.equal(replay?.data?.length, 64, "buffer must be capped at maxBuffer");
        assert.ok(replay?.data?.endsWith("TAIL"), "and it is the newest output that is kept");
    });

    test("an explicit close ends exactly one session and kills only its agent", () => {
        const { registry } = setup();
        const one = start(registry);
        const two = start(registry);

        assert.equal(registry.close(one.id), true);

        assert.equal(one.term.killed, true);
        assert.equal(two.term.killed, false);
        assert.equal(registry.count(), 1);
        assert.equal(registry.get(one.id), undefined);
        assert.equal(registry.close(one.id), false, "closing it twice is not an error, just nothing to do");
    });

    test("closing does not report the session as having exited on its own", () => {
        const { events, registry } = setup();
        const session = start(registry);
        registry.close(session.id);
        // The PTY's own exit callback fires after the kill; the registry has to stay quiet, or the browser
        // would print "claude exited" for a session the user closed on purpose.
        session.term.quit();

        assert.equal(events.filter((e) => e.t === "exit").length, 0, "a deliberate close must not look like the agent quitting");
        assert.equal(registry.count(), 0);
    });

    test("an agent that exits takes its own session away and says so", () => {
        const { events, registry } = setup();
        const session = start(registry);

        session.term.quit();

        assert.equal(registry.count(), 0);
        const exited = events.find((e) => e.t === "exit");
        assert.equal(exited?.sid, session.id);
        assert.equal(exited?.label, "Agent 1", "the log line names the session, so the label travels with the event");
    });
});

// ---- Where a close leaves you -----------------------------------------------------------------------------------------------------------
// Closing the session you are in should land you on its neighbour, the way closing a browser tab does -
// not on a dead screen. The registry does not know which window asked, so this also covers the case where
// another window closes the session you were watching.

describe("closing moves the window that was driving it", () => {
    test("to the next session along", () => {
        const { events, registry } = setup();
        const window = new FakeSocket();
        const first = start(registry);
        const second = start(registry);
        start(registry);
        registry.attach(second.id, window);
        events.length = 0;

        registry.close(second.id);

        assert.equal(registry.attachedSid(window), registry.list()[1]?.id, "the tab that was to its right");
        assert.notEqual(registry.attachedSid(window), first.id);
        const replay = events.find((e) => e.t === "replay");
        assert.equal(replay?.client, window, "and the window is sent that session's screen");
    });

    test("to the previous one when the closed session was the last", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const first = start(registry);
        const last = start(registry);
        registry.attach(last.id, window);

        registry.close(last.id);

        assert.equal(registry.attachedSid(window), first.id);
    });

    test("skipping any session another window is watching", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const free = start(registry);
        const mine = start(registry);
        const theirs = start(registry);
        registry.attach(mine.id, window);
        registry.attach(theirs.id, new FakeSocket());

        registry.close(mine.id);

        // The one to the right is taken, so it falls back to the left rather than prompting a takeover.
        assert.equal(registry.attachedSid(window), free.id);
    });

    test("and leaves it where it is when some other session was closed", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const mine = start(registry);
        const other = start(registry);
        registry.attach(mine.id, window);

        registry.close(other.id);

        assert.equal(registry.attachedSid(window), mine.id, "closing a background session must not move you");
    });

    test("nowhere when that was the only session", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const only = start(registry);
        registry.attach(only.id, window);

        registry.close(only.id);

        assert.equal(registry.attachedSid(window), null);
        assert.equal(registry.count(), 0);
    });

    test("nowhere when every session that is left is driven from another window", () => {
        const { events, registry } = setup();
        const window = new FakeSocket();
        const theirs = start(registry);
        const mine = start(registry);
        registry.attach(theirs.id, new FakeSocket());
        registry.attach(mine.id, window);
        events.length = 0;

        registry.close(mine.id);

        // Nothing is taken from the other window, so this one is left holding no session - which the page has to
        // show, because the screen it is still displaying belongs to the session that was just closed.
        assert.equal(registry.attachedSid(window), null);
        assert.equal(events.filter((e) => e.t === "replay").length, 0, "no session to replay into it");
        assert.ok(
            events.some((e) => e.t === "changed"),
            "the bar still has to be redrawn",
        );
    });

    test("nowhere when the window that was driving it is gone", () => {
        const { events, registry } = setup();
        const gone = new FakeSocket();
        const session = start(registry);
        start(registry);
        registry.attach(session.id, gone);
        gone.die();
        events.length = 0;

        registry.close(session.id);

        assert.equal(events.filter((e) => e.t === "replay").length, 0, "nothing to send to a socket that is gone");
        assert.equal(registry.attachedCount(), 0);
    });
});

// ---- The cap ----------------------------------------------------------------------------------------------------------------------------

describe("the session cap", () => {
    test("refuses past the limit, and lets a close make room again", () => {
        const { registry } = setup(3);
        const first = start(registry);
        start(registry);
        start(registry);

        const refused = registry.create();
        assert.deepEqual(refused, { ok: false, error: "cap" });
        assert.equal(registry.count(), 3, "a refused create must not spawn anything");

        registry.close(first.id);
        assert.ok(registry.create().ok, "one closed session frees one slot");
    });
});

// ---- Labels and colours -----------------------------------------------------------------------------------------------------------------

describe("labels and colours follow one counter", () => {
    test("numbers count up, colours rotate through the palette", () => {
        const { registry } = setup(PALETTE_SIZE + 2);
        const sessions = Array.from({ length: PALETTE_SIZE + 2 }, () => start(registry));

        assert.deepEqual(
            sessions.map((s) => s.label),
            Array.from({ length: PALETTE_SIZE + 2 }, (_, i) => `Agent ${i + 1}`),
        );
        assert.deepEqual(
            sessions.map((s) => s.colorIndex),
            Array.from({ length: PALETTE_SIZE + 2 }, (_, i) => i % PALETTE_SIZE),
        );
    });

    test("a number is never reused, so a label always means the same session", () => {
        const { registry } = setup();
        const first = start(registry);
        registry.close(first.id);

        assert.equal(start(registry).label, "Agent 2", "the next session is 2, not 1 again");
    });
});

// ---- Renaming a session -----------------------------------------------------------------------------------------------------------------
// A user-chosen name replaces the "claude N" label so a long-lived conversation reads by what it is about.
// The default label is always kept underneath, so clearing the name brings the number back.

describe("renaming a session", () => {
    test("sets a name the whole list can see, and tells every window", () => {
        const { events, registry } = setup();
        const session = start(registry);
        events.length = 0;

        assert.equal(registry.rename(session.id, "refactor auth"), true);

        assert.equal(entryFor(registry, session.id).name, "refactor auth");
        assert.equal(entryFor(registry, session.id).label, "Agent 1", "the default label stays, so the number is still there");
        assert.equal(events.filter((e) => e.t === "changed").length, 1, "the bar is rebroadcast once");
    });

    test("an empty or whitespace-only name clears back to the default", () => {
        const { registry } = setup();
        const session = start(registry);
        registry.rename(session.id, "temporary");

        registry.rename(session.id, "   ");

        assert.equal(entryFor(registry, session.id).name, null, "a blank name means no name, not a blank one");
    });

    test("names are cut to the cap and stripped of control characters", () => {
        const { registry } = setup();
        const session = start(registry);

        registry.rename(session.id, `${"x".repeat(MAX_NAME_LENGTH + 20)}`);
        assert.equal(entryFor(registry, session.id).name?.length, MAX_NAME_LENGTH, "a runaway name is cut to the cap");

        registry.rename(session.id, "line one\nline\ttwo");
        assert.equal(entryFor(registry, session.id).name, "line onelinetwo", "newlines and tabs are dropped, so a name is one clean line");
    });

    test("renaming a session that is gone says so and does not throw", () => {
        const { registry } = setup();
        assert.equal(registry.rename("no-such-sid", "whatever"), false);
    });

    test("renaming touches nothing but the label", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, window);

        registry.rename(session.id, "still mine");

        assert.equal(registry.attachedSid(window), session.id, "the driver is unchanged");
        assert.equal(session.term.killed, false, "the agent is untouched");
    });

    // cleanName is the single source of truth for what a name may be; the frame handler and the client both
    // lean on it, so a couple of direct checks pin the edges.
    test("cleanName rejects non-strings and yields null for nothing usable", () => {
        assert.equal(cleanName(undefined), null);
        assert.equal(cleanName(42), null);
        assert.equal(cleanName(""), null);
        assert.equal(cleanName("  hi  "), "hi", "surrounding whitespace is trimmed");
    });
});

// ---- Reordering the bar -----------------------------------------------------------------------------------------------------------------
// The order of the tabs is registry state, because every window draws the same bar. A drag has to move the
// session here, or the next broadcast would put it straight back. `index` is the position it ends up at.

describe("reordering the bar", () => {
    function bar(registry: Registry) {
        return registry.list().map((entry) => entry.label);
    }

    test("moves a session to the given position and tells every window", () => {
        const { events, registry } = setup();
        const first = start(registry);
        start(registry);
        start(registry);
        events.length = 0;

        assert.equal(registry.reorder(first.id, 2), true);

        assert.deepEqual(bar(registry), ["Agent 2", "Agent 3", "Agent 1"]);
        assert.equal(events.filter((e) => e.t === "changed").length, 1, "the bar is rebroadcast once");
    });

    test("moves one to the front too", () => {
        const { registry } = setup();
        start(registry);
        start(registry);
        const third = start(registry);

        registry.reorder(third.id, 0);

        assert.deepEqual(bar(registry), ["Agent 3", "Agent 1", "Agent 2"]);
    });

    test("an index past the ends clamps rather than being refused", () => {
        const { registry } = setup();
        const first = start(registry);
        start(registry);
        const third = start(registry);

        registry.reorder(first.id, 99);
        assert.deepEqual(bar(registry), ["Agent 2", "Agent 3", "Agent 1"], "past the right edge lands last");

        registry.reorder(third.id, -5);
        assert.deepEqual(bar(registry), ["Agent 3", "Agent 2", "Agent 1"], "past the left edge lands first");
    });

    test("a move that changes nothing is not broadcast", () => {
        const { events, registry } = setup();
        const first = start(registry);
        start(registry);
        events.length = 0;

        assert.equal(registry.reorder(first.id, 0), false);
        assert.equal(registry.reorder("no-such-sid", 1), false);
        assert.equal(events.length, 0, "neither is a change, so no window is woken for it");
    });

    test("position is not identity: labels, colours, names and drivers all come along", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const first = start(registry);
        const second = start(registry);
        registry.rename(first.id, "refactor auth");
        registry.attach(first.id, window);
        first.term.say("some output");

        registry.reorder(first.id, 1);

        const moved = entryFor(registry, first.id);
        assert.equal(moved.label, "Agent 1", "the number is the session's, not the tab position's");
        assert.equal(moved.name, "refactor auth");
        assert.equal(moved.colorIndex, 0, "and so is the colour");
        assert.equal(moved.attached, true, "the window is still driving it");
        assert.equal(registry.attachedSid(window), first.id);
        assert.equal(registry.get(first.id)?.buffer, "some output", "the screen it can replay is untouched");
        assert.equal(second.term.killed, false);
    });

    test("closing lands you on the neighbour the bar now shows, not the one it used to", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const first = start(registry);
        const second = start(registry);
        const third = start(registry);
        // Drag the third tab to the front, so "Agent 2" is now the last tab in the bar.
        registry.reorder(third.id, 0);
        registry.attach(second.id, window);

        registry.close(second.id);

        assert.equal(registry.attachedSid(window), first.id, "the tab to its left in the reordered bar");
    });
});

// ---- One driver per session --------------------------------------------------------------------------------------------------------------
// A PTY has a single size, so two windows on one session would fight over resize. Hence: one driver, and
// a deliberate takeover. But a window must never have to take a session over from itself.

describe("who may drive a session", () => {
    test("a different window that is really watching has to be asked about", () => {
        const { registry } = setup();
        const first = new FakeSocket();
        const second = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, first);

        assert.equal(registry.attach(session.id, second), "busy");
        assert.equal(registry.sessionFor(first)?.id, session.id, "the refused attach changed nothing");
    });

    test("a window whose socket died is not asked about - that is the sleep case", () => {
        const { registry } = setup();
        const asleep = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, asleep);
        asleep.die();

        assert.equal(registry.attach(session.id, new FakeSocket()), "attached");
    });

    test("a duplicated tab cannot silently take a live session", () => {
        const { registry } = setup();
        const original = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, original);
        // Browsers copy sessionStorage into a duplicated tab, so any id the page holds is shared by the
        // duplicate. Only the live socket decides, which makes the duplicate ask like anyone else - two
        // windows on one PTY would otherwise fight over its size with no prompt shown.
        const duplicate = new FakeSocket();
        assert.equal(registry.attach(session.id, duplicate), "busy");
        assert.equal(registry.attachedSid(original), session.id);
        // Asking deliberately still works, and displaces the original.
        assert.equal(registry.takeover(session.id, duplicate), "attached");
        assert.equal(registry.attachedSid(duplicate), session.id);
    });

    test("a reloaded window takes its session back once the old socket has closed", () => {
        const { registry } = setup();
        const before = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, before);
        // A reload closes the socket, so detach has already run by the time the new one says hello.
        before.die();
        registry.detach(before);

        const after = new FakeSocket();
        assert.equal(registry.attach(session.id, after), "attached");
        assert.equal(registry.attachedSid(after), session.id);
    });

    test("attaching to a session that is gone says so", () => {
        const { registry } = setup();
        assert.equal(registry.attach("nope", new FakeSocket()), "gone");
    });

    test("a window drives one session at a time", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const one = start(registry);
        const two = start(registry);
        registry.attach(one.id, window);

        registry.attach(two.id, window);

        assert.equal(registry.attachedSid(window), two.id);
        assert.equal(entryFor(registry, one.id).attached, false, "the session it left has no driver");
        assert.equal(registry.attachedCount(), 1);
    });

    test("takeover moves the session and tells the window that lost it", () => {
        const { events, registry } = setup();
        const first = new FakeSocket();
        const second = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, first);

        assert.equal(registry.takeover(session.id, second), "attached");

        assert.equal(registry.attachedSid(second), session.id);
        assert.equal(registry.attachedSid(first), null);
        const taken = events.find((e) => e.t === "taken");
        assert.equal(taken?.client, first, "the displaced window is told, so it can take it back");
        assert.equal(taken?.sid, session.id);
    });

    test("taking over a session nobody is watching tells nobody", () => {
        const { events, registry } = setup();
        const session = start(registry);

        registry.takeover(session.id, new FakeSocket());

        assert.equal(events.filter((e) => e.t === "taken").length, 0);
    });

    test("a dead socket counts as nobody watching", () => {
        const { registry } = setup();
        const asleep = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, asleep);
        asleep.die();

        assert.equal(registry.attachedCount(), 0);
        assert.equal(entryFor(registry, session.id).attached, false);
    });
});

// ---- Where a fresh window lands ---------------------------------------------------------------------------------------------------------

describe("pickForClient", () => {
    test("prefers the session this window was last looking at", () => {
        const { registry } = setup();
        start(registry);
        const wanted = start(registry);

        assert.equal(registry.pickForClient(new FakeSocket(), wanted.id), wanted.id);
    });

    test("falls back to the oldest session nobody is watching", () => {
        const { registry } = setup();
        const oldest = start(registry);
        start(registry);

        assert.equal(registry.pickForClient(new FakeSocket(), "long-gone-sid"), oldest.id);
    });

    test("skips the ones another window is driving", () => {
        const { registry } = setup();
        const driven = start(registry);
        const free = start(registry);
        registry.attach(driven.id, new FakeSocket());

        assert.equal(registry.pickForClient(new FakeSocket(), driven.id), free.id);
    });

    test("nothing when every session is driven elsewhere, so the user picks from the bar", () => {
        const { registry } = setup();
        const session = start(registry);
        registry.attach(session.id, new FakeSocket());

        assert.equal(registry.pickForClient(new FakeSocket()), null);
    });
});

// ---- Unread ------------------------------------------------------------------------------------------------------------------------------

describe("the unread mark", () => {
    test("is set by output nobody is watching, and announced once", () => {
        const { events, registry } = setup();
        const session = start(registry);
        events.length = 0;

        session.term.say("done!");
        session.term.say("anything else?");

        assert.equal(entryFor(registry, session.id).unread, true);
        assert.equal(
            events.filter((e) => e.t === "changed").length,
            1,
            "a chatty background agent must not turn into a broadcast per chunk",
        );
        assert.equal(events.filter((e) => e.t === "out").length, 0, "and no output is sent to nobody");
    });

    test("clears when a window looks at the session", () => {
        const { registry } = setup();
        const session = start(registry);
        session.term.say("done!");

        registry.attach(session.id, new FakeSocket());

        assert.equal(entryFor(registry, session.id).unread, false);
    });

    test("output goes to the window that is watching, and is not marked unread", () => {
        const { events, registry } = setup();
        const window = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, window);
        events.length = 0;

        session.term.say("thinking...");

        const out = events.find((e) => e.t === "out");
        assert.equal(out?.client, window);
        assert.equal(out?.data, "thinking...");
        assert.equal(entryFor(registry, session.id).unread, false);
    });
});

// ---- Is the agent working, and did it just stop? ----------------------------------------------------------------------------------------
// A PTY carries bytes, not "thinking" and "waiting", so the state is read off the rhythm of the output: a
// stretch of it means working, going quiet means it stopped. What makes these tests worth reading is the
// output that is not work - an idle TUI's odd redraw, and the echo of the user's own typing - because reading
// either as work is what makes a tab flicker at somebody who is just sitting there. The clock is mocked
// because the whole feature is about time, and the registry keeps no timers of its own: the server calls
// tick() several times a second, so the helpers below do too.

describe("the working state", () => {
    beforeEach(() => {
        mock.timers.enable({ apis: ["Date"] });
        // The mocked clock starts at zero, which is also what a fresh session's timestamps hold. Move it on so
        // "never happened" reads as long ago here, the way it does on any real clock.
        mock.timers.tick(WORK_QUIET_MS);
    });
    afterEach(() => mock.timers.reset());

    // An agent producing output for `worked`, the way one really does: small chunks, close together, with the
    // server sweeping between them.
    function streams(registry: Registry, session: Session, worked: number) {
        session.term.say("thinking...");
        for (let elapsed = 0; elapsed < worked; elapsed += WORK_TICK_MS) {
            mock.timers.tick(WORK_TICK_MS);
            session.term.say("...");
            registry.tick();
        }
    }

    // And then it stops, which is only visible once the quiet has lasted long enough to mean something.
    function goesQuiet(registry: Registry) {
        mock.timers.tick(WORK_QUIET_MS);
        registry.tick();
    }

    test("sustained output puts a session to work, and the bar hears it once", () => {
        const { events, registry } = setup();
        const session = start(registry);
        // Watched, so the only state left to change is the working one: an unwatched session would also flip
        // to unread, and this test is about how often work is announced.
        registry.attach(session.id, new FakeSocket());
        events.length = 0;

        streams(registry, session, WORK_WARMUP_MS);

        assert.equal(entryFor(registry, session.id).working, true);
        assert.equal(events.filter((e) => e.t === "changed").length, 1, "a working agent must not broadcast per chunk");
    });

    test("a lone blip of output is not work", () => {
        const { events, registry } = setup();
        const session = start(registry);
        events.length = 0;

        // What an idle agent looks like: one small redraw, measured minutes into a session nobody is using,
        // and then nothing. Sweeping past it must never show the tab as busy.
        session.term.say("\x1b[2K\x1b[36m>\x1b[0m ");
        for (let elapsed = 0; elapsed < WORK_QUIET_MS * 2; elapsed += WORK_TICK_MS) {
            mock.timers.tick(WORK_TICK_MS);
            registry.tick();
            assert.equal(entryFor(registry, session.id).working, false, "one redraw is not an agent at work");
        }
        // The one frame is the unread flip - there is output nobody has seen. The sweeps themselves have
        // nothing to say, and a sweep that runs several times a second had better stay that way.
        assert.equal(events.filter((e) => e.t === "changed").length, 1);
    });

    test("the echo of the user's own typing is not work", () => {
        const { registry } = setup();
        const session = start(registry);

        // Typing steadily for long enough that the echo alone would look like a working agent. Each keystroke
        // comes straight back, and a TUI redraws its whole input box for every one of them.
        for (let elapsed = 0; elapsed < WORK_WARMUP_MS * 3; elapsed += WORK_TICK_MS) {
            registry.typed(session.id);
            session.term.say("\x1b[2K> hello there");
            mock.timers.tick(WORK_TICK_MS);
            registry.tick();
            assert.equal(entryFor(registry, session.id).working, false, "the tab you are typing into is not busy");
        }
    });

    test("output that arrives after the typing stopped is the agent", () => {
        const { registry } = setup();
        const session = start(registry);

        registry.typed(session.id);
        session.term.say("> go\r\n");
        mock.timers.tick(ECHO_MS);
        streams(registry, session, WORK_WARMUP_MS);

        assert.equal(entryFor(registry, session.id).working, true, "sending a message is what starts real work");
    });

    test("silence ends it", () => {
        const { registry } = setup();
        const session = start(registry);
        streams(registry, session, WORK_WARMUP_MS);

        mock.timers.tick(WORK_QUIET_MS - 1);
        registry.tick();
        assert.equal(entryFor(registry, session.id).working, true, "a gap between chunks is not the end of the work");

        mock.timers.tick(1);
        registry.tick();
        assert.equal(entryFor(registry, session.id).working, false);
    });

    test("a stretch of work that ends with nobody watching asks for attention", () => {
        const { registry } = setup();
        const session = start(registry);

        streams(registry, session, MIN_WORK_MS);
        goesQuiet(registry);

        const entry = entryFor(registry, session.id);
        assert.equal(entry.working, false);
        assert.equal(entry.attention, true, "this is the moment the whole feature exists for");
    });

    test("a short piece of work does not", () => {
        const { registry } = setup();
        const study = start(registry);

        // Long enough to show as busy, too short to be a job finishing: a one-line answer, a redraw on resize.
        streams(registry, study, WORK_WARMUP_MS);
        goesQuiet(registry);

        assert.equal(entryFor(registry, study.id).attention, false, "lighting up for these teaches the user to ignore the light");
    });

    test("a session a window is already watching never asks", () => {
        const { registry } = setup();
        const session = start(registry);
        registry.attach(session.id, new FakeSocket());

        streams(registry, session, MIN_WORK_MS);
        goesQuiet(registry);

        assert.equal(entryFor(registry, session.id).attention, false, "you are looking straight at it");
    });

    test("a window that is not in front of the user is not watching", () => {
        const { registry } = setup();
        const session = start(registry);
        const window = new FakeSocket();
        registry.attach(session.id, window);
        // Behind another browser tab, or another app. The socket is open and this window still drives the
        // session, which is why an open socket cannot be what decides: the alert is the only thing that would
        // ever reach a user who is looking somewhere else.
        registry.away(window, true);

        streams(registry, session, MIN_WORK_MS);
        goesQuiet(registry);

        assert.equal(entryFor(registry, session.id).attention, true);
        assert.equal(registry.attachedSid(window), session.id, "being away does not hand the session back");
    });

    test("coming back to the window spends the alert on what it is driving", () => {
        const { events, registry } = setup();
        const session = start(registry);
        const other = start(registry);
        const window = new FakeSocket();
        registry.attach(session.id, window);
        registry.away(window, true);
        streams(registry, session, MIN_WORK_MS);
        goesQuiet(registry);
        streams(registry, other, MIN_WORK_MS);
        goesQuiet(registry);
        events.length = 0;

        registry.away(window, false);

        assert.equal(entryFor(registry, session.id).attention, false, "it is on screen now, which is what the alert asked for");
        assert.equal(entryFor(registry, other.id).attention, true, "the sessions this window is not on still wait");
        assert.equal(events.filter((e) => e.t === "changed").length, 1);
    });

    test("coming back with nothing to spend says nothing", () => {
        const { events, registry } = setup();
        const session = start(registry);
        const window = new FakeSocket();
        registry.attach(session.id, window);
        events.length = 0;

        // Every focus and blur reports, so this runs whenever the user clicks between apps.
        registry.away(window, false);
        registry.away(window, true);
        registry.away(window, false);

        assert.equal(events.length, 0);
    });

    test("a client that never reports is treated as watching", () => {
        const { registry } = setup();
        const session = start(registry);
        registry.attach(session.id, new FakeSocket());

        streams(registry, session, MIN_WORK_MS);
        goesQuiet(registry);

        // The old behaviour, kept for anything on the socket that is not this page.
        assert.equal(entryFor(registry, session.id).attention, false);
    });

    test("visiting the session spends the alert", () => {
        const { registry } = setup();
        const session = start(registry);
        streams(registry, session, MIN_WORK_MS);
        goesQuiet(registry);

        registry.attach(session.id, new FakeSocket());

        assert.equal(entryFor(registry, session.id).attention, false);
    });

    test("an agent that starts again drops the alert it had raised", () => {
        const { registry } = setup();
        const session = start(registry);
        streams(registry, session, MIN_WORK_MS);
        goesQuiet(registry);

        streams(registry, session, WORK_WARMUP_MS);

        const entry = entryFor(registry, session.id);
        assert.equal(entry.working, true);
        assert.equal(entry.attention, false, "an alert that says 'it stopped' must not sit on a session that is going");
    });

    test("a tick that changes nothing says nothing", () => {
        const { events, registry } = setup();
        const session = start(registry);
        streams(registry, session, MIN_WORK_MS);
        goesQuiet(registry);
        events.length = 0;

        registry.tick();
        registry.tick();

        assert.equal(events.length, 0, "this runs several times a second, so a quiet sweep has to stay silent");
    });
});

// ---- Cross-file literal sync -------------------------------------------------------------------------------------------------------------

describe("the palette the browser draws matches the indexes the registry hands out", () => {
    const app = readFileSync(join(WEBTERM_DIR, "public", "app.js"), "utf8");

    test("app.js defines one colour more than PALETTE_SIZE", () => {
        const match = /const PALETTE = \[([^\]]*)\]/.exec(app);
        assert.ok(match, "app.js must define PALETTE");
        const colors = (match?.[1] ?? "").match(/"#[0-9a-f]{3,8}"/gi) ?? [];
        // The workspace takes one slot from the palette and sessions rotate through the rest, so the list has
        // to be one longer than the counter the registry rotates: colorIndex is (seq - 1) % PALETTE_SIZE, and
        // a shorter list would leave sessions doubling up on a colour that is still free.
        assert.equal(colors.length, PALETTE_SIZE + 1, "PALETTE drifted from PALETTE_SIZE in sessions.js");
        assert.equal(new Set(colors).size, colors.length, "two slots of the same colour would make two sessions look alike");
    });

    test("a session can never be handed the workspace's own colour", () => {
        // The rule is a property of the list the tabs index into, not a check somewhere that could be skipped.
        assert.match(app, /const SESSION_COLORS = PALETTE\.filter\(\(_, slot\) => slot !== WORKSPACE_SLOT\)/);
    });
});

// ---- The browser's own tab ---------------------------------------------------------------------------------------------------------------

// The bar is invisible when the window is behind something else, which is exactly when an agent finishing
// matters most. Title and favicon are the only two things a hidden window can say, so both have to be driven
// by the same session state the tabs are. Checked as text: painting the icon needs a DOM and a canvas.
describe("the browser tab repeats what the bar says", () => {
    const app = readFileSync(join(WEBTERM_DIR, "public", "app.js"), "utf8");

    test("the title counts the sessions that are waiting", () => {
        const body = /function refreshBrowserTab\(\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? "";
        assert.ok(body, "app.js must define refreshBrowserTab");
        assert.match(body, /sessions\.filter\(\(entry\) => entry\.attention\)/, "the same flag the tabs light up from");
        assert.match(body, /document\.title = waiting\.length > 0/);
        // The workspace name and nothing else: a tab strip gives you a few characters, and the icon is what
        // says this is totopo.
        assert.match(body, /const name = workspaceName \|\| "totopo"/);
    });

    test("the icon is repainted from that state, dot and all", () => {
        assert.match(app, /faviconLink\.href = iconCanvas\.toDataURL\("image\/png"\)/);
        // A drawing call this browser lacks must not take the frame handler down with it.
        assert.match(app, /try \{\s*drawIcon\(ctx, badgeColor, badgeColor === DONE_COLOR && pulseDim\);\s*\} catch \{/);
        const body = /function drawIcon\(ctx, badgeColor, dim\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? "";
        assert.ok(body, "app.js must define drawIcon");
        assert.match(body, /if \(badgeColor\) \{/, "one mark, drawn when there is something to say");
    });

    test("working and waiting are different shapes in different places", () => {
        // Colour alone was not enough: a blue dot and a green dot in the same corner are nearly the same dot at
        // 16px, which is the only size that matters here. Working is a bar down the right edge, waiting is a dot
        // in the corner - so the two can be told apart without reading the hue at all.
        const body = /function drawIcon\(ctx, badgeColor, dim\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? "";
        assert.match(body, /if \(badgeColor === BUSY_COLOR\) \{[\s\S]*?ctx\.roundRect\(25, 9\.5, 4, 14, 2\)/);
        assert.match(body, /ctx\.arc\(24, 8, dim \? \d[\d.]* : \d[\d.]*, 0, Math\.PI \* 2\)/, "and the dot is the waiting one");
        // One at a time: waiting outranks working, which is what lets both use the same corner of the icon.
        assert.match(body, /return;\n {4}\}/);
    });

    test("the dot says which of the three states this window is in", () => {
        // From another browser tab, "they are on it" and "one of them wants you" are different things to know,
        // and a 16px icon has room for one mark - so it is one dot in two colours, waiting outranking working.
        const body = /function dotColor\(\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? "";
        assert.ok(body, "app.js must define dotColor");
        assert.match(
            body,
            /entry\.attention\)\) return DONE_COLOR;\s*\n\s*if \(sessions\.some\(\(entry\) => entry\.working\)\) return BUSY_COLOR/,
        );
        // Fixed colours, not the session palette: green only reads at a glance if it means the same everywhere.
        assert.match(app, /const DONE_COLOR = "#[0-9a-f]{6}";\nconst BUSY_COLOR = "#[0-9a-f]{6}";/);
    });

    test("the waiting dot keeps pulsing until the session is visited", () => {
        const body = /function pulseBadge\(\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? "";
        assert.ok(body, "app.js must define pulseBadge");
        // The pulse reads the state itself, so visiting the session stops it wherever the visit happened.
        assert.match(body, /if \(!sessions\.some\(\(entry\) => entry\.attention\)\) \{/);
        assert.match(body, /pulseTimer = setTimeout\(pulseBadge, PULSE_MS\)/, "and otherwise keeps going");
        // Started only when it is not already running: an alert arriving next to one already up is the same
        // state, and restarting the cycle on every frame the server sends would make the dot stutter.
        assert.match(app, /if \(!pulseTimer\) pulseTimer = setTimeout\(pulseBadge, PULSE_MS\)/);
    });

    test("the pulse never leaves the icon with no mark on it", () => {
        // A browser slows a hidden tab's timers to a second and then to one a minute - and a hidden tab is the
        // whole point of the icon. Pulsing between two visible dots means a stalled pulse still says green;
        // pulsing between a dot and nothing could sit on "nothing" with an alert up.
        const body = /function drawIcon\(ctx, badgeColor, dim\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? "";
        assert.match(body, /ctx\.globalAlpha = dim \? 0\.\d+ : 1;/);
        assert.match(body, /ctx\.arc\(24, 8, dim \? \d[\d.]* : \d[\d.]*, 0, Math\.PI \* 2\)/);
    });

    test("the page tells the server when it is not in front of the user", () => {
        // Without this an open socket looks like a pair of eyes, and the alert - the whole reason the icon and the
        // title exist - could never fire for the window it was built for.
        assert.match(app, /t: "away", on: document\.visibilityState === "hidden" \|\| !document\.hasFocus\(\)/);
        // Both events, and again on every reconnect: a new socket knows nothing about this window yet.
        assert.match(app, /window\.addEventListener\("focus", reportPresence\)/);
        assert.match(app, /window\.addEventListener\("blur", reportPresence\)/);
        const open = /ws\.onopen = \(\) => \{([\s\S]*?)\n {4}\};/.exec(app)?.[1] ?? "";
        assert.ok(open, "app.js must open the socket");
        assert.match(open, /reportPresence\(\)/);
    });

    test("the dot follows the state it was painted from", () => {
        // Every paint asks dotColor() again, so work starting or stopping mid-pulse cannot leave the icon holding
        // a state that has moved on. Arrival times are stamped from the incoming frame rather than while the bar
        // is drawn, because a bar render is skipped mid-drag.
        assert.match(app, /const badgeColor = dotColor\(\);/);
        assert.match(app, /noteArrivals\(\);\n {4}renderBar\(\)/, "stamped before anything draws");
    });
});

// ---- A screen with nothing behind it ----------------------------------------------------------------------------------------------------

// A session can end while a window is watching it. Where the server has a free session to move that window to,
// its replay paints over the dead screen; where every session that is left is driven from another window, nothing
// does - and a dead screen looks exactly like a live one, so the page has to say it. Checked as text: the page
// needs a DOM and a terminal.
describe("a session that goes away takes its screen with it", () => {
    const app = readFileSync(join(WEBTERM_DIR, "public", "app.js"), "utf8");
    const body = /function applySessions\(msg\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? "";

    test("the terminal is replaced when the session it was showing is not in the bar any more", () => {
        assert.ok(body, "app.js must define applySessions");
        assert.match(body, /const gone = shownSid !== null && !sessions\.some\(\(entry\) => entry\.id === shownSid\)/);
        // Also when this window never had one: a window that connects while every session is driven elsewhere
        // lands on nothing, and an empty terminal explains nothing.
        assert.match(body, /if \(gone \|\| shownSid === null\) showMessage\(idleMessage\(\)\)/);
    });

    test("the message says what to do about it", () => {
        const message = /function idleMessage\(\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? "";
        assert.ok(message, "app.js must define idleMessage");
        assert.match(message, /sessions\.length === 0/, "starting one and taking one over are different ways out");
        assert.match(app, /function showMessage\(line\) \{\n {4}if \(line === shownMessage\) return;/, "repainted only when it changes");
    });

    test("the last screen of an agent that exited on its own is left alone", () => {
        // It usually says why it quit, and the note written under it is what makes it readable as history.
        assert.match(app, /shownMessage = EXITED_SCREEN;/);
        assert.match(body, /shownMessage !== EXITED_SCREEN/);
    });

    test("a session this window could still take back keeps its screen", () => {
        // The takeover card offers it back, so the screen behind the card is the session it is talking about.
        // That is why the check is "gone from the bar" rather than "not attached here".
        const taken = /msg\.t === "taken"([\s\S]*?)else if/.exec(app)?.[1] ?? "";
        assert.ok(taken, "app.js must handle the taken frame");
        assert.doesNotMatch(taken, /shownSid = null/);
    });
});

// ---- Clipboard gate ----------------------------------------------------------------------------------------------------------------------

// A session's replay buffer is its raw output, so it still holds the OSC 52 of any copy made in that
// session earlier. Writing it into the terminal re-runs that sequence, which put stale text on the
// clipboard on every attach and made each session tab look like it had a clipboard of its own. The page
// needs a DOM, so the wiring is checked as text; the parse ordering it relies on is xterm's own.
describe("replayed output cannot write the clipboard", () => {
    const app = readFileSync(join(WEBTERM_DIR, "public", "app.js"), "utf8");

    test("the replay frame goes through writeReplay", () => {
        const branch = /msg\.t === "replay"([\s\S]*?)else if/.exec(app)?.[1] ?? "";
        assert.ok(branch, "app.js must handle the replay frame");
        assert.match(branch, /writeReplay\(msg\.data\)/);
        assert.doesNotMatch(branch, /term\.write\(/, "a replay written straight to the terminal re-runs its OSC 52");
    });

    test("writeReplay holds the gate until the replay has been parsed", () => {
        const body = /function writeReplay\(data\) \{([\s\S]*?)\n\}/.exec(app)?.[1] ?? "";
        assert.ok(body, "app.js must define writeReplay");
        assert.match(body, /pendingReplays\+\+/);
        // Released in term.write's callback, which xterm runs once that chunk is parsed and before it
        // parses anything written after it - so live output during a replay still copies.
        assert.match(body, /term\.write\(data, \(\) => \{\s*pendingReplays--;/);
    });

    test("the OSC 52 handler ignores a replay, and any window that is not in front", () => {
        const handler = /registerOscHandler\(52,([\s\S]*?)\n\}\);/.exec(app)?.[1] ?? "";
        assert.ok(handler, "app.js must handle OSC 52");
        assert.match(handler, /if \(pendingReplays > 0\) return true;/);
        assert.match(handler, /document\.hasFocus\(\)/);
    });
});
